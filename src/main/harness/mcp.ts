import { app, shell } from 'electron'
import { createHash } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { SERVER_NAME as BROWSER_SERVER } from '../browser-mcp'
import { loadShellPath } from '../shell-env'
import { McpOAuth, waitForRedirect } from './mcp-auth'
import { MAX_BYTES, type Tool } from './tools'
import type { Part } from './types'

/**
 * The MCP servers the user set up in each provider's CLI, as tools for the
 * app's own agent. Each provider reads its CLI's config (see Provider.mcpServers)
 * into the shapes below; this connects to them, lists their tools and calls
 * them. Connections are shared by every chat and kept until the app quits.
 */

/** A server started as a process that speaks MCP on stdin and stdout. */
export interface StdioServer {
  name: string
  type: 'stdio'
  command: string
  args: string[]
  /** Set over the app's own environment. */
  env: Record<string, string>
  cwd: string
  /** Milliseconds for connecting and for each call; the defaults below when unset. */
  timeout?: number
}

/** A server at a URL: Streamable HTTP, SSE, or Streamable HTTP falling back to SSE (opencode's "remote"). */
export interface RemoteServer {
  name: string
  type: 'http' | 'sse' | 'http-or-sse'
  url: string
  headers: Record<string, string>
  /** How to sign in when the server asks for it; false when the config turns sign-in off. */
  oauth: OAuthConfig | false
  timeout?: number
}

/** A pre-registered OAuth client, from the server's config. */
export interface OAuthConfig {
  clientId?: string
  clientSecret?: string
  scope?: string
  redirectUri?: string
}

/** A server whose config could not be used, with why. */
export interface InvalidServer {
  name: string
  type: 'invalid'
  error: string
}

export type McpServer = StdioServer | RemoteServer
export type McpEntry = McpServer | InvalidServer

/** As opencode waits for a server to start and list its tools. */
const CONNECT_TIMEOUT_MS = 30_000
/** Of a stdio server's error output, the end shown when it fails to start. */
const STDERR_TAIL = 2000
/** Larger images are left out: the APIs reject images over 5 MB. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** The image types the model APIs accept. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Tool names may hold only these, and at most 64 of them, on both APIs. */
const sanitize = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_')
const MAX_NAME = 64
/** A longer name keeps this much and a hash of the full one, as Cline does. */
const NAME_KEPT = 55

/** The name the model sees: Command Code's and Claude Code's mcp__server__tool. */
export function mcpToolName(server: string, tool: string): string {
  const name = `mcp__${sanitize(server)}__${sanitize(tool)}`
  if (name.length <= MAX_NAME) return name
  const hash = createHash('sha1').update(`${server}__${tool}`).digest('hex').slice(0, 8)
  return `${name.slice(0, NAME_KEPT)}_${hash}`
}

/** Whether a tool name belongs to the server; long names keep at least their first NAME_KEPT characters. */
export function isServerTool(server: string, toolName: string): boolean {
  return toolName.startsWith(`mcp__${sanitize(server)}__`.slice(0, NAME_KEPT))
}

/** A server that answered: its client and its tools. */
interface Connection {
  client: Client
  tools: Tool[]
}

/** Thrown when a server needs the user to sign in; `finish` completes it with the browser's code. */
export class SignInRequired extends Error {
  constructor(
    readonly oauth: McpOAuth,
    readonly finish: (code: string) => Promise<void>
  ) {
    super('it needs you to sign in')
  }
}

/** A server that could not be used this time. */
export interface McpProblem {
  server: McpEntry
  message: string
  /** Set when signing in would fix it. */
  signIn?: SignInRequired
}

/** Connections by server config, so every chat with the same server shares one. */
const connections = new Map<string, Promise<Connection>>()
/** Sign-ins under way, by server config, so two chats do not open two. */
const signingIn = new Map<string, Promise<void>>()

const keyOf = (server: McpEntry): string => JSON.stringify(server)

/**
 * Connect to the servers and return their tools in a fixed order (servers by
 * name, then tools by name), so a chat's tool list comes out the same way each
 * time. Servers that fail are left out and said why; they are tried again on
 * the next call.
 */
export async function mcpTools(
  entries: McpEntry[]
): Promise<{ tools: Tool[]; problems: McpProblem[] }> {
  const servers = entries
    // The browser panel's own server, which the app registers with Cline: the harness has those tools already.
    .filter((s) => s.name !== BROWSER_SERVER)
    .sort((a, b) => a.name.localeCompare(b.name))
  const results = await Promise.all(
    servers.map(async (server) => {
      if (server.type === 'invalid') return { server, message: server.error }
      try {
        return await connection(server)
      } catch (error) {
        return {
          server,
          message: (error as Error).message,
          ...(error instanceof SignInRequired ? { signIn: error } : {})
        }
      }
    })
  )
  const tools: Tool[] = []
  const problems: McpProblem[] = []
  const names = new Set<string>()
  for (const result of results) {
    if ('message' in result) {
      problems.push(result)
      continue
    }
    for (const tool of result.tools) {
      // Two tools whose names differ only in characters a tool name cannot hold.
      if (names.has(tool.spec.name)) continue
      names.add(tool.spec.name)
      tools.push(tool)
    }
  }
  return { tools, problems }
}

function connection(server: McpServer): Promise<Connection> {
  const key = keyOf(server)
  let pending = connections.get(key)
  if (!pending) {
    pending = connect(server).then(
      (connected) => {
        // A server that stops (a process that exits, a dropped session) is started again when next needed.
        connected.client.onclose = () => {
          if (connections.get(key) === pending) connections.delete(key)
        }
        return connected
      },
      (error) => {
        connections.delete(key)
        throw error
      }
    )
    connections.set(key, pending)
  }
  return pending
}

async function connect(server: McpServer): Promise<Connection> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const timeout = server.timeout ?? CONNECT_TIMEOUT_MS
  const attempt = async (transport: Transport, output?: () => string): Promise<Connection> => {
    const client = new Client({ name: 'just-harness', version: app.getVersion() })
    try {
      await client.connect(transport, { timeout })
      return { client, tools: await listTools(client, server, timeout) }
    } catch (error) {
      await client.close().catch(() => undefined)
      if (server.type === 'stdio' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`the command "${server.command}" was not found.`)
      }
      // What a server that failed to start printed usually says why.
      const said = output?.().trim()
      if (said) throw new Error(`${(error as Error).message}\n${said}`)
      throw error
    }
  }

  if (server.type === 'stdio') {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    // Commands such as npx are found through the login shell's PATH.
    await loadShellPath()
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: { ...(process.env as Record<string, string>), ...server.env },
      cwd: server.cwd,
      stderr: 'pipe'
    })
    let stderr = ''
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL)
    })
    return attempt(transport, () => stderr)
  }

  // A static Authorization header is the server's sign-in; OAuth would replace it (Cline refuses both).
  const hasAuthorization = Object.keys(server.headers).some(
    (h) => h.toLowerCase() === 'authorization'
  )
  const oauth = server.oauth && !hasAuthorization ? new McpOAuth(server) : undefined
  const options = {
    requestInit: { headers: server.headers },
    ...(oauth ? { authProvider: oauth } : {})
  }
  const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js')
  const signInOr = (
    error: unknown,
    transport: { finishAuth(code: string): Promise<void> }
  ): never => {
    if (oauth?.authorizationUrl && error instanceof UnauthorizedError) {
      throw new SignInRequired(oauth, (code) => transport.finishAuth(code))
    }
    throw error
  }
  const viaHttp = async (): Promise<Connection> => {
    const { StreamableHTTPClientTransport } =
      await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const transport = new StreamableHTTPClientTransport(new URL(server.url), options)
    return attempt(transport).catch((error) => signInOr(error, transport))
  }
  const viaSse = async (): Promise<Connection> => {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
    const transport = new SSEClientTransport(new URL(server.url), options)
    return attempt(transport).catch((error) => signInOr(error, transport))
  }
  if (server.type === 'http') return viaHttp()
  if (server.type === 'sse') return viaSse()
  // opencode's order: Streamable HTTP, then SSE for servers that only speak the older transport.
  try {
    return await viaHttp()
  } catch (error) {
    if (error instanceof SignInRequired) throw error
    return viaSse().catch((sseError) => {
      if (sseError instanceof SignInRequired) throw sseError
      throw error
    })
  }
}

/** Every tool the server lists, page by page, sorted by name. */
async function listTools(client: Client, server: McpServer, timeout: number): Promise<Tool[]> {
  const listed: Awaited<ReturnType<Client['listTools']>>['tools'] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout })
    listed.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor)
  return listed
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => mcpTool(client, server, tool))
}

function mcpTool(
  client: Client,
  server: McpServer,
  tool: { name: string; description?: string; inputSchema: Record<string, unknown> }
): Tool {
  const name = mcpToolName(server.name, tool.name)
  return {
    spec: {
      name,
      description:
        tool.description || `Runs the tool "${tool.name}" of the MCP server "${server.name}".`,
      parameters: tool.inputSchema
    },
    kind: 'other',
    // The user set the server up, but what its tools do is unknown, so Ask mode asks.
    readOnly: false,
    title: name,
    paths: () => [],
    async run(args, { signal }) {
      const result = await client.callTool({ name: tool.name, arguments: args }, undefined, {
        signal,
        ...(server.timeout ? { timeout: server.timeout } : {}),
        // Long tools that report progress are not stopped by the timeout.
        onprogress: () => undefined,
        resetTimeoutOnProgress: true
      })
      const content = Array.isArray(result.content)
        ? (result.content as McpContent[]).map(toPart)
        : []
      if (content.length === 0 && result.structuredContent !== undefined) {
        content.push(textPart(JSON.stringify(result.structuredContent, null, 2)))
      }
      return {
        content: content.length ? content : [{ type: 'text', text: '(no output)' }],
        isError: result.isError === true
      }
    }
  }
}

interface McpContent {
  type: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
  name?: string
  resource?: { uri?: string; mimeType?: string; text?: string }
}

/** One item of a tool's result as the model gets it. */
function toPart(item: McpContent): Part {
  switch (item.type) {
    case 'text':
      return textPart(item.text ?? '')
    case 'image':
      if (!item.data || !item.mimeType || !IMAGE_TYPES.has(item.mimeType)) {
        return textPart(`[An image of type ${item.mimeType ?? 'unknown'} the model cannot read.]`)
      }
      if (item.data.length * 0.75 > MAX_IMAGE_BYTES) {
        return textPart('[An image over 5 MB was left out.]')
      }
      return { type: 'image', mimeType: item.mimeType, data: item.data }
    case 'resource':
      return item.resource?.text !== undefined
        ? textPart(item.resource.text)
        : textPart(
            `[Resource ${item.resource?.uri ?? ''} (${item.resource?.mimeType ?? 'binary'})]`
          )
    case 'resource_link':
      return textPart(`[Resource ${item.name ?? ''} at ${item.uri ?? ''}]`)
    default:
      return textPart(`[${item.type} content]`)
  }
}

/** Text, cut to MAX_BYTES as the app's own tools are. */
function textPart(text: string): Part {
  const bytes = Buffer.from(text)
  if (bytes.length <= MAX_BYTES) return { type: 'text', text }
  const kept = bytes.subarray(0, MAX_BYTES).toString('utf8')
  return {
    type: 'text',
    text: `${kept}\n\n[Output cut to ${MAX_BYTES / 1024} KB of ${Math.round(bytes.length / 1024)} KB.]`
  }
}

/**
 * Sign in to a server: open the page it asked for in the user's browser, wait
 * for the browser to come back, and finish with the code. The server is
 * connected again on the next mcpTools.
 */
export function signIn(problem: McpProblem, signal: AbortSignal): Promise<void> {
  const required = problem.signIn
  if (!required) return Promise.resolve()
  const key = keyOf(problem.server)
  let pending = signingIn.get(key)
  if (!pending) {
    pending = (async () => {
      const code = await waitForRedirect(
        required.oauth,
        () => shell.openExternal(required.oauth.authorizationUrl!.href),
        signal
      )
      await required.finish(code)
    })().finally(() => signingIn.delete(key))
    signingIn.set(key, pending)
  }
  return pending
}

/** Close every connection, which stops the servers the app started; called when the app quits. */
export async function closeMcp(): Promise<void> {
  const open = [...connections.values()]
  connections.clear()
  await Promise.all(
    open.map((pending) =>
      pending.then(
        ({ client }) => client.close(),
        () => undefined
      )
    )
  )
}
