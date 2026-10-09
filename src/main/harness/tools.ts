import { spawn } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { browserId, browserMcpEndpoint, SERVER_NAME as BROWSER_SERVER } from '../browser-mcp'
import { exaKey } from '../exa-key'
import { loadShellPath } from '../shell-env'
import type { Part, ToolSpec } from './types'

/**
 * The model's tools: pi's four (read, bash, edit, write), opencode's web
 * search, and the built-in browser's, reached through its MCP server. The
 * user's own MCP servers add theirs (see mcp.ts).
 */

export interface ToolContext {
  cwd: string
  chatId: string
  signal: AbortSignal
}

export interface ToolOutput {
  /** What the model gets back. */
  content: Part[]
  isError?: boolean
  /** What the chat shows, when it differs from the text sent to the model (an edit's diff). */
  display?: string
}

export interface Tool {
  spec: ToolSpec
  /** The ACP tool kind the chat shows the call as. */
  kind: 'read' | 'edit' | 'execute' | 'fetch' | 'other'
  /** Runs without asking, even in Ask mode. */
  readOnly: boolean
  /** The title the chat shows; browser tools carry the prefix the chat recognises them by. */
  title: string
  /** Files the call touches, for project-only mode. */
  paths(args: Record<string, unknown>, cwd: string): string[]
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput>
}

/** Output sent to the model is cut to its last (bash) or first (read) lines, as pi does. */
const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
/** Larger images are refused: the APIs reject images over 5 MB. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const text = (value: string): Part[] => [{ type: 'text', text: value }]

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string') throw new Error(`"${name}" must be a string.`)
  return value
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`"${name}" must be a positive number.`)
  }
  return value
}

function resolvePath(args: Record<string, unknown>, cwd: string): string {
  const path = stringArg(args, 'path')
  return isAbsolute(path) ? path : resolve(cwd, path)
}

const pathOf = (args: Record<string, unknown>, cwd: string): string[] =>
  typeof args.path === 'string' ? [resolvePath(args, cwd)] : []

const read: Tool = {
  spec: {
    name: 'read',
    description: `Read a file. Text is returned from the first line, at most ${MAX_LINES} lines or ${MAX_BYTES / 1024} KB; use offset and limit for the rest of a longer file. Images (png, jpg, gif, webp) are returned as images.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the project or absolute' },
        offset: { type: 'number', description: 'Line to start at, from 1' },
        limit: { type: 'number', description: 'Most lines to return' }
      },
      required: ['path']
    }
  },
  kind: 'read',
  readOnly: true,
  title: 'read',
  paths: pathOf,
  async run(args, { cwd }) {
    const path = resolvePath(args, cwd)
    const mimeType = IMAGE_TYPES[extname(path).toLowerCase()]
    if (mimeType) {
      const { size } = await stat(path)
      if (size > MAX_IMAGE_BYTES) {
        throw new Error(
          `The image is ${Math.round(size / 1024 / 1024)} MB; images over 5 MB cannot be sent.`
        )
      }
      return {
        content: [{ type: 'image', mimeType, data: (await readFile(path)).toString('base64') }]
      }
    }
    const buffer = await readFile(path)
    if (buffer.subarray(0, 8000).includes(0)) throw new Error(`${path} is a binary file.`)
    const lines = buffer.toString('utf8').split('\n')
    const start = Math.max(1, Math.floor(numberArg(args, 'offset') ?? 1))
    if (start > lines.length)
      throw new Error(`The file has ${lines.length} lines; offset ${start} is past its end.`)
    const limit = Math.min(Math.floor(numberArg(args, 'limit') ?? MAX_LINES), MAX_LINES)
    const shown: string[] = []
    let bytes = 0
    for (const line of lines.slice(start - 1, start - 1 + limit)) {
      bytes += Buffer.byteLength(line) + 1
      if (bytes > MAX_BYTES && shown.length > 0) break
      shown.push(line)
    }
    const end = start + shown.length - 1
    const more =
      end < lines.length
        ? `\n\n[Lines ${start}-${end} of ${lines.length}. Continue with offset=${end + 1}.]`
        : ''
    return { content: text(shown.join('\n') + more) }
  }
}

const write: Tool = {
  spec: {
    name: 'write',
    description:
      'Write a file, replacing it if it exists and creating missing folders. Use for new files or complete rewrites; use edit to change part of a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the project or absolute' },
        content: { type: 'string', description: 'The whole new content of the file' }
      },
      required: ['path', 'content']
    }
  },
  kind: 'edit',
  readOnly: false,
  title: 'write',
  paths: pathOf,
  async run(args, { cwd }) {
    const path = resolvePath(args, cwd)
    const content = stringArg(args, 'content')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
    return {
      content: text(`Wrote ${Buffer.byteLength(content)} bytes to ${path}.`),
      display: [`--- ${path}`, ...content.split('\n').map((l) => `+ ${l}`)].join('\n')
    }
  }
}

const edit: Tool = {
  spec: {
    name: 'edit',
    description:
      'Edit a file by exact text replacement. Every edits[].oldText must match exactly one place in the file as it is now, including whitespace. All edits match against the original file, so they must not overlap; merge nearby changes into one edit. Keep oldText short but unique.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the project or absolute' },
        edits: {
          type: 'array',
          description: 'One or more replacements in this file',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: 'Exact text to replace, unique in the file' },
              newText: { type: 'string', description: 'The text to put in its place' }
            },
            required: ['oldText', 'newText']
          }
        }
      },
      required: ['path', 'edits']
    }
  },
  kind: 'edit',
  readOnly: false,
  title: 'edit',
  paths: pathOf,
  async run(args, { cwd }) {
    const path = resolvePath(args, cwd)
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      throw new Error('"edits" must list at least one replacement.')
    }
    const edits = args.edits.map((e: Record<string, unknown>, i) => {
      if (typeof e?.oldText !== 'string' || typeof e?.newText !== 'string') {
        throw new Error(`edits[${i}] needs "oldText" and "newText" strings.`)
      }
      return { oldText: toLF(e.oldText), newText: toLF(e.newText) }
    })
    const raw = await readFile(path, 'utf8')
    // The model never sees a byte order mark or CRLF; match without them, write them back.
    const bom = raw.startsWith('﻿') ? '﻿' : ''
    const crlf = raw.includes('\r\n')
    const original = toLF(raw.slice(bom.length))

    const matches = edits.map((e, i) => {
      if (!e.oldText) throw new Error(`edits[${i}].oldText is empty.`)
      const at = original.indexOf(e.oldText)
      if (at < 0) {
        throw new Error(
          `edits[${i}].oldText was not found in ${path}. Read the file again and copy the text exactly.`
        )
      }
      if (original.indexOf(e.oldText, at + 1) >= 0) {
        throw new Error(
          `edits[${i}].oldText matches more than once in ${path}. Include more surrounding text.`
        )
      }
      return { ...e, at, index: i }
    })
    matches.sort((a, b) => a.at - b.at)
    for (let i = 1; i < matches.length; i++) {
      if (matches[i - 1].at + matches[i - 1].oldText.length > matches[i].at) {
        throw new Error(
          `edits[${matches[i - 1].index}] and edits[${matches[i].index}] overlap. Merge them into one edit.`
        )
      }
    }
    let updated = original
    for (const m of [...matches].reverse()) {
      updated = updated.slice(0, m.at) + m.newText + updated.slice(m.at + m.oldText.length)
    }
    if (updated === original) throw new Error('The edits change nothing.')
    await writeFile(path, bom + (crlf ? updated.replaceAll('\n', '\r\n') : updated))
    const diff = matches.flatMap((m) => [
      ...m.oldText.split('\n').map((l) => `- ${l}`),
      ...m.newText.split('\n').map((l) => `+ ${l}`)
    ])
    return {
      content: text(`Replaced ${matches.length} block(s) in ${path}.`),
      display: [`--- ${path}`, ...diff].join('\n')
    }
  }
}

const toLF = (value: string): string => value.replaceAll('\r\n', '\n')

/** A command that ignores SIGTERM this long is killed. */
const KILL_GRACE_MS = 2000

const bash: Tool = {
  spec: {
    name: 'bash',
    description: `Run a bash command in the project folder. Returns stdout and stderr together, cut to the last ${MAX_LINES} lines or ${MAX_BYTES / 1024} KB; the full output is saved to a file when cut. Use it for ls, rg, find, git, builds and tests. Optional timeout in seconds.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run' },
        timeout: { type: 'number', description: 'Seconds after which the command is stopped' }
      },
      required: ['command']
    }
  },
  kind: 'execute',
  readOnly: false,
  title: 'bash',
  paths: () => [],
  async run(args, { cwd, signal }) {
    const command = stringArg(args, 'command')
    const timeout = numberArg(args, 'timeout')
    await loadShellPath()
    const child = spawn('/bin/bash', ['-c', command], {
      cwd,
      // Its own process group, so stopping it also stops what it started.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const output = new CommandOutput([child.stdout, child.stderr])

    let stoppedBy: string | undefined
    const stop = (reason: string): void => {
      if (stoppedBy || child.exitCode !== null || !child.pid) return
      stoppedBy = reason
      killGroup(child.pid, 'SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) killGroup(child.pid!, 'SIGKILL')
      }, KILL_GRACE_MS).unref()
    }
    const onAbort = (): void => stop('Stopped by the user.')
    signal.addEventListener('abort', onAbort)
    const timer =
      timeout !== undefined
        ? setTimeout(() => stop(`Timed out after ${timeout} seconds.`), timeout * 1000)
        : undefined

    // The command is done when bash exits. Its pipes close then too, unless a
    // process it started in the background (a dev server: `npm run dev &`)
    // still holds them; waiting for that would hold the turn until it ends.
    const code = await new Promise<number | null>((done, fail) => {
      child.once('error', fail)
      child.once('close', (exitCode) => done(exitCode))
      child.once('exit', (exitCode) => {
        // Output bash wrote before exiting is already in the pipes; it is read
        // within the next turn of the event loop, so wait two before finishing.
        setImmediate(() => setImmediate(() => done(exitCode)))
      })
    }).finally(() => {
      signal.removeEventListener('abort', onAbort)
      clearTimeout(timer)
    })
    if (child.pid && groupAlive(child.pid)) keepForQuit(child.pid)

    const { text: all, file } = await output.finish()
    let shown = tail(all)
    if (file || shown !== all) {
      const path = file ?? join(tmpdir(), `just-harness-${crypto.randomUUID().slice(0, 8)}.log`)
      if (!file) await writeFile(path, all)
      shown += `\n\n[Output cut to its end. Full output: ${path}]`
    }
    const status = stoppedBy ?? (code !== 0 ? `Exit code ${code ?? 'unknown'}.` : '')
    const result = [shown.trimEnd(), status].filter(Boolean).join('\n\n') || '(no output)'
    return { content: text(result), isError: Boolean(stoppedBy) || code !== 0 }
  }
}

/** Output kept in memory before the rest goes to a file. */
const OUTPUT_IN_MEMORY = 8 * 1024 * 1024
/** Of output written to a file, the end kept in memory: enough for what tail() shows. */
const OUTPUT_TAIL = 2 * MAX_BYTES

/**
 * A command's stdout and stderr, together. Past OUTPUT_IN_MEMORY it is
 * written to a log file and only its end stays in memory, so a command that
 * prints without end cannot fill the app's memory. Once the command is done,
 * later output (from processes it left running) is read and dropped: a pipe
 * nobody reads would block them.
 */
class CommandOutput {
  private chunks: Buffer[] = []
  private size = 0
  /** Set once the output went past OUTPUT_IN_MEMORY. */
  private log?: { path: string; stream: WriteStream; dropped: boolean }
  private done = false
  private paused = false

  constructor(private readonly sources: Readable[]) {
    for (const source of sources) source.on('data', (data: Buffer) => this.add(data))
  }

  private add(data: Buffer): void {
    if (this.done) return
    this.chunks.push(data)
    this.size += data.length
    if (!this.log && this.size > OUTPUT_IN_MEMORY) {
      const path = join(tmpdir(), `just-harness-${crypto.randomUUID().slice(0, 8)}.log`)
      this.log = { path, stream: createWriteStream(path), dropped: false }
      // A failed write (a full disk) only costs the file; the end is still shown.
      this.log.stream.on('error', (error) => console.error('[harness] command log:', error))
      for (const chunk of this.chunks) this.write(chunk)
    } else if (this.log) {
      this.write(data)
    }
    // With a log, keep only the end in memory.
    while (this.log && this.chunks.length > 1 && this.size - this.chunks[0].length >= OUTPUT_TAIL) {
      this.size -= this.chunks.shift()!.length
      this.log.dropped = true
    }
  }

  /** Write to the log, pausing the command's pipes while the disk catches up. */
  private write(chunk: Buffer): void {
    if (this.log!.stream.write(chunk) || this.paused) return
    this.paused = true
    for (const source of this.sources) source.pause()
    this.log!.stream.once('drain', () => this.resume())
  }

  private resume(): void {
    this.paused = false
    for (const source of this.sources) source.resume()
  }

  /** Stop collecting; returns the output, or its end and the log file holding all of it. */
  async finish(): Promise<{ text: string; file?: string }> {
    this.done = true
    if (this.paused) this.resume()
    let text = Buffer.concat(this.chunks).toString('utf8')
    if (!this.log) return { text }
    // The first kept line may start mid-line (or mid-character); drop it.
    if (this.log.dropped) text = text.slice(text.indexOf('\n') + 1)
    const { stream, path } = this.log
    await new Promise<void>((resolve) => stream.end(resolve))
    return { text, file: path }
  }
}

/** Process groups of commands that left processes running, stopped when the app quits. */
const leftRunning = new Set<number>()
let pruneTimer: NodeJS.Timeout | undefined

/** Whether any process of a command's process group still runs. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    // ESRCH: none left. EPERM: the number now belongs to another user's group.
    return false
  }
}

/**
 * Remember a group to stop at quit. Groups that end are forgotten within 30
 * seconds, so a later, unrelated group that reuses the number is not signalled.
 */
function keepForQuit(pid: number): void {
  leftRunning.add(pid)
  pruneTimer ??= setInterval(() => {
    for (const group of leftRunning) if (!groupAlive(group)) leftRunning.delete(group)
    if (leftRunning.size === 0) {
      clearInterval(pruneTimer)
      pruneTimer = undefined
    }
  }, 30_000).unref()
}

/** Stop what commands left running (servers started with &); called when the app quits. */
export function stopLeftRunning(): void {
  for (const group of leftRunning) killGroup(group, 'SIGTERM')
  leftRunning.clear()
}

/** Signal a command's process group; it may have exited already. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // Already gone.
  }
}

/** The last MAX_LINES lines, within MAX_BYTES. */
function tail(output: string): string {
  let lines = output.split('\n')
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES)
  let result = lines.join('\n')
  while (Buffer.byteLength(result) > MAX_BYTES && lines.length > 1) {
    lines = lines.slice(Math.ceil(lines.length / 10))
    result = lines.join('\n')
  }
  return result
}

export const CORE_TOOLS: Tool[] = [read, bash, edit, write]

// --- Web search ------------------------------------------------------------

/** Exa's hosted MCP server, which opencode's websearch tool calls. It answers without a key too. */
const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
/** A search that takes longer is stopped, as in opencode. */
const SEARCH_TIMEOUT_MS = 25_000
/** About 7 KB of page text each, so the default stays well under MAX_BYTES. */
const DEFAULT_RESULTS = 5

/** A JSON-RPC answer from an MCP server: a tool result or an error. */
interface McpMessage {
  result?: { content?: { type: string; text?: string }[]; isError?: boolean }
  error?: { message?: string }
}

/** The answer in an MCP server's reply, sent as plain JSON or as server-sent events. */
function mcpMessage(body: string): McpMessage | undefined {
  const trimmed = body.trim()
  const payloads = trimmed.startsWith('{')
    ? [trimmed]
    : body
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
  for (const payload of payloads) {
    try {
      const message = JSON.parse(payload) as McpMessage
      if (message?.result || message?.error) return message
    } catch {
      // Not JSON; the next event may be.
    }
  }
  return undefined
}

/**
 * opencode's websearch: one call to Exa's web_search_exa tool, which returns
 * the text of the best matching pages. The key saved in Settings goes along
 * when there is one.
 */
export const WEB_SEARCH: Tool = {
  spec: {
    name: 'websearch',
    description: `Search the web with Exa. Returns the title, URL and text of the most relevant pages. Use it for documentation, releases, error messages, current events and anything after your knowledge cutoff. Describe the page you hope to find rather than listing keywords. The current year is ${new Date().getFullYear()}: use it when searching for recent information.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        numResults: {
          type: 'number',
          description: `How many pages to return (default ${DEFAULT_RESULTS})`
        }
      },
      required: ['query']
    }
  },
  kind: 'fetch',
  // The query leaves the machine, so Ask mode asks first, as for the browser.
  readOnly: false,
  title: 'websearch',
  paths: () => [],
  async run(args, { signal }) {
    const query = stringArg(args, 'query').trim()
    if (!query) throw new Error('"query" is empty.')
    const numResults = Math.max(1, Math.floor(numberArg(args, 'numResults') ?? DEFAULT_RESULTS))
    const key = exaKey()
    let response: Response
    try {
      response = await fetch(EXA_MCP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(key ? { 'x-api-key': key } : {})
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'web_search_exa', arguments: { query, numResults } }
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)])
      })
    } catch (error) {
      if ((error as Error).name === 'TimeoutError') {
        throw new Error(`The search took longer than ${SEARCH_TIMEOUT_MS / 1000} seconds.`)
      }
      throw error
    }
    const body = await response.text()
    if (response.status === 429 && !key) {
      throw new Error(
        "Exa's free search limit was reached. The user can add an Exa API key in Just Harness Settings."
      )
    }
    if (!response.ok) throw new Error(`Exa answered ${response.status}: ${body.slice(0, 500)}`)
    const message = mcpMessage(body)
    if (!message) throw new Error(`Exa's answer could not be read: ${body.slice(0, 500)}`)
    if (message.error) throw new Error(`Exa: ${message.error.message ?? 'unknown error'}`)
    const found = message.result?.content?.find((c) => c.type === 'text' && c.text)?.text
    if (!found) return { content: text('No results. Try a different query.') }
    const isError = message.result?.isError === true
    const bytes = Buffer.from(found)
    if (bytes.length <= MAX_BYTES) return { content: text(found), isError }
    // Cut at the last whole line within the limit.
    const kept = bytes.subarray(0, MAX_BYTES).toString('utf8')
    return {
      content: text(
        `${kept.slice(0, kept.lastIndexOf('\n'))}\n\n[Results cut to ${MAX_BYTES / 1024} KB. Ask for fewer results to see each one whole.]`
      ),
      isError
    }
  }
}

// --- Browser ---------------------------------------------------------------

let browser: Promise<{ client: Client; tools: Tool[] }> | undefined

/**
 * The browser panel's tools, listed once per launch so every request declares
 * the same tools in the same order. The `browser` argument is left out of what
 * the model sees: the harness fills in the chat's own browser.
 */
export async function browserTools(): Promise<Tool[]> {
  browser ??= connectBrowser().catch((error) => {
    browser = undefined
    throw error
  })
  return (await browser).tools
}

async function connectBrowser(): Promise<{ client: Client; tools: Tool[] }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const endpoint = browserMcpEndpoint()
  const client = new Client({ name: 'just-harness', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } }
    })
  )
  const { tools } = await client.listTools()
  return {
    client,
    tools: tools
      .map((tool) => browserTool(client, tool.name, tool.description ?? '', tool.inputSchema))
      .sort((a, b) => a.spec.name.localeCompare(b.spec.name))
  }
}

function browserTool(
  client: Client,
  name: string,
  description: string,
  schema: { properties?: Record<string, unknown>; required?: string[] }
): Tool {
  const properties = { ...schema.properties }
  delete properties.browser
  return {
    spec: {
      name,
      description,
      parameters: {
        ...schema,
        properties,
        ...(schema.required ? { required: schema.required.filter((r) => r !== 'browser') } : {})
      }
    },
    kind: 'fetch',
    readOnly: false,
    title: `${BROWSER_SERVER}_${name}`,
    paths: (args) =>
      name === 'upload' || name === 'paste_image' ? Object.values(args).flatMap(stringsIn) : [],
    async run(args, { chatId, signal }) {
      const result = await client.callTool(
        { name, arguments: { ...args, browser: browserId(chatId) } },
        undefined,
        { signal }
      )
      const content = (
        result.content as { type: string; text?: string; data?: string; mimeType?: string }[]
      ).map((item): Part =>
        item.type === 'text'
          ? { type: 'text', text: item.text ?? '' }
          : item.type === 'image' && item.data && item.mimeType
            ? { type: 'image', mimeType: item.mimeType, data: item.data }
            : { type: 'text', text: `[${item.type} content]` }
      )
      return {
        content: content.length ? content : text('(no output)'),
        isError: result.isError === true
      }
    }
  }
}

const stringsIn = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(stringsIn) : []

/** Runs a tool; a failure becomes an error result the model can act on. */
export async function runTool(
  tool: Tool,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolOutput> {
  try {
    return await tool.run(args, context)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { content: text(message), isError: true }
  }
}
