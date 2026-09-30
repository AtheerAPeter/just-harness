import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { pathToFileURL } from 'node:url'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type {
  Attachment,
  BrowserState,
  OpenChatResult,
  AgentCommand,
  AgentId,
  AgentOption,
  AgentStatus,
  ChatItem,
  ToolStatus
} from '../shared/types'
import * as store from './store'
import { browserMcpServer, BROWSER_GUIDANCE, SERVER_NAME as BROWSER_SERVER } from './browser-mcp'
import { listSkills } from './skills'
import { resolveProjectFile } from './files'

const COMMANDS: Record<AgentId, { command: string; args: string[] }> = {
  opencode: { command: 'opencode', args: ['acp'] },
  cline: { command: 'cline', args: ['--acp'] }
}

/**
 * An agent process with no prompt running is stopped after this long. Agents
 * hold 200+ MB each; chats reconnect with session/load when used again.
 */
const IDLE_STOP_MS = 5 * 60_000

/**
 * Opencode ships a built-in `browser` tool that drives the user's own desktop
 * browser, and models sometimes pick it over the built-in panel. Deny it for the
 * opencode this app starts; OPENCODE_CONFIG_CONTENT is applied on top of the
 * user's config, so their own settings stay in effect.
 */
function agentEnv(agent: AgentId): NodeJS.ProcessEnv {
  if (agent !== 'opencode') return process.env
  const inline = process.env.OPENCODE_CONFIG_CONTENT
  const config = inline ? (JSON.parse(inline) as Record<string, unknown>) : {}
  const permission = {
    ...(config.permission as Record<string, unknown> | undefined),
    browser: 'deny'
  }
  return { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, permission }) }
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
/** Larger images are sent as file references instead of inline data. */
const MAX_INLINE_IMAGE = 15 * 1024 * 1024

function imageType(attachment: Attachment): string | undefined {
  if (attachment.mimeType?.startsWith('image/')) return attachment.mimeType
  return attachment.path ? IMAGE_TYPES[extname(attachment.path).toLowerCase()] : undefined
}

function isImage(attachment: Attachment): boolean {
  return imageType(attachment) !== undefined
}

/**
 * ACP content for attachments: images inline (both agents accept image
 * content), other files as references the agent reads itself.
 */
async function attachmentBlocks(attachments: Attachment[]): Promise<acp.ContentBlock[]> {
  const blocks: acp.ContentBlock[] = []
  for (const attachment of attachments) {
    const mimeType = imageType(attachment)
    if (mimeType && attachment.data) {
      blocks.push({ type: 'image', data: attachment.data, mimeType })
    } else if (mimeType && attachment.path && statSync(attachment.path).size <= MAX_INLINE_IMAGE) {
      const data = (await readFile(attachment.path)).toString('base64')
      blocks.push({ type: 'image', data, mimeType, uri: pathToFileURL(attachment.path).href })
    } else if (attachment.path) {
      blocks.push({
        type: 'resource_link',
        uri: pathToFileURL(attachment.path).href,
        name: attachment.name
      })
    }
  }
  return blocks
}

/**
 * Agents whose ACP mode keeps only the text of a prompt. Cline 3.0.65 filters
 * prompts to `type === "text"` blocks (its `qJ` in the ACP agent), dropping
 * images and file links although it advertises image support. They get
 * attachments as file paths in the text and read them with their own tools.
 * (@file mentions are already in the text as paths.)
 */
const TEXT_ONLY_PROMPTS = new Set<AgentId>(['cline'])

/** Pasted images have no file; save them so a path can be given to the agent. */
const attachmentsDir = join(app.getPath('userData'), 'attachments')

async function withFilePaths(text: string, attachments: Attachment[]): Promise<string> {
  if (attachments.length === 0) return text
  const paths: string[] = []
  for (const attachment of attachments) {
    if (attachment.path) {
      paths.push(attachment.path)
    } else if (attachment.data) {
      await mkdir(attachmentsDir, { recursive: true })
      const ext = attachment.mimeType?.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
      const path = join(attachmentsDir, `${crypto.randomUUID()}.${ext}`)
      await writeFile(path, Buffer.from(attachment.data, 'base64'))
      paths.push(path)
    }
  }
  return `${text}\n\nAttached files (read them with your file tools):\n${paths.map((p) => `- ${p}`).join('\n')}`
}

/** The short browser ID agents are given for a chat: the start of its id. */
export function browserId(chatId: string): string {
  return chatId.slice(0, 8)
}

/** ACP's error code for an unknown session (RequestError.resourceNotFound). */
const RESOURCE_NOT_FOUND = -32002

/** Chats always run in the agent's build mode; plan mode is not offered. */
const BUILD_MODE: Record<AgentId, string> = { opencode: 'build', cline: 'act' }

interface PendingPermission {
  chatId: string
  resolve: (response: acp.RequestPermissionResponse) => void
}

export interface AgentEvents {
  item(chatId: string, item: ChatItem): void
  options(chatId: string, options: AgentOption[]): void
  commands(chatId: string, commands: AgentCommand[]): void
  stateChanged(): void
}

class AgentProcess {
  private child?: ChildProcess
  private connection?: acp.ClientConnection
  private starting?: Promise<acp.ClientConnection>
  private initResult?: acp.InitializeResponse
  /** ACP session id -> chat id, for routing session/update notifications. */
  private sessionChats = new Map<string, string>()
  /** Sessions whose history is being replayed by session/load; updates are dropped. */
  private loadingSessions = new Set<string>()
  /** Sessions opened by this process instance. After a restart they must be loaded again. */
  private liveSessions = new Set<string>()
  /** In-flight session opens per chat, so concurrent callers share one. */
  private opening = new Map<string, Promise<string>>()
  /** The live session options (model, mode, ...) per chat, as the agent last reported them. */
  private options = new Map<string, AgentOption[]>()
  /**
   * Slash commands per ACP session id. Keyed by session because agents announce
   * them before the session/new response tells us which chat the session is for.
   */
  private commands = new Map<string, AgentCommand[]>()
  private activePrompts = 0
  private idleTimer?: NodeJS.Timeout

  constructor(
    readonly agent: AgentId,
    private readonly events: AgentEvents,
    private readonly permissions: Map<string, PendingPermission>
  ) {}

  async connect(): Promise<acp.ClientConnection> {
    if (this.connection) return this.connection
    this.starting ??= this.start().finally(() => (this.starting = undefined))
    return this.starting
  }

  private async start(): Promise<acp.ClientConnection> {
    const { command, args } = COMMANDS[this.agent]
    const child = spawn(command, args, {
      cwd: homedir(),
      env: agentEnv(this.agent),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    child.stderr!.on('data', (data) => console.error(`[${this.agent}] ${String(data).trimEnd()}`))

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    )
    const connection = acp
      .client({ name: 'just-harness' })
      .onNotification(acp.methods.client.session.update, (ctx) => this.onUpdate(ctx.params))
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.onPermission(ctx.params)
      )
      .connect(stream)

    child.once('exit', (code, signal) => {
      console.error(`[${this.agent}] exited (${signal ?? code})`)
      connection.close(new Error(`${this.agent} exited`))
      this.onExit()
    })

    this.child = child
    this.initResult = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'just-harness', version: '1.0.0' }
    })
    this.connection = connection
    this.scheduleIdleStop()
    return connection
  }

  /** Restart the idle countdown; the process is stopped once nothing has used it for a while. */
  private scheduleIdleStop(): void {
    clearTimeout(this.idleTimer)
    if (this.activePrompts > 0 || this.opening.size > 0) return
    this.idleTimer = setTimeout(() => {
      if (this.activePrompts === 0 && this.opening.size === 0) this.stop()
    }, IDLE_STOP_MS)
  }

  private onExit(): void {
    clearTimeout(this.idleTimer)
    this.child = undefined
    this.connection = undefined
    this.liveSessions.clear()
    this.loadingSessions.clear()
    this.commands.clear()
    for (const [id, pending] of this.permissions) {
      if (store.getChat(pending.chatId).agent === this.agent) {
        this.permissions.delete(id)
        this.resolvePermissionItem(pending.chatId, id, 'cancelled')
      }
    }
    for (const chatId of this.sessionChats.values()) {
      if (store.getState().chats.some((c) => c.id === chatId && c.running)) {
        store.updateChat(chatId, { running: false })
        this.emit(chatId, {
          kind: 'error',
          id: crypto.randomUUID(),
          text: `${this.agent} stopped unexpectedly.`
        })
      }
    }
    this.events.stateChanged()
  }

  stop(): void {
    this.child?.kill()
  }

  /**
   * Whether this agent takes HTTP MCP servers per session. If so, each chat gets
   * its own browser address; if not (cline), chats share one address and the
   * agent is told its browser ID instead.
   */
  takesHttpMcp(): boolean {
    return this.initResult?.agentCapabilities?.mcpCapabilities?.http === true
  }

  getOptions(chatId: string): AgentOption[] | undefined {
    return this.options.get(chatId)
  }

  getCommands(chatId: string): AgentCommand[] {
    const sessionId = store.getChat(chatId).sessionId
    return (sessionId && this.commands.get(sessionId)) || []
  }

  private setOptions(
    chatId: string,
    configOptions: acp.SessionConfigOption[] | null | undefined
  ): void {
    if (!configOptions) return
    const options = normalizeOptions(configOptions)
    this.options.set(chatId, options)
    // Remember what is selected so a reloaded or recreated session starts the same way.
    store.updateChat(chatId, {
      settings: Object.fromEntries(options.map((o) => [o.id, o.currentValue]))
    })
    this.events.options(chatId, options)
  }

  /** Make sure the chat has a live ACP session in this process, creating or loading it. */
  ensureSession(chatId: string): Promise<string> {
    const sessionId = store.getChat(chatId).sessionId
    if (this.isLive(sessionId)) return Promise.resolve(sessionId)
    let pending = this.opening.get(chatId)
    if (!pending) {
      pending = this.openSession(chatId).finally(() => {
        this.opening.delete(chatId)
        this.scheduleIdleStop()
      })
      this.opening.set(chatId, pending)
    }
    return pending
  }

  private async openSession(chatId: string): Promise<string> {
    const connection = await this.connect()
    const chat = store.getChat(chatId)
    const cwd = store.getProject(chat.projectId).path
    // Agents that take HTTP MCP servers over ACP get the browser tools here. Cline's
    // ACP mode ignores session MCP servers; it is registered in cline's own config
    // instead (see cline-mcp.ts).
    const mcpServers = this.takesHttpMcp() ? [browserMcpServer(chatId)] : []

    let sessionId: string
    let configOptions: acp.SessionConfigOption[] | null | undefined
    const loaded = chat.sessionId
      ? await this.loadSession(chatId, chat.sessionId, cwd, mcpServers)
      : undefined
    if (chat.sessionId && loaded) {
      sessionId = chat.sessionId
      configOptions = loaded.configOptions
    } else {
      const created = await connection.agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers
      })
      sessionId = created.sessionId
      configOptions = created.configOptions
      store.updateChat(chatId, { sessionId })
      if (chat.sessionId && store.getMessages(chatId).some((i) => i.kind === 'user')) {
        this.emit(chatId, {
          kind: 'error',
          id: crypto.randomUUID(),
          text: `${this.agent} no longer has this conversation, so it continues in a new session without the earlier context.`
        })
      }
    }
    this.sessionChats.set(sessionId, chatId)
    this.liveSessions.add(sessionId)

    // Re-apply the saved selection. Options can depend on each other (cline's model
    // list depends on its provider), so apply them in the agent's order and
    // re-read the list after every change. The mode is always build, whatever was
    // saved or restored with the session.
    const wanted = { ...chat.settings }
    for (const option of normalizeOptions(configOptions ?? [])) {
      if (option.category === 'mode') wanted[option.id] = BUILD_MODE[this.agent]
    }
    let options = normalizeOptions(configOptions ?? [])
    for (let i = 0; i < options.length; i++) {
      const option = options[i]
      const value = wanted[option.id]
      if (!value || value === option.currentValue) continue
      if (!option.values.some((v) => v.value === value)) continue
      const response = await connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: option.id,
        value
      })
      configOptions = response.configOptions
      options = normalizeOptions(configOptions)
    }
    this.setOptions(chatId, configOptions)
    return sessionId
  }

  /**
   * Reopen a saved session. Returns undefined when the agent cannot restore it:
   * it does not support loading, or it never stored the session (cline only saves
   * a session once it has a message).
   */
  private async loadSession(
    chatId: string,
    sessionId: string,
    cwd: string,
    mcpServers: acp.McpServer[]
  ): Promise<acp.LoadSessionResponse | undefined> {
    if (!this.initResult?.agentCapabilities?.loadSession) return undefined
    const connection = await this.connect()
    this.sessionChats.set(sessionId, chatId)
    this.loadingSessions.add(sessionId)
    try {
      return await connection.agent.request(acp.methods.agent.session.load, {
        sessionId,
        cwd,
        mcpServers
      })
    } catch (error) {
      if (error instanceof acp.RequestError && error.code === RESOURCE_NOT_FOUND) {
        this.sessionChats.delete(sessionId)
        return undefined
      }
      throw error
    } finally {
      this.loadingSessions.delete(sessionId)
    }
  }

  async applyOption(chatId: string, optionId: string, value: string): Promise<void> {
    const sessionId = await this.ensureSession(chatId)
    const connection = await this.connect()
    const response = await connection.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId: optionId,
      value
    })
    this.setOptions(chatId, response.configOptions)
    this.scheduleIdleStop()
  }

  /**
   * Let go of a chat's session. A session with no messages is deleted so it does not
   * clutter the agent's own history; otherwise it is only closed.
   */
  async release(chatId: string): Promise<void> {
    const chat = store.getChat(chatId)
    this.options.delete(chatId)
    if (!chat.sessionId || !this.connection) return
    const sessionId = chat.sessionId
    const caps = this.initResult?.agentCapabilities?.sessionCapabilities
    const empty = !store.getMessages(chatId).some((i) => i.kind === 'user')
    const wasLive = this.isLive(sessionId)
    this.liveSessions.delete(sessionId)
    this.sessionChats.delete(sessionId)
    this.commands.delete(sessionId)
    if (empty && caps?.delete) {
      await this.connection.agent.request(acp.methods.agent.session.delete, { sessionId })
    } else if (wasLive && caps?.close) {
      await this.connection.agent.request(acp.methods.agent.session.close, { sessionId })
    }
  }

  isLive(sessionId: string | undefined): sessionId is string {
    return !!sessionId && this.liveSessions.has(sessionId)
  }

  async prompt(
    chatId: string,
    text: string,
    attachments: acp.ContentBlock[] = []
  ): Promise<acp.PromptResponse> {
    this.activePrompts++
    clearTimeout(this.idleTimer)
    try {
      const sessionId = await this.ensureSession(chatId)
      const connection = await this.connect()
      return await connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text }, ...attachments]
      })
    } finally {
      this.activePrompts--
      this.scheduleIdleStop()
    }
  }

  async cancel(chatId: string): Promise<void> {
    const sessionId = store.getChat(chatId).sessionId
    if (!this.connection || !this.isLive(sessionId)) return
    for (const [id, pending] of this.permissions) {
      if (pending.chatId === chatId) {
        pending.resolve({ outcome: { outcome: 'cancelled' } })
        this.permissions.delete(id)
        this.resolvePermissionItem(chatId, id, 'cancelled')
      }
    }
    await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })
  }

  private emit(chatId: string, item: ChatItem): void {
    this.events.item(chatId, store.upsertItem(chatId, item))
  }

  resolvePermissionItem(chatId: string, id: string, resolved: string, auto = false): void {
    const item = store.findItem(chatId, id)
    if (item?.kind === 'permission') this.emit(chatId, { ...item, resolved, auto })
  }

  private onPermission(
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    const chatId = this.sessionChats.get(params.sessionId)
    if (!chatId) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    const id = crypto.randomUUID()
    const item: Extract<ChatItem, { kind: 'permission' }> = {
      kind: 'permission',
      id,
      title: params.toolCall.title ?? 'Tool call',
      options: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }))
    }
    const chat = store.getChat(chatId)
    // Project-only mode: anything outside the project always goes to the user,
    // bypass or not, with the agent's own options (including "always").
    const outside = chat.projectOnly
      ? outsidePath(store.getProject(chat.projectId).path, params.toolCall)
      : undefined
    if (outside) item.outside = outside
    const autoOption = chat.bypassPermissions && !outside ? bypassOption(item.options) : undefined
    if (autoOption) {
      this.emit(chatId, { ...item, resolved: autoOption, auto: true })
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: autoOption } })
    }
    this.emit(chatId, item)
    return new Promise((resolve) => this.permissions.set(id, { chatId, resolve }))
  }

  private onUpdate(params: acp.SessionNotification): void {
    if (params.update.sessionUpdate === 'available_commands_update') {
      const commands = params.update.availableCommands.map((c) => ({
        name: c.name,
        description: c.description
      }))
      this.commands.set(params.sessionId, commands)
      const target = this.sessionChats.get(params.sessionId)
      if (target) this.events.commands(target, commands)
      return
    }
    if (this.loadingSessions.has(params.sessionId)) return
    const chatId = this.sessionChats.get(params.sessionId)
    if (!chatId) return
    const update = params.update

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (update.content.type !== 'text') return
        const kind = update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought'
        const last = store.lastItem(chatId)
        // Consecutive chunks of the same kind form one block.
        if (last?.kind === kind)
          this.emit(chatId, { ...last, text: last.text + update.content.text })
        else this.emit(chatId, { kind, id: crypto.randomUUID(), text: update.content.text })
        return
      }
      case 'tool_call':
      case 'tool_call_update': {
        const existing = store.findItem(chatId, update.toolCallId)
        const base: Extract<ChatItem, { kind: 'tool' }> =
          existing?.kind === 'tool'
            ? existing
            : { kind: 'tool', id: update.toolCallId, title: 'Tool call', status: 'pending' }
        const output = formatToolContent(update.content) ?? formatRaw(update.rawOutput)
        this.emit(chatId, {
          ...base,
          title: update.title ?? base.title,
          toolKind: update.kind ?? base.toolKind,
          status: (update.status as ToolStatus | undefined) ?? base.status,
          input: formatRaw(update.rawInput) ?? base.input,
          output: output ?? base.output
        })
        return
      }
      case 'plan': {
        const existing = store.getMessages(chatId).findLast((i) => i.kind === 'plan')
        this.emit(chatId, {
          kind: 'plan',
          id: existing?.id ?? crypto.randomUUID(),
          entries: update.entries.map((e) => ({ content: e.content, status: e.status }))
        })
        return
      }
      case 'config_option_update': {
        this.setOptions(chatId, update.configOptions)
        return
      }
      case 'session_info_update': {
        if (update.title && !store.getChat(chatId).renamed) {
          store.updateChat(chatId, { title: update.title })
          this.events.stateChanged()
        }
        return
      }
      default:
        return
    }
  }
}

/** Paths that are never "outside": shell plumbing like 2>/dev/null. */
const HARMLESS_PATHS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin'])

/**
 * For project-only mode: the first path a tool request touches outside the
 * project, if any. Looks at the locations the agent declares and at absolute or
 * ~ paths anywhere in the tool's arguments, including shell commands. URLs are
 * not paths (the "/" there follows ":"), so they are ignored.
 */
function outsidePath(projectPath: string, toolCall: acp.ToolCallUpdate): string | undefined {
  const candidates = (toolCall.locations ?? []).map((l) => l.path)
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const [, path] of value.matchAll(/(?:^|[\s"'=(])((?:~|\/)[^\s"'`;|&<>()]*)/g)) {
        candidates.push(path)
      }
    } else if (value && typeof value === 'object') {
      for (const inner of Object.values(value)) scan(inner)
    }
  }
  scan(toolCall.rawInput)
  for (const candidate of candidates) {
    if (HARMLESS_PATHS.has(candidate)) continue
    const absolute = resolvePath(projectPath, candidate.replace(/^~(?=\/|$)/, homedir()))
    const rel = relative(projectPath, absolute)
    if (rel.startsWith('..') || isAbsolute(rel)) return candidate
  }
  return undefined
}

/**
 * The option bypass mode picks: allow once, so no lasting rule is written into
 * the agent's own config. Falls back to allow always when that is all there is.
 */
function bypassOption(options: { optionId: string; kind: string }[]): string | undefined {
  return (
    options.find((o) => o.kind === 'allow_once')?.optionId ??
    options.find((o) => o.kind === 'allow_always')?.optionId
  )
}

function formatToolContent(content: acp.ToolCallContent[] | null | undefined): string | undefined {
  if (!content?.length) return undefined
  const parts = content.map((c) => {
    if (c.type === 'content')
      return c.content.type === 'text' ? c.content.text : `[${c.content.type}]`
    if (c.type === 'diff') return `--- ${c.path}\n${diffLines(c.oldText ?? '', c.newText)}`
    return '[terminal output]'
  })
  return parts.join('\n')
}

/** A minimal line diff: drop the common prefix/suffix and show what changed. */
function diffLines(oldText: string, newText: string): string {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  return [
    ...a.slice(start, endA).map((l) => `- ${l}`),
    ...b.slice(start, endB).map((l) => `+ ${l}`)
  ].join('\n')
}

function formatRaw(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function normalizeOptions(configOptions: acp.SessionConfigOption[]): AgentOption[] {
  return configOptions.flatMap((option): AgentOption[] => {
    if (option.type !== 'select') return []
    const values = option.options.flatMap((entry) => ('group' in entry ? entry.options : [entry]))
    return [
      {
        id: option.id,
        name: option.name,
        category: option.category ?? option.id,
        currentValue: option.currentValue,
        values: values.map((v) => ({
          value: v.value,
          name: v.name,
          description: v.description ?? undefined
        }))
      }
    ]
  })
}

function cliVersion(agent: AgentId): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(COMMANDS[agent].command, ['--version'], { timeout: 10_000 }, (error, stdout) =>
      resolve(error ? undefined : stdout.trim().split('\n').pop())
    )
  })
}

function errorMessage(error: unknown): string {
  if (error instanceof acp.RequestError) {
    const data = error.data as { message?: string } | undefined
    return data?.message ? `${error.message}: ${data.message}` : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export class AgentManager {
  private readonly permissions = new Map<string, PendingPermission>()
  private readonly processes: Record<AgentId, AgentProcess>
  private readonly statuses = new Map<AgentId, Promise<AgentStatus>>()

  constructor(
    private readonly events: AgentEvents,
    /** The page open in the built-in browser, for `@browser` messages. */
    private readonly browserPage: (chatId: string) => BrowserState | undefined
  ) {
    this.processes = {
      opencode: new AgentProcess('opencode', events, this.permissions),
      cline: new AgentProcess('cline', events, this.permissions)
    }
  }

  /** Whether the CLI is installed, and its version. */
  status(agent: AgentId): Promise<AgentStatus> {
    let cached = this.statuses.get(agent)
    if (!cached) {
      cached = cliVersion(agent).then((version) =>
        version
          ? { agent, available: true, version }
          : {
              agent,
              available: false,
              error: `\`${COMMANDS[agent].command}\` was not found on your PATH.`
            }
      )
      this.statuses.set(agent, cached)
    }
    return cached
  }

  /** Open the chat's session (starting the agent if needed) and return its options. */
  async open(chatId: string): Promise<OpenChatResult> {
    const agentProcess = this.processes[store.getChat(chatId).agent]
    try {
      await agentProcess.ensureSession(chatId)
      return {
        options: agentProcess.getOptions(chatId) ?? [],
        commands: agentProcess.getCommands(chatId)
      }
    } catch (error) {
      return { options: [], commands: [], error: errorMessage(error) }
    }
  }

  /** Switch a chat that has not started yet to another agent. */
  async changeAgent(
    chatId: string,
    agent: AgentId,
    settings: Record<string, string>
  ): Promise<void> {
    const chat = store.getChat(chatId)
    if (store.getMessages(chatId).some((i) => i.kind === 'user')) {
      throw new Error('The agent cannot change after the chat has started.')
    }
    await this.processes[chat.agent].release(chatId)
    store.updateChat(chatId, { agent, settings, sessionId: undefined })
    this.events.stateChanged()
  }

  async deleteChat(chatId: string): Promise<void> {
    const chat = store.getChat(chatId)
    if (chat.running) await this.cancel(chatId)
    await this.processes[chat.agent].release(chatId)
    store.removeChat(chatId)
    this.events.stateChanged()
  }

  /**
   * Neither CLI exposes skills as slash commands, so `/skill-name rest` becomes an
   * explicit request to use that skill. Agent commands are passed through as typed.
   * Any skill on the machine can be used; ones the agent does not discover itself
   * (e.g. ~/.claude/skills for cline) are passed by file path.
   */
  private expandSkill(chatId: string, text: string): string {
    const match = text.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/)
    if (!match) return text
    const [, name, rest] = match
    const chat = store.getChat(chatId)
    if (this.processes[chat.agent].getCommands(chatId).some((c) => c.name === name)) return text
    const project = store.getProject(chat.projectId)
    const skill = listSkills(project.path).find((s) => s.name === name)
    if (!skill) return text
    const task = rest ? `\n\n${rest}` : ''
    // Skills in another agent's folder are not discovered by this agent, so point at the file.
    if (!skill.agents.includes(chat.agent)) {
      return `Use the "${name}" skill: read ${skill.path} and follow its instructions.${task}`
    }
    return `Use the "${name}" skill.${task}`
  }

  /**
   * `@browser` asks the agent to work in the built-in browser panel. The agent
   * sees the tag as plain text, so spell out which tools that means and what
   * page is open.
   */
  private expandBrowserTag(chatId: string, text: string): string {
    if (!/(^|\s)@browser\b/.test(text)) return text
    const page = this.browserPage(chatId)
    const where = page?.url
      ? ` It currently shows ${page.url}${page.title ? ` ("${page.title}")` : ''}.`
      : ''
    return `${text}\n\n@browser: use the ${BROWSER_SERVER} tools for this.${where} ${BROWSER_GUIDANCE}`
  }

  /** `@path` mentions of project files become ACP resource links next to the text. */
  private fileLinks(chatId: string, text: string): acp.ContentBlock[] {
    const project = store.getProject(store.getChat(chatId).projectId)
    const links = new Map<string, acp.ContentBlock>()
    for (const [, mention] of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
      const path = resolveProjectFile(project.path, mention)
      if (path && !links.has(path)) {
        links.set(path, {
          type: 'resource_link',
          uri: pathToFileURL(path).href,
          name: basename(path)
        })
      }
    }
    return [...links.values()]
  }

  /** Chats in the order they last sent a prompt, most recent last. */
  private recentChats: string[] = []

  /**
   * For browser requests that name no chat. Only agents that share one browser
   * address (cline) send those, so it must be one of their chats: the running
   * one, or the most recent if none runs. With several running it is ambiguous,
   * so no chat is returned and the tool asks for the browser ID instead of
   * guessing and driving another chat's browser.
   */
  latestActiveChat(): string | undefined {
    const shared = store.getState().chats.filter((c) => !this.processes[c.agent].takesHttpMcp())
    const running = shared.filter((c) => c.running)
    if (running.length === 1) return running[0].id
    if (running.length > 1) return undefined
    const ids = new Set(shared.map((c) => c.id))
    return [...this.recentChats].reverse().find((id) => ids.has(id))
  }

  /**
   * Agents that share one browser address (cline) are told which browser is
   * theirs, so parallel chats each drive their own page.
   */
  private withBrowserId(chatId: string, text: string): string {
    if (this.processes[store.getChat(chatId).agent].takesHttpMcp()) return text
    return `${text}\n\n(Your ${BROWSER_SERVER} browser ID is "${browserId(chatId)}". Pass it as the "browser" argument in every ${BROWSER_SERVER} tool call.)`
  }

  async send(chatId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    this.recentChats = [...this.recentChats.filter((id) => id !== chatId), chatId]
    const chat = store.getChat(chatId)
    if (chat.running) throw new Error('This chat is already running.')
    const isFirst = !store.getMessages(chatId).some((i) => i.kind === 'user')
    store.updateChat(chatId, {
      running: true,
      updatedAt: Date.now(),
      ...(isFirst && !chat.renamed
        ? { title: (text.split('\n')[0] || attachments[0]?.name || 'New chat').slice(0, 60) }
        : {})
    })
    this.events.item(
      chatId,
      store.upsertItem(chatId, {
        kind: 'user',
        id: crypto.randomUUID(),
        text,
        ...(attachments.length
          ? { attachments: attachments.map((a) => ({ name: a.name, image: isImage(a) })) }
          : {})
      })
    )
    this.events.stateChanged()

    try {
      let prompt = this.withBrowserId(
        chatId,
        this.expandBrowserTag(chatId, this.expandSkill(chatId, text))
      )
      let blocks = [...this.fileLinks(chatId, text), ...(await attachmentBlocks(attachments))]
      if (TEXT_ONLY_PROMPTS.has(chat.agent)) {
        prompt = await withFilePaths(prompt, attachments)
        blocks = []
      }
      const response = await this.processes[chat.agent].prompt(chatId, prompt, blocks)
      if (response.stopReason === 'refusal' || response.stopReason === 'max_tokens') {
        this.events.item(
          chatId,
          store.upsertItem(chatId, {
            kind: 'error',
            id: crypto.randomUUID(),
            text: `Stopped: ${response.stopReason.replace('_', ' ')}.`
          })
        )
      }
    } catch (error) {
      this.events.item(
        chatId,
        store.upsertItem(chatId, {
          kind: 'error',
          id: crypto.randomUUID(),
          text: errorMessage(error)
        })
      )
    } finally {
      if (store.getState().chats.some((c) => c.id === chatId)) {
        store.updateChat(chatId, { running: false, updatedAt: Date.now() })
        this.events.stateChanged()
      }
    }
  }

  cancel(chatId: string): Promise<void> {
    return this.processes[store.getChat(chatId).agent].cancel(chatId)
  }

  setOption(chatId: string, optionId: string, value: string): Promise<void> {
    return this.processes[store.getChat(chatId).agent].applyOption(chatId, optionId, value)
  }

  resolvePermission(chatId: string, permissionId: string, optionId: string, auto = false): void {
    const pending = this.permissions.get(permissionId)
    if (!pending) return
    this.permissions.delete(permissionId)
    pending.resolve({ outcome: { outcome: 'selected', optionId } })
    this.processes[store.getChat(chatId).agent].resolvePermissionItem(
      chatId,
      permissionId,
      optionId,
      auto
    )
  }

  /** Turn bypass mode on or off. Turning it on also approves requests already waiting. */
  setBypassPermissions(chatId: string, enabled: boolean): void {
    store.updateChat(chatId, { bypassPermissions: enabled })
    this.events.stateChanged()
    if (!enabled) return
    for (const [permissionId, pending] of this.permissions) {
      if (pending.chatId !== chatId) continue
      const item = store.findItem(chatId, permissionId)
      const optionId = item?.kind === 'permission' ? bypassOption(item.options) : undefined
      if (optionId) this.resolvePermission(chatId, permissionId, optionId, true)
    }
  }

  stopAll(): void {
    for (const agentProcess of Object.values(this.processes)) agentProcess.stop()
  }
}
