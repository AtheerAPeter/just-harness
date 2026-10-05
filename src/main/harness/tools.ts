import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { browserId, browserMcpEndpoint, SERVER_NAME as BROWSER_SERVER } from '../browser-mcp'
import { loadShellPath } from '../shell-env'
import type { Part, ToolSpec } from './types'

/**
 * The model's tools: pi's four (read, bash, edit, write) and the built-in
 * browser's, reached through its MCP server.
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
  kind: 'read' | 'edit' | 'execute' | 'fetch'
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
const MAX_BYTES = 50 * 1024

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
    const chunks: Buffer[] = []
    child.stdout.on('data', (data: Buffer) => chunks.push(data))
    child.stderr.on('data', (data: Buffer) => chunks.push(data))

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

    const code = await new Promise<number | null>((done, fail) => {
      child.once('error', fail)
      child.once('close', (exitCode) => done(exitCode))
    }).finally(() => {
      signal.removeEventListener('abort', onAbort)
      clearTimeout(timer)
    })

    const output = Buffer.concat(chunks).toString('utf8')
    let shown = tail(output)
    if (shown !== output) {
      const file = join(tmpdir(), `just-harness-${crypto.randomUUID().slice(0, 8)}.log`)
      await writeFile(file, output)
      shown += `\n\n[Output cut to its end. Full output: ${file}]`
    }
    const status = stoppedBy ?? (code !== 0 ? `Exit code ${code ?? 'unknown'}.` : '')
    const result = [shown.trimEnd(), status].filter(Boolean).join('\n\n') || '(no output)'
    return { content: text(result), isError: Boolean(stoppedBy) || code !== 0 }
  }
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
