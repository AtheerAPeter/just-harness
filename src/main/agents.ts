import { spawn, type ChildProcess } from 'node:child_process'
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
import { AGENTS, modelOptions, senderChat, type ModelSource } from '../shared/types'
import * as store from './store'
import {
  browserId,
  browserMcpEndpoint,
  browserMcpServer,
  BROWSER_GUIDANCE,
  chatsMcpEndpoint,
  chatsMcpServer,
  SERVER_NAME as BROWSER_SERVER
} from './browser-mcp'
import {
  chatKey,
  CHATS_GUIDANCE,
  formatDuration,
  fromChatPrompt,
  MAX_FROM_CHATS,
  SERVER_NAME as CHATS_SERVER,
  type ChatListing,
  type ChatsApi,
  type Timer
} from './chats-mcp'
import { listSkills } from './skills'
import { resolveProjectFile } from './files'
import { formatRaw, limitOutput } from './tool-output'
import { commandVersion, loadShellPath } from './shell-env'
import { withTimeout } from './page-driver'
import {
  bypassOption,
  emitItem,
  requestPermission,
  type AgentEvents,
  type Permissions
} from './permissions'
import { chatPreview } from './preview'
import * as background from './background'
import type { Finished, Running } from './background'
import { HarnessAgent } from './harness/agent'
import { COMPACT_AT, formatTokens } from './harness/compaction'
import { stopLeftRunning } from './harness/tools'
import { closeMcp } from './harness/mcp'
import { isHarnessAgent, type HarnessAgentId, type Provider } from './harness/provider'
import { commandCode } from './harness/commandcode'
import { openCode, opencodeMajor } from './harness/opencode'
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
 * The environment an agent runs in, and whether the app's MCP servers are in
 * its config, so that session/new leaves them out.
 *
 * Opencode gets config of the app's in OPENCODE_CONFIG_CONTENT, applied on top
 * of the user's config, so their own settings stay in effect. It ships a
 * built-in `browser` tool that drives the user's own desktop browser, and
 * models sometimes pick it over the built-in panel, so that is denied.
 * Opencode 2 reads this opencode 1 form too, as a rule denying its `browser`
 * permission.
 *
 * Opencode 2 also gets the app's MCP servers here instead of in session/new.
 * A server added over ACP runs in its Code Mode, where the model calls tools
 * from one `execute` script: the chat shows a script instead of each browser
 * step, and a permission question shows the script instead of the call. Only
 * its config can turn Code Mode off for a server. Opencode 1 has no Code Mode,
 * and its config would refuse the field, so it gets them in session/new.
 */
async function agentEnv(agent: AgentId): Promise<{ env: NodeJS.ProcessEnv; mcpInConfig: boolean }> {
  if (agent !== 'opencode') return { env: process.env, mcpInConfig: false }
  const inline = process.env.OPENCODE_CONFIG_CONTENT
  const config = inline ? (JSON.parse(inline) as Record<string, unknown>) : {}
  config.permission = {
    ...(config.permission as Record<string, unknown> | undefined),
    browser: 'deny'
  }
  const mcpInConfig = ((await opencodeMajor()) ?? 1) >= 2
  if (mcpInConfig) {
    const mcp = (config.mcp ?? {}) as { servers?: Record<string, unknown> }
    const servers = Object.fromEntries(
      (
        [
          [BROWSER_SERVER, browserMcpEndpoint()],
          [CHATS_SERVER, chatsMcpEndpoint()]
        ] as const
      ).map(([name, endpoint]) => [
        name,
        {
          type: 'remote',
          url: endpoint.url,
          headers: { Authorization: `Bearer ${endpoint.token}` },
          oauth: false,
          codemode: false
        }
      ])
    )
    config.mcp = { ...mcp, servers: { ...mcp.servers, ...servers } }
  }
  return {
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    mcpInConfig
  }
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

/** ACP's error code for a request with bad parameters (RequestError.invalidParams). */
const INVALID_PARAMS = -32602

/** ACP's error code for "authentication required" (RequestError.authRequired). */
const AUTH_REQUIRED = -32000

/** How a turn ended, for what is shown about it afterwards. */
/** 'steered': cut short after a step so the messages waiting for it go at once (see steerAfterStep). */
type TurnOutcome = 'done' | 'stopped' | 'failed' | 'steered'

/** The last line of a provider-retry notice, by how the turn ended. */
const RETRY_OUTCOMES: Record<TurnOutcome, string> = {
  done: 'A retry got through.',
  stopped: 'Stopped while retrying.',
  failed: 'Retrying did not help.',
  steered: 'A retry got through.'
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
  /** Whether the app's MCP servers are in the running process's config (see agentEnv). */
  private mcpInConfig = false
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
    /** A step of the chat's turn ended (a tool call finished) and no other is running. */
    private readonly onStepDone: (chatId: string) => void,
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
    const { env, mcpInConfig } = await agentEnv(this.agent)
    this.mcpInConfig = mcpInConfig
    const child = spawn(command, args, {
      cwd: homedir(),
      env,
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
    // Opencode 2 has them in its config already (see agentEnv).
    const mcpServers =
      this.takesHttpMcp() && !this.mcpInConfig ? [browserMcpServer(), chatsMcpServer()] : []

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
      if (error instanceof RequestError && sessionGone(error, sessionId)) {
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
        // A finished call is a point the turn can be cut at without losing work,
        // once no other call of it (agents run some side by side) is still going.
        if (
          (update.status === 'completed' || update.status === 'failed') &&
          !store
            .getMessages(chatId)
            .some(
              (i) => i.kind === 'tool' && (i.status === 'pending' || i.status === 'in_progress')
            )
        ) {
          this.onStepDone(chatId)
        }
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

/**
 * Whether session/load failed because the agent does not have the session.
 * Opencode 1 answers resourceNotFound. Opencode 2 answers invalidParams naming
 * the session, both for one it never stored (every session opencode 1 saved)
 * and for one that belongs to another folder.
 */
function sessionGone(error: acp.RequestError, sessionId: string): boolean {
  if (error.code === RESOURCE_NOT_FOUND) return true
  const data = error.data as { sessionId?: unknown } | undefined
  return error.code === INVALID_PARAMS && data?.sessionId === sessionId
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

type UserItem = Extract<ChatItem, { kind: 'user' }>

/** A message's item, with the names of the files sent with it. */
function newUserItem(text: string, attachments: Attachment[]): UserItem {
  return {
    kind: 'user',
    id: crypto.randomUUID(),
    text,
    ...(attachments.length
      ? { attachments: attachments.map((a) => ({ name: a.name, image: isImage(a) })) }
      : {})
  }
}

/** A message waiting for a busy chat: the user's own, or with `from` another chat's. */
interface Waiting {
  text: string
  attachments: Attachment[]
  from?: ChatSender
}

/** run_in_background asks the user with these, as for a shell command. */
const BACKGROUND_OPTIONS: acp.PermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
]

/** What a chat is told when a command it ran in the background ends. */
function finishedMessage(f: Finished): string {
  const how =
    f.timedOut !== undefined
      ? `was stopped at its timeout of ${formatDuration(f.timedOut * 1000)}`
      : f.code === 0
        ? 'finished'
        : f.code !== null
          ? `failed with exit code ${f.code}`
          : `was stopped by ${f.signal ?? 'a signal'}`
  return [
    `The command you ran in the background (process ${f.pid}) ${how} after ${formatDuration(f.ms)}:`,
    f.command,
    f.output.trim() ? `End of its output:\n${f.output.trimEnd()}` : 'It printed nothing.',
    `Full output: ${f.log}`
  ].join('\n\n')
}

/** Of a chat's last answer, the end a lead chat is sent when it did not report back. */
const LAST_ANSWER_CHARS = 8000

/** How a chat's turn ended, as list_chats shows it. */
type TurnEnd = { outcome: 'done' } | { outcome: 'stopped' } | { outcome: 'failed'; error: string }

/** The answer the agent gave last in its chat's latest turn, if any. */
function lastAnswer(chatId: string): string | undefined {
  const items = store.getMessages(chatId)
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'user') return undefined
    if (item.kind === 'text' && item.text.trim()) return item.text.trim()
  }
  return undefined
}

/** Messages from other chats, commands and timers a chat got since the user last wrote in it. */
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
      this.harness.set(
        provider.id,
        new HarnessAgent(provider, events, this.permissions, (chatId) => this.steer(chatId))
      )
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
        (chatId) => this.steerAfterStep(chatId),
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
      cached = commandVersion(COMMANDS[agent].command).then((version) =>
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

  /**
   * Switch a chat to another agent, as when one provider has hit its limit.
   * The new agent starts a session of its own, without the conversation; a
   * chat that has started tells it on its next message where to read it (see
   * promptFor).
   */
  async changeAgent(
    chatId: string,
    agent: AgentId,
    settings: Record<string, string>
  ): Promise<void> {
    const chat = store.getChat(chatId)
    if (chat.running) throw new Error('Stop the chat before switching agents.')
    const started = store.getMessages(chatId).some((i) => i.kind === 'user')
    const from = chat.agent
    await this.processFor(chatId).release(chatId)
    store.updateChat(chatId, {
      agent,
      settings,
      sessionId: undefined,
      ...(started ? { handoff: chat.handoff ?? from } : {})
    })
    if (started) {
      const label = AGENTS.find((a) => a.id === agent)?.label ?? agent
      this.events.item(
        chatId,
        store.upsertItem(chatId, {
          kind: 'notice',
          id: crypto.randomUUID(),
          text: `Switched to ${label}. It starts without the earlier context, so with your next message it is told to read this chat's saved messages first.`
        })
      )
    }
    this.events.stateChanged()
  }

  async deleteChat(chatId: string): Promise<void> {
    this.inbox.delete(chatId)
    background.stopBackground(chatId)
    this.clearTimer(chatId)
    this.owesReport.delete(chatId)
    this.turnEnds.delete(chatId)
    const chat = store.getChat(chatId)
    if (chat.running) await this.cancel(chatId)
    await this.processFor(chatId).release(chatId)
    this.stopping.delete(chatId)
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

  /**
   * Send a message from the user, or, with `from`, from another chat's agent.
   * The user's message to a working chat waits for it (see wait).
   */
  async send(
    chatId: string,
    text: string,
    attachments: Attachment[] = [],
    from?: ChatSender
  ): Promise<void> {
    this.recentChats = [...this.recentChats.filter((id) => id !== chatId), chatId]
    const chat = store.getChat(chatId)
    if (chat.running) {
      if (from) throw new Error('This chat is already running.')
      this.wait(chatId, text, attachments)
      return
    }
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
    const userItem: UserItem = {
      ...newUserItem(text, attachments),
      sentAt,
      ...(from ? { from } : {})
    }
    this.events.item(chatId, store.upsertItem(chatId, userItem))
    store.updateChat(chatId, { preview: chatPreview(store.getMessages(chatId)) })
    this.events.stateChanged()

    let outcome: TurnOutcome = 'failed'
    let failure: string | undefined
    try {
      const first = await this.promptFor(chatId, text, attachments, from, isFirst)
      // Messages that waited for this turn join it, so a run of follow-ups is
      // taken in one go. The app's own agents take them at their first step.
      const joined = compact || isHarnessAgent(chat.agent) ? [] : await this.steer(chatId)
      const parts = [first, ...joined]
      const response = await this.processFor(chatId).prompt(
        chatId,
        parts.map((p) => p.prompt).join('\n\n'),
        parts.flatMap((p) => p.blocks)
      )
      const steered = this.steering.delete(chatId)
      outcome = response.stopReason !== 'cancelled' ? 'done' : steered ? 'steered' : 'stopped'
      // The new agent has been told where the conversation is; a failed send tells it again.
      if (store.getChat(chatId).handoff) store.updateChat(chatId, { handoff: undefined })
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
      failure = errorMessage(error, chat.agent)
      this.events.item(
        chatId,
        store.upsertItem(chatId, { kind: 'error', id: crypto.randomUUID(), text: failure })
      )
    } finally {
      this.steering.delete(chatId)
      if (store.getState().chats.some((c) => c.id === chatId)) {
        this.processFor(chatId).endTurn(chatId, outcome)
        // How long the turn took, shown as "Worked for …" above its answer; and
        // for messages that joined it, from when they did.
        this.events.item(
          chatId,
          store.upsertItem(chatId, { ...userItem, workedMs: Date.now() - sentAt })
        )
        for (const item of store.getMessages(chatId)) {
          if (item.kind !== 'user' || item.workedMs !== undefined) continue
          if ((item.sentAt ?? 0) <= sentAt) continue
          this.events.item(
            chatId,
            store.upsertItem(chatId, { ...item, workedMs: Date.now() - item.sentAt! })
          )
        }
        store.updateChat(chatId, {
          running: false,
          updatedAt: Date.now(),
          preview: chatPreview(store.getMessages(chatId))
        })
        this.events.stateChanged()
        this.deliverNext(chatId, outcome)
        this.turnEnded(chatId, outcome, failure)
      }
    }
  }

  /** What the agent is sent for a message: the text as it reads it, and the files with it. */
  private async promptFor(
    chatId: string,
    text: string,
    attachments: Attachment[],
    from: ChatSender | undefined,
    first: boolean
  ): Promise<{ prompt: string; blocks: acp.ContentBlock[] }> {
    const { agent, handoff } = store.getChat(chatId)
    let prompt = from
      ? from.kind === undefined || from.kind === 'chat'
        ? fromChatPrompt(from.title, browserId(from.chatId), text, first)
        : text
      : this.expandChatsTag(chatId, this.expandBrowserTag(chatId, this.expandSkill(chatId, text)))
    if (handoff) {
      const label = AGENTS.find((a) => a.id === handoff)?.label ?? handoff
      prompt = `${prompt}\n\n(The user switched this chat to you from ${label}, so you do not have the conversation so far. Before you answer, read it in ${store.chatFile(chatId)}: the user's messages, the answers and the tool calls, up to this message. Continue from where it left off.)`
    }
    // The harness has where chats are saved in its system prompt already.
    if (!isHarnessAgent(agent) && (first || handoff)) {
      prompt = `${prompt}\n\n(${store.savedChatsNote(chatId)})`
    }
    // The harness passes each chat's ID to the tools itself.
    if (!isHarnessAgent(agent)) prompt = this.withChatId(chatId, prompt)
    let blocks = [...this.fileLinks(chatId, text), ...(await attachmentBlocks(attachments))]
    if (TEXT_ONLY_PROMPTS.has(agent)) {
      prompt = await withFilePaths(prompt, attachments)
      blocks = []
    }
    return { prompt, blocks }
  }

  /**
   * Keep the user's message to a working chat for the turn's next step (the
   * app's own agents, see steer) or its end (ACP agents). It shows above the
   * composer until then, and joins the chat where the agent reads it.
   */
  private wait(chatId: string, text: string, attachments: Attachment[]): void {
    this.inbox.set(chatId, [...(this.inbox.get(chatId) ?? []), { text, attachments }])
    this.showWaiting(chatId)
  }

  /** The user's waiting messages, for the composer. */
  private showWaiting(chatId: string): void {
    const waiting = (this.inbox.get(chatId) ?? []).filter((m) => !m.from).map((m) => m.text)
    store.updateChat(chatId, { waitingMessages: waiting.length > 0 ? waiting : undefined })
    this.events.stateChanged()
  }

  // --- Chats that start and message chats (chats-mcp.ts) --------------------

  /** Messages waiting for the chat's turn to go on or end, oldest first. */
  private readonly inbox = new Map<string, Waiting[]>()

  /** Chats whose turn is being ended to take the messages waiting for it (see steerAfterStep). */
  private readonly steering = new Set<string>()

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
    const first = store.getMessages(sender.id).find((i): i is UserItem => i.kind === 'user')
    if (senderChat(first?.from) === target.id) return true
    return !(
      (target.bypassPermissions && !sender.bypassPermissions) ||
      (sender.projectOnly && !target.projectOnly)
    )
  }

  /** A new chat like the caller's (agent, model, permissions), working on the task it was sent. */
  startChat(caller: string, prompt: string): { id: string; title: string } {
    const parent = this.caller(caller)
    // Only a turn the user started: a chain of chats ends at the chats it started.
    const turn = store.getMessages(caller).findLast((i): i is UserItem => i.kind === 'user')
    if (turn?.from) {
      throw new Error(
        'Not started: another chat, a background command or a timer started this turn, and only turns the user started can start chats. Do the work yourself.'
      )
    }
    if (!prompt.trim()) throw new Error('"prompt" must describe the task.')
    const chat = store.createChat({
      projectId: parent.projectId,
      agent: parent.agent,
      settings: { ...parent.settings },
      bypassPermissions: parent.bypassPermissions,
      projectOnly: parent.projectOnly,
      startedBy: parent.id
    })
    this.owesReport.add(chat.id)
    // Titled from the task before send's first await.
    void this.send(chat.id, prompt, [], { chatId: parent.id, title: parent.title })
    return { id: browserId(chat.id), title: chat.title }
  }

  /** Start a turn in another chat of the caller's project, or queue the message for its next one. */
  message(caller: string, to: string, text: string): 'started' | 'steering' {
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
    if (fromChatsSinceUser(target.id) + queued.filter((m) => m.from).length >= MAX_FROM_CHATS) {
      throw new Error(
        `Not sent: chat ${to} has had ${MAX_FROM_CHATS} messages from other chats since the user last wrote in it, the most it takes. Stop messaging it, and tell the user where things stand instead.`
      )
    }
    // A chat the user stopped stays stopped, unless the user asks for it again.
    const turn = store.getMessages(sender.id).findLast((i): i is UserItem => i.kind === 'user')
    if (!target.running && this.turnEnds.get(target.id)?.outcome === 'stopped' && turn?.from) {
      throw new Error(
        `Not sent: the user stopped chat ${to}. Leave it stopped unless the user asks you to start it again.`
      )
    }
    // A chat owes the chat that started it a report for each task it is sent.
    if (target.startedBy === sender.id) this.owesReport.add(target.id)
    if (sender.startedBy === target.id) this.owesReport.delete(sender.id)
    const from = { chatId: sender.id, title: sender.title }
    if (!target.running) {
      void this.send(target.id, text, [], from)
      return 'started'
    }
    this.inbox.set(target.id, [...queued, { text, attachments: [], from }])
    // The app's own agents take it at their next step (see steer), the others
    // once their turn is ended after it (see steerAfterStep).
    return 'steering'
  }

  listChats(caller: string): ChatListing[] {
    const self = this.caller(caller)
    return store
      .getState()
      .chats.filter((c) => c.projectId === self.projectId && (c.running || c.startedBy === self.id))
      .map((c) => ({
        id: browserId(c.id),
        title: c.title,
        self: c.id === self.id,
        started: c.startedBy === self.id,
        state: this.chatState(c),
        ...(c.startedBy === self.id ? { file: store.chatFile(c.id) } : {})
      }))
  }

  /** How a chat is doing, for list_chats. */
  private chatState(chat: Chat): string {
    if (chat.running) return chat.waiting ? 'waiting for the user' : 'working'
    const end = this.turnEnds.get(chat.id)
    if (end?.outcome === 'stopped') return 'stopped by the user: leave it unless the user asks'
    if (end?.outcome === 'failed') return `stopped: its last turn failed: ${end.error}`
    if (end?.outcome === 'done') return 'idle: finished its last turn'
    // Ended before this launch: an error is the last thing its failed turn showed.
    const last = store.getMessages(chat.id).at(-1)
    return last?.kind === 'error' ? `stopped: its last turn failed: ${last.text}` : 'idle'
  }

  /** Delete a chat the caller started; one that is working is stopped first. */
  async deleteStartedChat(caller: string, id: string): Promise<string> {
    const lead = this.caller(caller)
    const target = this.chatById(id, lead.projectId)
    if (target.startedBy !== lead.id) {
      throw new Error(
        `Not deleted: chat ${id} was not started by this chat, and a chat can delete only the chats it started.`
      )
    }
    await this.deleteChat(target.id)
    return target.title
  }

  /**
   * Run a command in the caller's project in the background; it wakes the
   * caller when it ends (see wake). The app's own agents asked about this call
   * already, as about every tool call; for the others the app asks here, as
   * for a shell command, since their own rules let MCP tools run unasked.
   */
  async runInBackground(caller: string, command: string, timeout?: number): Promise<Running> {
    const chat = this.caller(caller)
    if (!command.trim()) throw new Error('"command" is empty.')
    if (!isHarnessAgent(chat.agent)) {
      const response = await requestPermission(
        this.events,
        this.permissions,
        chat.id,
        {
          toolCallId: crypto.randomUUID(),
          title: `Run in the background: ${command}`,
          kind: 'execute',
          rawInput: { command, ...(timeout !== undefined ? { timeout } : {}) }
        },
        BACKGROUND_OPTIONS
      )
      const option = response.outcome.outcome === 'selected' ? response.outcome.optionId : undefined
      if (option !== 'allow') throw new Error('Not started: the user did not allow the command.')
    }
    const cwd = store.getProject(chat.projectId).path
    return background.startBackground(chat.id, command, cwd, timeout, (finished) =>
      this.wake(
        chat.id,
        finishedMessage(finished),
        { kind: 'command', command: finished.command },
        'A background command ended'
      )
    )
  }

  listBackground(caller: string): { commands: Running[]; timer?: Timer } {
    const chat = this.caller(caller)
    const timer = this.timers.get(chat.id)
    return {
      commands: background.listBackground(chat.id),
      ...(timer ? { timer: { note: timer.note, at: timer.at } } : {})
    }
  }

  readBackground(caller: string, pid: number): Promise<Running & { output: string }> {
    return background.readBackground(this.caller(caller).id, pid)
  }

  stopBackground(caller: string, pid: number): Promise<Finished> {
    return background.stopCommand(this.caller(caller).id, pid)
  }

  // --- Timers (set_timer) ---------------------------------------------------

  /** Each chat's timer: at most one, which wakes it with its note. */
  private readonly timers = new Map<string, Timer & { handle: NodeJS.Timeout }>()

  setTimer(caller: string, seconds: number, note: string): void {
    const chat = this.caller(caller)
    if (!note.trim()) throw new Error('"note" is empty: say what to do when the timer goes off.')
    this.clearTimer(chat.id)
    const ms = seconds * 1000
    const handle = setTimeout(() => {
      this.timers.delete(chat.id)
      this.wake(
        chat.id,
        `The timer you set ${formatDuration(ms)} ago went off. Your note:\n\n${note}`,
        { kind: 'timer', note },
        'The timer went off'
      )
    }, ms)
    this.timers.set(chat.id, { note, at: Date.now() + ms, handle })
  }

  cancelTimer(caller: string): boolean {
    return this.clearTimer(this.caller(caller).id)
  }

  private clearTimer(chatId: string): boolean {
    const timer = this.timers.get(chatId)
    if (!timer) return false
    clearTimeout(timer.handle)
    this.timers.delete(chatId)
    return true
  }

  // --- Chats that end their turn without reporting back ----------------------

  /** Chats sent a task by the chat that started them, that have not reported back since. */
  private readonly owesReport = new Set<string>()

  /** How each chat's last turn ended, this launch (see chatState). */
  private readonly turnEnds = new Map<string, TurnEnd>()

  /** Chats the user is stopping (see cancel), so the end of their turn reads as a stop. */
  private readonly stopping = new Set<string>()

  /**
   * A chat's turn ended. If it was started by another chat and owes it a
   * report, that chat is told: with its last answer when it finished without
   * reporting, or with the error when its turn failed, so it can get it going
   * again. A stop by the user wakes no one: the user meant to stop it.
   */
  private turnEnded(chatId: string, outcome: TurnOutcome, failure: string | undefined): void {
    const byUser = this.stopping.delete(chatId)
    if (outcome === 'steered') return
    // A message that waited for the turn started the next one.
    const chat = store.getChat(chatId)
    if (chat.running) return
    this.turnEnds.set(
      chatId,
      outcome === 'failed'
        ? { outcome, error: failure ?? 'unknown error' }
        : byUser || outcome === 'stopped'
          ? { outcome: 'stopped' }
          : { outcome: 'done' }
    )
    if (byUser || outcome === 'stopped' || !chat.startedBy) return
    if (!this.owesReport.delete(chatId)) return
    const lead = store.getState().chats.find((c) => c.id === chat.startedBy)
    if (!lead) return
    const name = `The chat "${chat.title}" (chat ID ${browserId(chat.id)}), which you started,`
    let text: string
    if (outcome === 'failed') {
      text = `${name} stopped: its turn failed with this error:\n\n${failure ?? 'unknown error'}\n\nIf the error looks passing (a provider limit, a timeout, a dropped connection), get it going again with send_message, saying where to pick up. Otherwise tell the user. Its conversation is saved in ${store.chatFile(chatId)}.`
    } else {
      const answer = lastAnswer(chatId)
      const shown =
        answer && answer.length > LAST_ANSWER_CHARS
          ? `[Cut to its end.]\n${answer.slice(-LAST_ANSWER_CHARS)}`
          : answer
      text = `${name} ended its turn without reporting back to you. ${shown ? `Its last answer:\n\n${shown}` : 'It gave no answer.'}\n\nIf it is not done, get it going again with send_message. Its conversation is saved in ${store.chatFile(chatId)}.`
    }
    this.wake(
      lead.id,
      text,
      { kind: 'ended', chatId, title: chat.title },
      `"${chat.title}" ended its turn`
    )
  }

  /**
   * Wake a chat with a message from the app: a background command ended, its
   * timer went off, or a chat it started ended without reporting. It is a new
   * turn when the chat is idle, or joins it at the next step of its turn (the
   * app's own agents) or its end (the others). It counts against the messages
   * a chat takes between the user's own, so commands, timers and chats that
   * set off more of them cannot keep a chat going.
   */
  private wake(chatId: string, text: string, from: ChatSender, what: string): void {
    const chat = store.getState().chats.find((c) => c.id === chatId)
    if (!chat) return
    const queued = this.inbox.get(chatId) ?? []
    if (fromChatsSinceUser(chatId) + queued.filter((m) => m.from).length >= MAX_FROM_CHATS) {
      this.events.item(
        chatId,
        store.upsertItem(chatId, {
          kind: 'notice',
          id: crypto.randomUUID(),
          text: `${what}, but this chat has taken ${MAX_FROM_CHATS} messages from other chats, commands and timers since you last wrote, so it was not woken. ${text}`
        })
      )
      return
    }
    // A started chat woken by its own command or timer is still on its task:
    // it owes the chat that started it a report again.
    if (chat.startedBy && (from.kind === 'command' || from.kind === 'timer')) {
      this.owesReport.add(chatId)
    }
    if (!chat.running) {
      void this.send(chatId, text, [], from)
      return
    }
    this.inbox.set(chatId, [...queued, { text, attachments: [], from }])
  }

  /**
   * The waiting messages that may still be delivered: those from a chat that
   * was deleted, or may no longer message this one, are dropped with a notice.
   */
  private deliverable(chatId: string, queued: Waiting[]): Waiting[] {
    const target = store.getChat(chatId)
    return queued.filter(({ from }) => {
      // What the app sends (commands, timers, chats that ended) always goes.
      if (!from || (from.kind !== undefined && from.kind !== 'chat')) return true
      const sender = store.getState().chats.find((c) => c.id === from.chatId)
      if (sender && this.mayMessage(sender, target)) return true
      this.events.item(
        chatId,
        store.upsertItem(chatId, {
          kind: 'notice',
          id: crypto.randomUUID(),
          text: sender
            ? `A message from "${from.title}" was not delivered: this chat now has broader permissions than that chat.`
            : `A message from "${from.title}" was not delivered: that chat was deleted.`
        })
      )
      return false
    })
  }

  /**
   * Take the messages waiting for a running chat of the app's own agents, to
   * join its turn at the next step, as the agent reads them. A compaction
   * command waits for the turn to end, and so does what came after it.
   */
  private async steer(chatId: string): Promise<{ prompt: string; blocks: acp.ContentBlock[] }[]> {
    const queued = this.inbox.get(chatId)
    if (!queued) return []
    const compact = queued.findIndex((m) => !m.from && COMPACT.test(m.text.trim()))
    const now = compact === -1 ? queued : queued.slice(0, compact)
    if (now.length === 0) return []
    const later = queued.slice(now.length)
    if (later.length > 0) this.inbox.set(chatId, later)
    else this.inbox.delete(chatId)
    const messages = this.deliverable(chatId, now)
    for (const { text, attachments, from } of messages) {
      this.events.item(
        chatId,
        store.upsertItem(chatId, {
          ...newUserItem(text, attachments),
          sentAt: Date.now(),
          ...(from ? { from } : {})
        })
      )
    }
    store.updateChat(chatId, { preview: chatPreview(store.getMessages(chatId)) })
    this.showWaiting(chatId)
    return Promise.all(
      messages.map((m) => this.promptFor(chatId, m.text, m.attachments, m.from, false))
    )
  }

  /**
   * A turn ended: start the next message that waited for it. When the user
   * stopped the turn, messages from other chats are dropped, so Stop really
   * stops them.
   */
  private deliverNext(chatId: string, outcome: TurnOutcome): void {
    let queued = this.inbox.get(chatId)
    if (!queued) return
    this.inbox.delete(chatId)
    // The user's own messages still go: they are what the user wants next.
    const n = queued.filter((m) => m.from).length
    if (outcome === 'stopped' && n > 0) {
      queued = queued.filter((m) => !m.from)
      this.events.item(
        chatId,
        store.upsertItem(chatId, {
          kind: 'notice',
          id: crypto.randomUUID(),
          text: `${n === 1 ? 'A message' : `${n} messages`} from other chats, background commands or timers ${n === 1 ? 'was' : 'were'} not delivered, because the chat was stopped.`
        })
      )
    }
    const [next, ...rest] = this.deliverable(chatId, queued)
    if (rest.length > 0) this.inbox.set(chatId, rest)
    this.showWaiting(chatId)
    if (next) void this.send(chatId, next.text, next.attachments, next.from)
  }

  /**
   * The user stops the chat: a stop, even when it was about to be steered.
   * Its timer is cleared too: it would only start the chat again.
   */
  cancel(chatId: string): Promise<void> {
    this.steering.delete(chatId)
    this.clearTimer(chatId)
    if (store.getChat(chatId).running) this.stopping.add(chatId)
    return this.processFor(chatId).cancel(chatId)
  }

  /**
   * Steer an ACP agent's turn. ACP has no way to add to a running turn, so
   * when a step of it ends (a tool call finished, none other running) while
   * messages wait, the turn is ended there (session/cancel), and deliverNext
   * sends them at once as the next one. Ending after a finished call loses no
   * work, and the agent keeps the conversation. A compaction command first in
   * line waits for the turn's own end.
   */
  private steerAfterStep(chatId: string): void {
    const queued = this.inbox.get(chatId)
    if (!queued?.length || this.steering.has(chatId)) return
    if (!queued[0].from && COMPACT.test(queued[0].text.trim())) return
    if (!store.getChat(chatId).running) return
    this.steering.add(chatId)
    void this.processFor(chatId).cancel(chatId)
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
