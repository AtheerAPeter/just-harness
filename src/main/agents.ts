import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { pathToFileURL } from 'node:url'
import { Readable, Writable } from 'node:stream'
import type * as acp from '@agentclientprotocol/sdk'
import type {
  Attachment,
  BrowserState,
  OpenChatResult,
  AgentCommand,
  AgentId,
  AgentModels,
  AgentOption,
  AgentStatus,
  Chat,
  ChatItem,
  ChatSender,
  ToolStatus
} from '../shared/types'
import { modelOptions, type ModelSource } from '../shared/types'
import * as store from './store'
import {
  browserId,
  browserMcpServer,
  BROWSER_GUIDANCE,
  chatsMcpServer,
  SERVER_NAME as BROWSER_SERVER
} from './browser-mcp'
import {
  chatKey,
  CHATS_GUIDANCE,
  fromChatPrompt,
  MAX_FROM_CHATS,
  SERVER_NAME as CHATS_SERVER,
  type ChatsApi
} from './chats-mcp'
import { listSkills } from './skills'
import { resolveProjectFile } from './files'
import { formatRaw, limitOutput } from './tool-output'
import { loadShellPath } from './shell-env'
import { withTimeout } from './page-driver'
import {
  bypassOption,
  emitItem,
  requestPermission,
  type AgentEvents,
  type Permissions
} from './permissions'
import { chatPreview } from './preview'
import { HarnessAgent } from './harness/agent'
import { COMPACT_AT, formatTokens } from './harness/compaction'
import { stopLeftRunning } from './harness/tools'
import { closeMcp } from './harness/mcp'
import { isHarnessAgent, type HarnessAgentId, type Provider } from './harness/provider'
import { commandCode } from './harness/commandcode'
import { openCode } from './harness/opencode'
import { cline } from './harness/cline'

/** Agents run as a CLI over ACP; the app's own harness agents are not. */
type AcpAgent = Exclude<AgentId, HarnessAgentId>

/** The provider APIs the app's own harness runs on. */
const PROVIDERS: Provider[] = [commandCode, openCode, cline]

const COMMANDS: Record<AcpAgent, { command: string; args: string[] }> = {
  opencode: { command: 'opencode', args: ['acp'] },
  cline: { command: 'cline', args: ['--acp'] },
  commandcode: { command: 'cmd', args: ['acp'] }
}

/**
 * Agents whose ACP process serves a single project folder: `cmd acp` refuses
 * sessions for any folder other than its first. They get one process per project.
 */
const PROCESS_PER_PROJECT = new Set<AgentId>(['commandcode'])

/**
 * An agent process with no prompt running is stopped after this long. Agents
 * hold 200+ MB each; chats reconnect with session/load when used again.
 */
const IDLE_STOP_MS = 5 * 60_000

/**
 * How long Stop waits for the agent to end the turn. An agent that has not by
 * then is stuck, so it is restarted; its chats reload their sessions.
 */
const CANCEL_TIMEOUT_MS = 10_000

/**
 * A turn the agent sends nothing in, not even a retry notice or a permission
 * request, is silent because the provider or the process wedged. Streaming
 * back again is impossible until the turn ends, so the process is restarted:
 * the running turn ends with an error, and the chat reloads its session when
 * the next message is sent. A permission prompt pauses the count (the user
 * decides when the turn continues); every other message from the agent
 * restarts it.
 */
const STALL_TIMEOUT_MS = stallTimeout()
const STALL_CHECK_MS = Math.min(Math.floor(STALL_TIMEOUT_MS / 3), 30_000)

/** The stall limit, overridable for testing. */
function stallTimeout(): number {
  const override = Number.parseInt(process.env.JUST_HARNESS_STALL_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(override) && override > 1000 ? override : 5 * 60_000
}

/** How long opening a chat (starting the agent, loading the session) may take. */
const OPEN_TIMEOUT_MS = 90_000

/** How long a stopped agent gets to exit before it is killed. */
const KILL_GRACE_MS = 2_000

/** How much of an agent's stderr is kept, to explain a crash. */
const STDERR_KEPT = 4096
const STDERR_SHOWN_LINES = 12

/** The command that signs each agent in, for its "authentication required" error. */
const LOGIN_COMMANDS: Record<AgentId, string> = {
  opencode: 'opencode auth login',
  cline: 'cline auth',
  commandcode: 'cmd login',
  'commandcode-api': 'cmd login',
  'opencode-api': 'opencode auth login',
  'cline-api': 'cline auth'
}

/**
 * The ACP SDK at runtime. It takes ~150 ms to load, so it is imported when the
 * first agent starts instead of at launch; everything that uses it runs after.
 */
let sdk: typeof acp | undefined

async function loadSdk(): Promise<typeof acp> {
  sdk ??= await import('@agentclientprotocol/sdk')
  return sdk
}

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

/**
 * Commands an agent runs but does not list over ACP: opencode compacts the
 * session when a prompt starts with /compact.
 */
const UNLISTED_COMMANDS: Record<AcpAgent, AgentCommand[]> = {
  opencode: [{ name: 'compact', description: 'Summarize older messages to free up context' }],
  cline: [],
  commandcode: []
}

/** A prompt asking to compact the conversation. */
const COMPACT = /^\/compact(\s|$)/

const HARNESS_NO_COMPACTION = `The app's own agents compact the conversation on their own when it reaches ${formatTokens(COMPACT_AT)} tokens. They have no command to do it now.`

/** What /compact shows for agents that cannot compact on request. */
const NO_COMPACTION: Partial<Record<AgentId, string>> = {
  // Cline compacts on its own when its context fills up. Its ACP mode has no
  // command for it: the text would reach the model as an ordinary message.
  cline:
    'Cline compacts the conversation on its own when its context fills up. It has no command to do it now.',
  'commandcode-api': HARNESS_NO_COMPACTION,
  'opencode-api': HARNESS_NO_COMPACTION,
  'cline-api': HARNESS_NO_COMPACTION
}

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

/** ACP's error code for an unknown session (RequestError.resourceNotFound). */
const RESOURCE_NOT_FOUND = -32002

/** ACP's error code for "authentication required" (RequestError.authRequired). */
const AUTH_REQUIRED = -32000

/** How a turn ended, for what is shown about it afterwards. */
type TurnOutcome = 'done' | 'stopped' | 'failed'

/** The last line of a provider-retry notice, by how the turn ended. */
const RETRY_OUTCOMES: Record<TurnOutcome, string> = {
  done: 'A retry got through.',
  stopped: 'Stopped while retrying.',
  failed: 'Retrying did not help.'
}

/** Chats always run in the agent's build mode; plan mode is not offered. */
const BUILD_MODE: Record<AcpAgent, string> = {
  opencode: 'build',
  cline: 'act',
  commandcode: 'default'
}

/** What the manager needs from an agent: a CLI's ACP process, or the built-in harness. */
interface AgentBackend {
  readonly agent: AgentId
  ensureSession(chatId: string): Promise<string>
  getOptions(chatId: string): AgentOption[] | undefined
  getCommands(chatId: string): AgentCommand[]
  listModels(cwd: string): Promise<ModelSource[]>
  applyOption(chatId: string, optionId: string, value: string): Promise<void>
  release(chatId: string): Promise<void>
  prompt(
    chatId: string,
    text: string,
    attachments?: acp.ContentBlock[]
  ): Promise<acp.PromptResponse>
  endTurn(chatId: string, outcome: TurnOutcome): void
  cancel(chatId: string): Promise<void>
  explain(error: unknown): Promise<unknown>
  /** The turn is alive (a permission was answered); agents without a turn watchdog leave it out. */
  touchActivity?(chatId: string): void
  resolvePermissionItem(chatId: string, id: string, resolved: string, auto?: boolean): void
  stop(): void
}

/** One started agent process. A stuck one is replaced while it is still exiting. */
interface Run {
  child: ChildProcess
  connection: acp.ClientConnection
  /** Resolves with why the process ended, once it has. */
  exited: Promise<string>
  /** Why it is being stopped, told to the turns it ends. Unset for a crash. */
  exitReason?: string
  /** The end of its stderr, to explain a crash. */
  stderr: string
}

class AgentProcess implements AgentBackend {
  /** The latest process; `connection` is set once it has initialized. */
  private run?: Run
  /** The latest process, kept after it exits so its failed requests can say why. */
  private lastRun?: Run
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
  /** The agent's model lists as sessions last reported them, for the model picker. */
  private modelSources?: ModelSource[]
  private listingModels?: Promise<ModelSource[]>
  /**
   * Slash commands per ACP session id. Keyed by session because agents announce
   * them before the session/new response tells us which chat the session is for.
   */
  private commands = new Map<string, AgentCommand[]>()
  /** Stops a prompt still waiting for its session, per chat; see prompt(). */
  private stopBeforeSend = new Map<string, () => void>()
  /** The notice reporting provider retries in the current turn, per chat. */
  private retryNotices = new Map<string, { id: string; message: string }>()
  /** Turns the agent is working on, per chat, so Stop can tell when one outlives it. */
  private turns = new Map<string, symbol>()
  /** When each chat last got anything from its agent, for the stall watchdog. */
  private activity = new Map<string, number>()
  private activePrompts = 0
  private idleTimer?: NodeJS.Timeout

  constructor(
    readonly agent: AcpAgent,
    private readonly events: AgentEvents,
    private readonly permissions: Permissions,
    /** Set when this process serves only one project (see PROCESS_PER_PROJECT). */
    readonly projectId?: string
  ) {}

  /** Whether the chat runs in this process. */
  private owns(chatId: string): boolean {
    const chat = store.getChat(chatId)
    return chat.agent === this.agent && (!this.projectId || chat.projectId === this.projectId)
  }

  async connect(): Promise<acp.ClientConnection> {
    if (this.connection) return this.connection
    if (!this.starting) {
      const starting = this.start().finally(() => {
        if (this.starting === starting) this.starting = undefined
      })
      this.starting = starting
    }
    return this.starting
  }

  private async start(): Promise<acp.ClientConnection> {
    const { client, methods, ndJsonStream, PROTOCOL_VERSION } = await loadSdk()
    await loadShellPath()
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

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    )
    const connection = client({ name: 'just-harness' })
      .onNotification(methods.client.session.update, (ctx) => this.onUpdate(ctx.params))
      .onRequest(methods.client.session.requestPermission, (ctx) => this.onPermission(ctx.params))
      .connect(stream)

    let ended: (message: string) => void = () => undefined
    const run: Run = {
      child,
      connection,
      exited: new Promise((resolve) => (ended = resolve)),
      stderr: ''
    }
    child.stderr!.on('data', (data) => {
      console.error(`[${this.agent}] ${String(data).trimEnd()}`)
      run.stderr = (run.stderr + String(data)).slice(-STDERR_KEPT)
    })
    child.once('exit', (code, signal) => {
      console.error(`[${this.agent}] exited (${signal ?? code})`)
      const message = this.exitMessage(run, code, signal)
      connection.close(new Error(message))
      // A replaced process (stuck while starting) owns none of the current state.
      if (this.run === run) this.onExit()
      ended(message)
    })
    this.run = run
    this.lastRun = run

    const initResult = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'just-harness', version: '1.0.0' }
    })
    if (this.run !== run) throw new Error(`${this.agent} was restarted.`)
    this.initResult = initResult
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
    this.run = undefined
    this.connection = undefined
    this.liveSessions.clear()
    this.loadingSessions.clear()
    this.commands.clear()
    for (const [id, pending] of this.permissions) {
      if (this.owns(pending.chatId)) {
        this.permissions.delete(id)
        this.resolvePermissionItem(pending.chatId, id, 'cancelled')
      }
    }
    this.events.stateChanged()
  }

  private exitMessage(run: Run, code: number | null, signal: NodeJS.Signals | null): string {
    if (run.exitReason) return run.exitReason
    const how = signal ? `was ended by ${signal}` : `exited with code ${code}`
    const output = stderrExcerpt(run.stderr)
    return `${this.agent} stopped unexpectedly: it ${how}.${output ? `\n\nIts last output:\n${output}` : ''}`
  }

  stop(reason = `${this.agent} was stopped.`): void {
    const run = this.run
    if (!run) return
    run.exitReason = reason
    const { child } = run
    child.kill()
    // A stuck agent can ignore SIGTERM.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, KILL_GRACE_MS).unref()
  }

  /**
   * Whether this agent takes HTTP MCP servers in session/new (opencode). Cline
   * does not, so the browser tools are registered in its own config instead.
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
    this.rememberModels(options)
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
      // Without a limit, an open that never answers would hold every later
      // message in this chat. Giving up stops the open at its next step.
      const abandoned = new AbortController()
      pending = withTimeout(this.openSession(chatId, abandoned.signal), OPEN_TIMEOUT_MS, () => {
        abandoned.abort()
        const message = `${this.agent} did not open this chat within ${OPEN_TIMEOUT_MS / 1000} seconds.`
        // Stuck while starting: every chat would wait on the same start. Kill it
        // and let go of it, so the next message starts a fresh process.
        if (!this.connection) {
          this.stop(`${message} It was restarted.`)
          this.starting = undefined
        }
        return new Error(`${message} Send your message again to retry.`)
      }).finally(() => {
        this.opening.delete(chatId)
        this.scheduleIdleStop()
      })
      this.opening.set(chatId, pending)
    }
    return pending
  }

  private async openSession(chatId: string, signal: AbortSignal): Promise<string> {
    const connection = await this.connect()
    const { methods } = await loadSdk()
    signal.throwIfAborted()
    const requestOptions = { cancellationSignal: signal }
    const chat = store.getChat(chatId)
    const cwd = store.getProject(chat.projectId).path
    // Agents that take HTTP MCP servers over ACP get the browser and chat tools here.
    // Cline's ACP mode ignores session MCP servers; they are registered in cline's
    // own config instead (see cline-mcp.ts).
    // One shared address for every chat: opencode keeps MCP servers by name for
    // all its sessions, so a per-chat address would be taken over by whichever
    // chat opened last. Chats are told their chat ID instead.
    const mcpServers = this.takesHttpMcp() ? [browserMcpServer(), chatsMcpServer()] : []

    let sessionId: string
    let configOptions: acp.SessionConfigOption[] | null | undefined
    // `chat` is the live store record, so its sessionId changes below; keep the one it had.
    const previousSessionId = chat.sessionId
    const loaded = previousSessionId
      ? await this.loadSession(chatId, previousSessionId, cwd, mcpServers, signal)
      : undefined
    signal.throwIfAborted()
    if (previousSessionId && loaded) {
      sessionId = previousSessionId
      configOptions = loaded.configOptions
    } else {
      const created = await connection.agent.request(
        methods.agent.session.new,
        { cwd, mcpServers },
        requestOptions
      )
      signal.throwIfAborted()
      sessionId = created.sessionId
      configOptions = created.configOptions
      store.updateChat(chatId, { sessionId })
      if (previousSessionId && store.getMessages(chatId).some((i) => i.kind === 'user')) {
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
      const response = await connection.agent.request(
        methods.agent.session.setConfigOption,
        { sessionId, configId: option.id, value },
        requestOptions
      )
      signal.throwIfAborted()
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
    mcpServers: acp.McpServer[],
    signal: AbortSignal
  ): Promise<acp.LoadSessionResponse | undefined> {
    if (!this.initResult?.agentCapabilities?.loadSession) return undefined
    const connection = await this.connect()
    const { methods, RequestError } = await loadSdk()
    this.sessionChats.set(sessionId, chatId)
    this.loadingSessions.add(sessionId)
    try {
      return await connection.agent.request(
        methods.agent.session.load,
        { sessionId, cwd, mcpServers },
        { cancellationSignal: signal }
      )
    } catch (error) {
      if (error instanceof RequestError && error.code === RESOURCE_NOT_FOUND) {
        this.sessionChats.delete(sessionId)
        return undefined
      }
      throw error
    } finally {
      this.loadingSessions.delete(sessionId)
    }
  }

  /** Keep the model list a session reported, so the picker shows it as it is now. */
  private rememberModels(options: AgentOption[]): void {
    const { model, source } = modelOptions(options)
    if (!model) return
    if (!source) {
      this.modelSources = [{ option: model }]
      return
    }
    // One provider's list: the others are read when the picker asks for them.
    this.modelSources = this.modelSources?.map((s) =>
      s.setting?.value === source.currentValue ? { ...s, option: model } : s
    )
  }

  /**
   * The agent's model lists, for the model picker: as sessions last reported
   * them, or read from a session opened just to ask and then dropped.
   */
  listModels(cwd: string): Promise<ModelSource[]> {
    if (this.modelSources) return Promise.resolve(this.modelSources)
    if (!this.listingModels) {
      const listing = withTimeout(
        this.readModels(cwd),
        OPEN_TIMEOUT_MS,
        () =>
          new Error(
            `${this.agent} did not list its models within ${OPEN_TIMEOUT_MS / 1000} seconds.`
          )
      ).finally(() => {
        if (this.listingModels === listing) this.listingModels = undefined
        this.scheduleIdleStop()
      })
      this.listingModels = listing
    }
    return this.listingModels
  }

  private async readModels(cwd: string): Promise<ModelSource[]> {
    const connection = await this.connect()
    const { methods } = await loadSdk()
    const { sessionId, configOptions } = await connection.agent.request(methods.agent.session.new, {
      cwd,
      mcpServers: []
    })
    const initial = normalizeOptions(configOptions ?? [])
    const { model, source } = modelOptions(initial)
    const sources: ModelSource[] = []
    if (model && source) {
      // Each provider has its own models: switch this session through them. The
      // switch stays in the session; the agent's own default is not changed.
      for (const value of source.values) {
        const options =
          value.value === source.currentValue
            ? initial
            : normalizeOptions(
                (
                  await connection.agent.request(methods.agent.session.setConfigOption, {
                    sessionId,
                    configId: source.id,
                    value: value.value
                  })
                ).configOptions
              )
        const listed = modelOptions(options).model
        if (!listed) continue
        sources.push({
          setting: { optionId: source.id, value: value.value, name: value.name },
          option: listed
        })
      }
    } else if (model) {
      sources.push({ option: model })
    }
    // Drop the session so it does not show up in the agent's own history.
    const caps = this.initResult?.agentCapabilities?.sessionCapabilities
    if (caps?.delete) {
      await connection.agent.request(methods.agent.session.delete, { sessionId })
    } else if (caps?.close) {
      await connection.agent.request(methods.agent.session.close, { sessionId })
    }
    this.modelSources ??= sources
    return this.modelSources
  }

  async applyOption(chatId: string, optionId: string, value: string): Promise<void> {
    const sessionId = await this.ensureSession(chatId)
    const connection = await this.connect()
    const { methods } = await loadSdk()
    const response = await connection.agent.request(methods.agent.session.setConfigOption, {
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
    const connection = this.connection
    if (!chat.sessionId || !connection) return
    const sessionId = chat.sessionId
    const { methods } = await loadSdk()
    const caps = this.initResult?.agentCapabilities?.sessionCapabilities
    const empty = !store.getMessages(chatId).some((i) => i.kind === 'user')
    const wasLive = this.isLive(sessionId)
    this.liveSessions.delete(sessionId)
    this.sessionChats.delete(sessionId)
    this.commands.delete(sessionId)
    if (empty && caps?.delete) {
      await connection.agent.request(methods.agent.session.delete, { sessionId })
    } else if (wasLive && caps?.close) {
      await connection.agent.request(methods.agent.session.close, { sessionId })
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
    this.retryNotices.delete(chatId)
    const turn = Symbol(chatId)
    let stopped = false
    const stop = new Promise<undefined>((resolve) =>
      this.stopBeforeSend.set(chatId, () => {
        stopped = true
        resolve(undefined)
      })
    )
    try {
      // Opening the session can take a while (starting the agent, loading a long
      // chat). Stop must not wait for it: the session keeps opening, unused.
      const sessionId = await Promise.race([this.ensureSession(chatId), stop])
      if (!sessionId) return { stopReason: 'cancelled' }
      const connection = await this.connect()
      const { methods } = await loadSdk()
      if (stopped) return { stopReason: 'cancelled' }
      this.stopBeforeSend.delete(chatId)
      this.turns.set(chatId, turn)
      // The turn's own clock: silence from now on is the agent's silence.
      this.activity.set(chatId, Date.now())
      const pending = connection.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text }, ...attachments]
      })
      const watchdog = setInterval(() => this.stopIfStalled(chatId, turn), STALL_CHECK_MS)
      // A turn ends by the agent's response, its exit, or the stall watchdog;
      // the watchdog must not outlive any of them.
      return await pending.finally(() => clearInterval(watchdog))
    } catch (error) {
      throw await this.explain(error)
    } finally {
      this.stopBeforeSend.delete(chatId)
      this.activity.delete(chatId)
      if (this.turns.get(chatId) === turn) this.turns.delete(chatId)
      this.activePrompts--
      this.scheduleIdleStop()
    }
  }

  /**
   * A turn whose agent has sent nothing for ages is hanging: say so and
   * restart the process. Killing the child closes the connection, which
   * rejects the prompt request, which ends the turn with the reason.
   */
  private stopIfStalled(chatId: string, turn: symbol): void {
    if (this.turns.get(chatId) !== turn) return
    // An unanswered permission request means the agent is waiting for the user.
    if ([...this.permissions.values()].some((p) => p.chatId === chatId)) return
    const last = this.activity.get(chatId)
    if (last === undefined || Date.now() - last <= STALL_TIMEOUT_MS) return
    this.stop(
      `${this.agent} sent nothing for ${STALL_TIMEOUT_MS / 1000} seconds, so it was restarted. Send your message again to continue.`
    )
  }

  /** Note that the chat just got something from the agent (or for it), mid-turn. */
  touchActivity(chatId: string): void {
    this.activity.set(chatId, Date.now())
  }

  /**
   * A dying agent closes its pipes before it is seen to exit, so requests fail
   * with a bare "connection closed". Wait briefly for the exit to say why.
   */
  async explain(error: unknown): Promise<unknown> {
    const run = this.lastRun
    if (!run?.connection.signal.aborted) return error
    return withTimeout(
      run.exited.then((message) => new Error(message)),
      KILL_GRACE_MS,
      () => new Error()
    ).catch(() => error)
  }

  /**
   * Close out a finished turn: tool calls the agent left open will not finish,
   * and a provider-retry notice says how the retries ended.
   */
  endTurn(chatId: string, outcome: TurnOutcome): void {
    for (const item of store.getMessages(chatId)) {
      if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'in_progress')) {
        this.emit(chatId, { ...item, status: 'interrupted' })
      }
    }
    const notice = this.retryNotices.get(chatId)
    if (notice) {
      this.retryNotices.delete(chatId)
      this.emit(chatId, {
        kind: 'notice',
        id: notice.id,
        text: `The provider failed: ${notice.message} ${RETRY_OUTCOMES[outcome]}`
      })
    }
  }

  async cancel(chatId: string): Promise<void> {
    // Not sent to the agent yet: drop it here. Once sent, session/cancel stops it.
    const stopBeforeSend = this.stopBeforeSend.get(chatId)
    if (stopBeforeSend) return stopBeforeSend()
    const sessionId = store.getChat(chatId).sessionId
    const connection = this.connection
    if (!connection || !this.isLive(sessionId)) return
    const { methods } = await loadSdk()
    for (const [id, pending] of this.permissions) {
      if (pending.chatId === chatId) {
        pending.resolve({ outcome: { outcome: 'cancelled' } })
        this.permissions.delete(id)
        this.resolvePermissionItem(chatId, id, 'cancelled')
      }
    }
    await connection.agent.notify(methods.agent.session.cancel, { sessionId })
    // The agent must end the turn now. One that does not is stuck: restarting
    // it ends the turn, and the next message reloads the session.
    const turn = this.turns.get(chatId)
    if (!turn) return
    setTimeout(() => {
      if (this.turns.get(chatId) !== turn) return
      this.stop(
        `${this.agent} did not stop within ${CANCEL_TIMEOUT_MS / 1000} seconds, so it was restarted. Send your message again to continue.`
      )
    }, CANCEL_TIMEOUT_MS)
  }

  private emit(chatId: string, item: ChatItem): void {
    emitItem(this.events, this.permissions, chatId, item)
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
    // The agent spoke, and its turn is paused on the answer.
    this.touchActivity(chatId)
    return requestPermission(this.events, this.permissions, chatId, params.toolCall, params.options)
  }

  private onUpdate(params: acp.SessionNotification): void {
    const chatId = this.sessionChats.get(params.sessionId)
    // Any message from the agent, even one that is dropped, says it is alive.
    if (chatId) this.touchActivity(chatId)
    if (params.update.sessionUpdate === 'available_commands_update') {
      const listed = params.update.availableCommands.map((c) => ({
        name: c.name,
        description: c.description
      }))
      const commands = [
        ...listed,
        ...UNLISTED_COMMANDS[this.agent].filter((c) => !listed.some((l) => l.name === c.name))
      ]
      this.commands.set(params.sessionId, commands)
      if (chatId) this.events.commands(chatId, commands)
      return
    }
    if (this.loadingSessions.has(params.sessionId)) return
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
        const text = formatToolContent(update.content) ?? formatRaw(update.rawOutput)
        const output = text === undefined ? undefined : limitOutput(text)
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
        const retry = providerRetry(update._meta)
        if (retry) {
          // Without this the turn looks dead while the agent waits to retry.
          const id = this.retryNotices.get(chatId)?.id ?? crypto.randomUUID()
          this.retryNotices.set(chatId, { id, message: retry.message })
          this.emit(chatId, {
            kind: 'notice',
            id,
            text: `The provider failed: ${retry.message} Retrying (attempt ${retry.attempt})…`
          })
        }
        return
      }
      default:
        return
    }
  }
}

/**
 * A retry the agent scheduled after a provider error. Opencode reports them as
 * session_info_update with `_meta["opencode/retry"]`: {attempt, nextRetryAt,
 * error: {type, message}}, and null once the retry starts. Cline reports none.
 */
function providerRetry(
  meta: Record<string, unknown> | null | undefined
): { attempt: number; message: string } | undefined {
  const retry = meta?.['opencode/retry'] as
    { attempt?: unknown; error?: { message?: unknown } | string } | null | undefined
  if (!retry || typeof retry.attempt !== 'number') return undefined
  const error = typeof retry.error === 'string' ? retry.error : retry.error?.message
  const message = typeof error === 'string' && error.trim() ? error.trim() : 'unknown error.'
  return { attempt: retry.attempt, message: /[.!?]$/.test(message) ? message : `${message}.` }
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

async function cliVersion(agent: AcpAgent): Promise<string | undefined> {
  await loadShellPath()
  return new Promise((resolve) => {
    execFile(COMMANDS[agent].command, ['--version'], { timeout: 10_000 }, (error, stdout) =>
      resolve(error ? undefined : stdout.trim().split('\n').pop())
    )
  })
}

function errorMessage(error: unknown, agent: AgentId): string {
  if (sdk && error instanceof sdk.RequestError) {
    // Opencode reports a provider that refuses the request (not signed in, a
    // model the plan or country does not include) as this error, without the reason.
    if (error.code === AUTH_REQUIRED) {
      return `The provider refused access. If ${agent} is not signed in, run \`${LOGIN_COMMANDS[agent]}\` in a terminal; otherwise try another model.`
    }
    // Agents put their own text after JSON-RPC's generic "Internal error: ".
    const message = error.message.replace(/^Internal error: (?=\S)/, '')
    const data = error.data as { message?: string } | undefined
    return data?.message ? `${message}: ${data.message}` : message
  }
  return error instanceof Error ? error.message : String(error)
}

/** Messages from other chats a chat got since the user last wrote in it. */
function fromChatsSinceUser(chatId: string): number {
  const items = store.getMessages(chatId)
  let count = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind !== 'user') continue
    if (!item.from) break
    count++
  }
  return count
}

/**
 * The end of an agent's stderr, to explain a crash: the last lines, with the
 * home folder shortened and anything that looks like a credential hidden.
 */
function stderrExcerpt(text: string): string {
  return text
    .trim()
    .split('\n')
    .slice(-STDERR_SHOWN_LINES)
    .join('\n')
    .replaceAll(homedir(), '~')
    .replace(
      /(bearer\s+|(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',]+/gi,
      '$1<hidden>'
    )
}

export class AgentManager implements ChatsApi {
  private readonly permissions: Permissions = new Map()
  /** Started on first use: one per agent, or per agent and project (see PROCESS_PER_PROJECT). */
  private readonly processes = new Map<string, AgentProcess>()
  private readonly statuses = new Map<AgentId, Promise<AgentStatus>>()
  /** The app's own agents, one per provider API, each serving all its chats. */
  private readonly harness = new Map<HarnessAgentId, HarnessAgent>()

  constructor(
    private readonly events: AgentEvents,
    /** The page open in the built-in browser, for `@browser` messages. */
    private readonly browserPage: (chatId: string) => BrowserState | undefined
  ) {
    for (const provider of PROVIDERS) {
      this.harness.set(provider.id, new HarnessAgent(provider, events, this.permissions))
    }
  }

  /** The agent the chat runs in. */
  private processFor(chatId: string): AgentBackend {
    const { agent, projectId } = store.getChat(chatId)
    return this.process(agent, projectId)
  }

  private process(agent: AgentId, projectId: string): AgentBackend {
    if (isHarnessAgent(agent)) return this.harness.get(agent)!
    const perProject = PROCESS_PER_PROJECT.has(agent)
    const key = perProject ? `${agent}:${projectId}` : agent
    let agentProcess = this.processes.get(key)
    if (!agentProcess) {
      agentProcess = new AgentProcess(
        agent,
        this.events,
        this.permissions,
        perProject ? projectId : undefined
      )
      this.processes.set(key, agentProcess)
    }
    return agentProcess
  }

  /** Whether the CLI is installed, and its version. */
  status(agent: AgentId): Promise<AgentStatus> {
    // The harness needs only the provider's sign-in; it is checked each time, so signing in shows at once.
    if (isHarnessAgent(agent)) {
      const provider = PROVIDERS.find((p) => p.id === agent)!
      return provider.signedIn().then((signedIn) =>
        signedIn
          ? { agent, available: true, version: 'API' }
          : {
              agent,
              available: false,
              error: `${provider.name} is not signed in. ${provider.signIn}`
            }
      )
    }
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

  /** The models an agent offers in a project, for picking one before a chat uses that agent. */
  async models(agent: AgentId, projectId: string): Promise<AgentModels> {
    const agentProcess = this.process(agent, projectId)
    try {
      return { sources: await agentProcess.listModels(store.getProject(projectId).path) }
    } catch (error) {
      return { sources: [], error: errorMessage(await agentProcess.explain(error), agent) }
    }
  }

  /** Open the chat's session (starting the agent if needed) and return its options. */
  async open(chatId: string): Promise<OpenChatResult> {
    const agentProcess = this.processFor(chatId)
    try {
      await agentProcess.ensureSession(chatId)
      return {
        options: agentProcess.getOptions(chatId) ?? [],
        commands: agentProcess.getCommands(chatId)
      }
    } catch (error) {
      const reason = await agentProcess.explain(error)
      return { options: [], commands: [], error: errorMessage(reason, agentProcess.agent) }
    }
  }

  /** Switch a chat that has not started yet to another agent. */
  async changeAgent(
    chatId: string,
    agent: AgentId,
    settings: Record<string, string>
  ): Promise<void> {
    if (store.getMessages(chatId).some((i) => i.kind === 'user')) {
      throw new Error('The agent cannot change after the chat has started.')
    }
    await this.processFor(chatId).release(chatId)
    store.updateChat(chatId, { agent, settings, sessionId: undefined })
    this.events.stateChanged()
  }

  async deleteChat(chatId: string): Promise<void> {
    this.inbox.delete(chatId)
    const chat = store.getChat(chatId)
    if (chat.running) await this.cancel(chatId)
    await this.processFor(chatId).release(chatId)
    store.removeChat(chatId)
    this.events.stateChanged()
  }

  /**
   * Opencode and cline do not expose skills as slash commands, so `/skill-name rest`
   * becomes an explicit request to use that skill. Agent commands (including
   * Command Code's skills, which it lists as commands) are passed through as typed.
   * Any skill on the machine can be used; ones the agent does not discover itself
   * (e.g. ~/.claude/skills for cline) are passed by file path.
   */
  private expandSkill(chatId: string, text: string): string {
    const match = text.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/)
    if (!match) return text
    const [, name, rest] = match
    const chat = store.getChat(chatId)
    if (
      this.processFor(chatId)
        .getCommands(chatId)
        .some((c) => c.name === name)
    )
      return text
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
    // The harness has the guidance in its system prompt already.
    if (isHarnessAgent(store.getChat(chatId).agent)) {
      return `${text}\n\n@browser: use the browser tools for this.${where}`
    }
    return `${text}\n\n@browser: use the ${BROWSER_SERVER} tools for this.${where} ${BROWSER_GUIDANCE}`
  }

  /**
   * `@chats` asks the agent to split the work into new chats. As with
   * `@browser`, the agent sees only text, so say which tools that means.
   */
  private expandChatsTag(chatId: string, text: string): string {
    if (!/(^|\s)@chats\b/.test(text)) return text
    const ask =
      '@chats: do this with new chats. Start one with start_chat for each part that can be done on its own, each with a complete task, then tell me what you started and end your turn. Their reports arrive here as new messages.'
    // The harness has the guidance in its system prompt already.
    if (isHarnessAgent(store.getChat(chatId).agent)) return `${text}\n\n${ask}`
    return `${text}\n\n${ask} start_chat is one of the ${CHATS_SERVER} tools. ${CHATS_GUIDANCE}`
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
   * For browser requests that name no chat: the running chat, or the most recent
   * if none runs. With several running it is ambiguous, so no chat is returned
   * and the tool asks for the browser ID instead of guessing and driving
   * another chat's browser.
   */
  latestActiveChat(): string | undefined {
    const running = store.getState().chats.filter((c) => c.running)
    if (running.length === 1) return running[0].id
    if (running.length > 1) return undefined
    return this.recentChats.at(-1)
  }

  /**
   * Every chat is told its ID, which picks its own browser, so parallel chats
   * never share a page, and names it to the other chats; and its private key
   * for the chat tools, which proves who calls.
   */
  private withChatId(chatId: string, text: string): string {
    return `${text}\n\n(Your Just Harness chat ID is "${browserId(chatId)}". Pass it as the "browser" argument in every ${BROWSER_SERVER} tool call. Pass your private key "${chatKey(chatId)}" as "chat" in every ${CHATS_SERVER} tool call, and never put it in a message.)`
  }

  /** Send a message from the user, or, with `from`, from another chat's agent. */
  async send(
    chatId: string,
    text: string,
    attachments: Attachment[] = [],
    from?: ChatSender
  ): Promise<void> {
    this.recentChats = [...this.recentChats.filter((id) => id !== chatId), chatId]
    const chat = store.getChat(chatId)
    if (chat.running) throw new Error('This chat is already running.')
    const compact = !from && COMPACT.test(text.trim())
    const noCompaction = compact ? NO_COMPACTION[chat.agent] : undefined
    if (noCompaction) {
      for (const item of [
        { kind: 'user', id: crypto.randomUUID(), text },
        { kind: 'notice', id: crypto.randomUUID(), text: noCompaction }
      ] as const) {
        this.events.item(chatId, store.upsertItem(chatId, item))
      }
      return
    }
    const isFirst = !store.getMessages(chatId).some((i) => i.kind === 'user')
    store.updateChat(chatId, {
      running: true,
      updatedAt: Date.now(),
      ...(isFirst && !chat.renamed
        ? { title: (text.split('\n')[0] || attachments[0]?.name || 'New chat').slice(0, 60) }
        : {})
    })
    const sentAt = Date.now()
    const userItem: Extract<ChatItem, { kind: 'user' }> = {
      kind: 'user',
      id: crypto.randomUUID(),
      text,
      sentAt,
      ...(attachments.length
        ? { attachments: attachments.map((a) => ({ name: a.name, image: isImage(a) })) }
        : {}),
      ...(from ? { from } : {})
    }
    this.events.item(chatId, store.upsertItem(chatId, userItem))
    store.updateChat(chatId, { preview: chatPreview(store.getMessages(chatId)) })
    this.events.stateChanged()

    let outcome: TurnOutcome = 'failed'
    try {
      let prompt = from
        ? fromChatPrompt(from.title, browserId(from.chatId), text, isFirst)
        : this.expandChatsTag(chatId, this.expandBrowserTag(chatId, this.expandSkill(chatId, text)))
      // The harness passes each chat's ID to the tools itself.
      if (!isHarnessAgent(chat.agent)) prompt = this.withChatId(chatId, prompt)
      let blocks = [...this.fileLinks(chatId, text), ...(await attachmentBlocks(attachments))]
      if (TEXT_ONLY_PROMPTS.has(chat.agent)) {
        prompt = await withFilePaths(prompt, attachments)
        blocks = []
      }
      const response = await this.processFor(chatId).prompt(chatId, prompt, blocks)
      outcome = response.stopReason === 'cancelled' ? 'stopped' : 'done'
      // opencode reports nothing while it compacts, so say when it is done.
      if (compact && response.stopReason === 'end_turn') {
        this.events.item(
          chatId,
          store.upsertItem(chatId, {
            kind: 'notice',
            id: crypto.randomUUID(),
            text: 'Compacted the conversation: older messages are now a summary, freeing up context.'
          })
        )
      }
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
          text: errorMessage(error, chat.agent)
        })
      )
    } finally {
      if (store.getState().chats.some((c) => c.id === chatId)) {
        this.processFor(chatId).endTurn(chatId, outcome)
        // How long the turn took, shown as "Worked for …" above its answer.
        this.events.item(
          chatId,
          store.upsertItem(chatId, { ...userItem, workedMs: Date.now() - sentAt })
        )
        store.updateChat(chatId, {
          running: false,
          updatedAt: Date.now(),
          preview: chatPreview(store.getMessages(chatId))
        })
        this.events.stateChanged()
        this.deliverNext(chatId, outcome)
      }
    }
  }

  // --- Chats that start and message chats (chats-mcp.ts) --------------------

  /** Messages from other chats waiting for the chat's turn to end, oldest first. */
  private readonly inbox = new Map<string, { text: string; from: ChatSender }[]>()

  /** The chat of the project a chat ID names: the chats a chat can reach. */
  private chatById(id: string, projectId: string): Chat {
    const chat = store
      .getState()
      .chats.find((c) => browserId(c.id) === id && c.projectId === projectId)
    if (chat) return chat
    throw new Error(
      `No chat of this project has the ID "${id}". list_chats shows the running ones.`
    )
  }

  /** The calling chat. It must be working on a turn: a key used between turns does nothing. */
  private caller(chatId: string): Chat {
    const chat = store.getChat(chatId)
    if (!chat.running) {
      throw new Error('Not done: these tools work only while your chat is working on a turn.')
    }
    return chat
  }

  /**
   * Whether `sender` may message `target`. The message runs with the target's
   * permissions, so the target may not have broader ones than the sender, unless
   * it started the sender (sent its first message): a chat can always report
   * back. Checked again on delivery, since permissions can change meanwhile.
   */
  private mayMessage(sender: Chat, target: Chat): boolean {
    const first = store
      .getMessages(sender.id)
      .find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user')
    if (first?.from?.chatId === target.id) return true
    return !(
      (target.bypassPermissions && !sender.bypassPermissions) ||
      (sender.projectOnly && !target.projectOnly)
    )
  }

  /** A new chat like the caller's (agent, model, permissions), working on the task it was sent. */
  startChat(caller: string, prompt: string): { id: string; title: string } {
    const parent = this.caller(caller)
    // Only a turn the user started: a chain of chats ends at the chats it started.
    const turn = store
      .getMessages(caller)
      .findLast((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user')
    if (turn?.from) {
      throw new Error(
        'Not started: another chat started this turn, and only turns the user started can start chats. Do the work yourself.'
      )
    }
    if (!prompt.trim()) throw new Error('"prompt" must describe the task.')
    const chat = store.createChat({
      projectId: parent.projectId,
      agent: parent.agent,
      settings: { ...parent.settings },
      bypassPermissions: parent.bypassPermissions,
      projectOnly: parent.projectOnly
    })
    // Titled from the task before send's first await.
    void this.send(chat.id, prompt, [], { chatId: parent.id, title: parent.title })
    return { id: browserId(chat.id), title: chat.title }
  }

  /** Start a turn in another chat of the caller's project, or queue the message for its next one. */
  message(caller: string, to: string, text: string): 'started' | 'queued' {
    const sender = this.caller(caller)
    const target = this.chatById(to, sender.projectId)
    if (target.id === sender.id) throw new Error(`"${to}" is your own chat ID.`)
    if (!text.trim()) throw new Error('"message" is empty.')
    if (!this.mayMessage(sender, target)) {
      throw new Error(
        `Not sent: chat ${to} has broader permissions than yours, so it does not take messages from you.`
      )
    }
    const queued = this.inbox.get(target.id) ?? []
    if (fromChatsSinceUser(target.id) + queued.length >= MAX_FROM_CHATS) {
      throw new Error(
        `Not sent: chat ${to} has had ${MAX_FROM_CHATS} messages from other chats since the user last wrote in it, the most it takes. Stop messaging it, and tell the user where things stand instead.`
      )
    }
    const from = { chatId: sender.id, title: sender.title }
    if (!target.running) {
      void this.send(target.id, text, [], from)
      return 'started'
    }
    this.inbox.set(target.id, [...queued, { text, from }])
    return 'queued'
  }

  runningChats(caller: string): { id: string; title: string; waiting: boolean; self: boolean }[] {
    const self = this.caller(caller)
    return store
      .getState()
      .chats.filter((c) => c.projectId === self.projectId && c.running)
      .map((c) => ({
        id: browserId(c.id),
        title: c.title,
        waiting: c.waiting === true,
        self: c.id === self.id
      }))
  }

  /**
   * A turn ended: start the next message other chats sent meanwhile. When the
   * user stopped the turn, they are dropped instead, so Stop really stops; so
   * are messages whose sender was deleted, or may no longer message this chat.
   */
  private deliverNext(chatId: string, outcome: TurnOutcome): void {
    const queued = this.inbox.get(chatId)
    if (!queued) return
    this.inbox.delete(chatId)
    const notice = (text: string): void =>
      this.events.item(
        chatId,
        store.upsertItem(chatId, { kind: 'notice', id: crypto.randomUUID(), text })
      )
    if (outcome === 'stopped') {
      const n = queued.length
      notice(
        `${n === 1 ? 'A message' : `${n} messages`} from other chats ${n === 1 ? 'was' : 'were'} not delivered, because the chat was stopped.`
      )
      return
    }
    const target = store.getChat(chatId)
    const kept = queued.filter(({ from }) => {
      const sender = store.getState().chats.find((c) => c.id === from.chatId)
      if (sender && this.mayMessage(sender, target)) return true
      notice(
        sender
          ? `A message from "${from.title}" was not delivered: this chat now has broader permissions than that chat.`
          : `A message from "${from.title}" was not delivered: that chat was deleted.`
      )
      return false
    })
    const [next, ...rest] = kept
    if (!next) return
    if (rest.length > 0) this.inbox.set(chatId, rest)
    void this.send(chatId, next.text, [], next.from)
  }

  cancel(chatId: string): Promise<void> {
    return this.processFor(chatId).cancel(chatId)
  }

  setOption(chatId: string, optionId: string, value: string): Promise<void> {
    return this.processFor(chatId).applyOption(chatId, optionId, value)
  }

  resolvePermission(chatId: string, permissionId: string, optionId: string, auto = false): void {
    const pending = this.permissions.get(permissionId)
    if (!pending) return
    this.permissions.delete(permissionId)
    pending.resolve({ outcome: { outcome: 'selected', optionId } })
    const agentProcess = this.processFor(chatId)
    // The turn resumes past the answer: its silence clock restarts from here.
    agentProcess.touchActivity?.(chatId)
    agentProcess.resolvePermissionItem(chatId, permissionId, optionId, auto)
  }

  /**
   * Set the chat's permission mode, both settings at once. Turning bypass on
   * also approves requests already waiting, except, in project-only mode, ones
   * that reach outside the project: those stay with the user, marked as such.
   */
  setPermissions(
    chatId: string,
    { bypassPermissions, projectOnly }: Pick<Chat, 'bypassPermissions' | 'projectOnly'>
  ): void {
    store.updateChat(chatId, { bypassPermissions, projectOnly })
    this.events.stateChanged()
    if (!bypassPermissions) return
    for (const [permissionId, pending] of this.permissions) {
      if (pending.chatId !== chatId || pending.question) continue
      const item = store.findItem(chatId, permissionId)
      if (item?.kind !== 'permission') continue
      if (projectOnly && pending.outside) {
        if (!item.outside) {
          emitItem(this.events, this.permissions, chatId, { ...item, outside: pending.outside })
        }
        continue
      }
      const optionId = bypassOption(item.options)
      if (optionId) this.resolvePermission(chatId, permissionId, optionId, true)
    }
  }

  /** Stop everything; resolves once the MCP servers the harness started have stopped. */
  stopAll(): Promise<void> {
    for (const agentProcess of this.processes.values()) agentProcess.stop()
    for (const agent of this.harness.values()) agent.stop()
    stopLeftRunning()
    return closeMcp()
  }
}
