import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as acp from '@agentclientprotocol/sdk'
import type { AgentCommand, AgentOption, ChatItem, ModelSource } from '../../shared/types'
import * as store from '../store'
import { BROWSER_GUIDANCE } from '../browser-mcp'
import { listSkills } from '../skills'
import { formatRaw, limitOutput } from '../tool-output'
import {
  emitItem,
  outsidePath,
  requestPermission,
  type AgentEvents,
  type Permissions
} from '../permissions'
import { defaultEffort, effortLevels, parseArguments, streamReply, type Model } from './wire'
import type { Provider, Source } from './provider'
import { browserTools, CORE_TOOLS, runTool, type Tool } from './tools'
import type { AssistantTurn, Effort, Part, Reply, ToolResult, Turn } from './types'

/**
 * A minimal coding agent run in the app, after pi: a system prompt, four tools
 * (plus the browser's) and a loop that calls the model until it stops calling
 * tools. Everything it sends is kept byte-stable for the prompt cache: the
 * system prompt is fixed when the chat starts, the tools are always listed the
 * same way, and the transcript only ever grows.
 */

/** A reply that streams nothing this long means the gateway or upstream hangs. */
const STALL_TIMEOUT_MS = 5 * 60_000
const STALL_CHECK_MS = 15_000

const sessionsDir = join(app.getPath('userData'), 'harness')

/** One line of a session file. */
type Entry =
  | { type: 'session'; system: string }
  | { type: 'turn'; turn: Turn }
  | { type: 'allow'; tool: string }

interface Session {
  file: string
  system: string
  turns: Turn[]
  /** Tools the user chose "Always allow" for in this chat. */
  allowed: Set<string>
}

const PERMISSION_OPTIONS: acp.PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
]

/** A chat's model: which source bills it, the model, and its effort. */
interface Choice {
  source: Source
  model: Model
  effort: Effort
}

export class HarnessAgent {
  readonly agent: Provider['id']
  private sessions = new Map<string, Session>()
  /** The running turn of each chat, aborted by Stop. */
  private turns = new Map<string, AbortController>()
  private options = new Map<string, AgentOption[]>()

  constructor(
    private readonly provider: Provider,
    private readonly events: AgentEvents,
    private readonly permissions: Permissions
  ) {
    this.agent = provider.id
  }

  // --- Sessions -------------------------------------------------------------

  /** Load the chat's session, or start one; returns its id, which is the chat id. */
  async ensureSession(chatId: string): Promise<string> {
    if (!this.sessions.has(chatId)) this.sessions.set(chatId, await this.openSession(chatId))
    if (!this.options.has(chatId)) await this.setOptions(chatId)
    return chatId
  }

  private async openSession(chatId: string): Promise<Session> {
    const file = join(sessionsDir, `${chatId}.jsonl`)
    const session: Session = { file, system: '', turns: [], allowed: new Set() }
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        // A line cut off by a crash is the last one; it is skipped.
        let entry: Entry
        try {
          entry = JSON.parse(line) as Entry
        } catch {
          continue
        }
        if (entry.type === 'session') session.system = entry.system
        else if (entry.type === 'turn') session.turns.push(entry.turn)
        else session.allowed.add(entry.tool)
      }
      if (session.system) return session
    }
    if (store.getMessages(chatId).some((i) => i.kind === 'user')) {
      this.emit(chatId, {
        kind: 'error',
        id: crypto.randomUUID(),
        text: 'This conversation was not found, so it continues without the earlier context.'
      })
    }
    session.system = await this.systemPrompt(chatId)
    await mkdir(sessionsDir, { recursive: true })
    await appendFile(file, `${JSON.stringify({ type: 'session', system: session.system })}\n`)
    store.updateChat(chatId, { sessionId: chatId })
    return session
  }

  private async append(session: Session, entry: Entry): Promise<void> {
    if (entry.type === 'turn') session.turns.push(entry.turn)
    if (entry.type === 'allow') session.allowed.add(entry.tool)
    await appendFile(session.file, `${JSON.stringify(entry)}\n`)
  }

  /**
   * Fixed when the chat starts, like pi's: what the tools are for, the project's
   * own instructions, its skills and the folder. No date or anything else that
   * changes, so the cached prefix stays valid for the whole chat.
   */
  private async systemPrompt(chatId: string): Promise<string> {
    const project = store.getProject(store.getChat(chatId).projectId)
    const sections = [
      `You are an expert coding assistant working in the user's project through Just Harness. You help by reading files, running commands, editing code and writing new files.

Guidelines:
- Use read to look at files, not cat or sed.
- Use bash for ls, rg, find, git, builds and tests.
- Use edit for precise changes. When changing several places in one file, make one edit call with several entries.
- Use write only for new files or complete rewrites.
- Be concise in your responses.
- Show file paths clearly when working with files.`,
      `<browser>\nThe other tools (navigate, snapshot, click and the rest) drive the browser panel in the app. ${BROWSER_GUIDANCE}\n</browser>`
    ]
    const instructions = ['AGENTS.md', 'CLAUDE.md']
      .map((name) => join(project.path, name))
      .find((path) => existsSync(path))
    if (instructions) {
      sections.push(
        `<project_instructions path="${instructions}">\n${readFileSync(instructions, 'utf8').trim()}\n</project_instructions>`
      )
    }
    const skills = listSkills(project.path).filter((s) => s.agents.includes(this.agent))
    if (skills.length > 0) {
      sections.push(
        `<skills>\nSkills are instructions for specific tasks. When a task matches a skill, read its SKILL.md and follow it.\n${skills
          .map((s) => `- ${s.name}: ${s.description} (${s.path})`)
          .join('\n')}\n</skills>`
      )
    }
    sections.push(`<cwd>${project.path}</cwd>`)
    return sections.join('\n\n')
  }

  /** Forget the chat's session and delete it: the chat is deleted or switches agent. */
  async release(chatId: string): Promise<void> {
    this.options.delete(chatId)
    this.sessions.delete(chatId)
    await rm(join(sessionsDir, `${chatId}.jsonl`), { force: true })
  }

  // --- Options --------------------------------------------------------------

  getOptions(chatId: string): AgentOption[] | undefined {
    return this.options.get(chatId)
  }

  getCommands(): AgentCommand[] {
    return []
  }

  /** Every source's models, for the model picker; a source is a picker setting when there are several. */
  async listModels(): Promise<ModelSource[]> {
    const sources = await this.provider.sources()
    const preferred = await this.provider.preferred()
    return sources.map((source) => {
      const current = source.models.some((m) => m.id === preferred?.model)
        ? preferred!.model
        : (source.models[0]?.id ?? '')
      const option = modelOption(source.models, current)
      return sources.length > 1
        ? { setting: { optionId: 'source', value: source.id, name: source.name }, option }
        : { option }
    })
  }

  async applyOption(chatId: string, optionId: string, value: string): Promise<void> {
    await this.ensureSession(chatId)
    const settings = { ...store.getChat(chatId).settings, [optionId]: value }
    // Another source has other models; another model may lack the chosen effort.
    if (optionId === 'source') delete settings.model
    if (optionId === 'source' || optionId === 'model') delete settings.effort
    store.updateChat(chatId, { settings })
    await this.setOptions(chatId)
  }

  /**
   * The chat's source, model and effort, settled from its settings and what the
   * provider lists now. A new chat starts where the provider's own CLI is set.
   */
  private async choice(chatId: string): Promise<Choice> {
    const settings = store.getChat(chatId).settings
    const sources = await this.provider.sources()
    const preferred = settings.model ? undefined : await this.provider.preferred()
    const source =
      sources.find((s) => s.id === (settings.source ?? preferred?.source)) ??
      sources.find((s) => s.models.some((m) => m.id === preferred?.model)) ??
      sources.find((s) => s.models.length > 0)
    if (!source)
      throw new Error(`${this.provider.name} lists no models right now. Try again in a moment.`)
    const id = settings.model ?? preferred?.model
    const model =
      source.models.find((m) => m.id === id) ??
      // A model the provider stopped listing still works for chats already on it.
      (settings.model ? fallbackModel(settings.model) : source.models[0])
    if (!model)
      throw new Error(`${this.provider.name} lists no models right now. Try again in a moment.`)
    const levels = effortLevels(model)
    const effort = levels.includes(settings.effort as Effort)
      ? (settings.effort as Effort)
      : defaultEffort(model)
    return { source, model, effort }
  }

  private async setOptions(chatId: string): Promise<void> {
    const { source, model, effort } = await this.choice(chatId)
    const sources = await this.provider.sources()
    const options: AgentOption[] = []
    if (sources.length > 1) {
      options.push({
        id: 'source',
        name: 'Plan',
        category: 'model',
        currentValue: source.id,
        values: sources.map((s) => ({ value: s.id, name: s.name }))
      })
    }
    options.push(modelOption(source.models, model.id))
    const levels = effortLevels(model)
    if (levels.length > 0) {
      options.push({
        id: 'effort',
        name: 'Effort',
        category: 'thought_level',
        currentValue: effort,
        values: levels.map((level) => ({
          value: level,
          name:
            level === 'default' ? 'Default' : level === 'xhigh' ? 'Extra high' : capitalize(level)
        }))
      })
    }
    store.updateChat(chatId, {
      settings: Object.fromEntries(options.map((o) => [o.id, o.currentValue]))
    })
    this.options.set(chatId, options)
    this.events.options(chatId, options)
  }

  // --- Turns ----------------------------------------------------------------

  async prompt(
    chatId: string,
    text: string,
    blocks: acp.ContentBlock[] = []
  ): Promise<acp.PromptResponse> {
    const turn = new AbortController()
    this.turns.set(chatId, turn)
    const { signal } = turn
    try {
      await this.ensureSession(chatId)
      const session = this.sessions.get(chatId)!
      await this.closeOpenCalls(session)
      await this.append(session, {
        type: 'turn',
        turn: { role: 'user', content: userContent(text, blocks) }
      })
      const tools = await this.tools()
      for (;;) {
        if (signal.aborted) return { stopReason: 'cancelled' }
        const reply = await this.reply(chatId, session, tools, await this.choice(chatId), signal)
        if (reply.turn.text || reply.turn.toolCalls.length > 0) {
          await this.append(session, { type: 'turn', turn: reply.turn })
        }
        if (signal.aborted) return { stopReason: 'cancelled' }
        if (reply.turn.toolCalls.length === 0) {
          return {
            stopReason:
              reply.stop === 'max_tokens'
                ? 'max_tokens'
                : reply.stop === 'refusal'
                  ? 'refusal'
                  : 'end_turn'
          }
        }
        const results =
          reply.stop === 'max_tokens'
            ? // Cut off mid-call: the arguments may be incomplete, so nothing runs.
              reply.turn.toolCalls.map((call) =>
                errorResult(
                  call.id,
                  'Not run: the reply hit the output limit, so the arguments may be cut off. Call the tool again with complete arguments.'
                )
              )
            : await this.runCalls(chatId, session, tools, reply.turn, signal)
        await this.append(session, { type: 'turn', turn: { role: 'tool', results } })
      }
    } finally {
      if (this.turns.get(chatId) === turn) this.turns.delete(chatId)
    }
  }

  /** Calls the app quit or crashed during were never answered; answer them so the transcript stays valid. */
  private async closeOpenCalls(session: Session): Promise<void> {
    const last = session.turns.at(-1)
    if (last?.role !== 'assistant' || last.toolCalls.length === 0) return
    const results = last.toolCalls.map((call) =>
      errorResult(call.id, 'Not run: the turn ended first.')
    )
    await this.append(session, { type: 'turn', turn: { role: 'tool', results } })
  }

  /** pi's four tools first, then the browser's, the same every request. */
  private async tools(): Promise<Tool[]> {
    try {
      return [...CORE_TOOLS, ...(await browserTools())]
    } catch (error) {
      console.error(`[${this.agent}] browser tools unavailable:`, error)
      return CORE_TOOLS
    }
  }

  /**
   * Stream one reply into the chat. A reply cut short (Stop, an error, a stall)
   * keeps the text that arrived, so the model knows what it already said.
   */
  private async reply(
    chatId: string,
    session: Session,
    tools: Tool[],
    { source, model, effort }: Choice,
    signal: AbortSignal
  ): Promise<Reply> {
    // Fetched for every request: credentials can change (signing in again, a renewed token).
    const endpoint = await this.provider.endpoint(source.id, chatId)
    const request = new AbortController()
    const onAbort = (): void => request.abort()
    signal.addEventListener('abort', onAbort)
    let lastActivity = Date.now()
    let stalled = false
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity < STALL_TIMEOUT_MS) return
      stalled = true
      request.abort()
    }, STALL_CHECK_MS)
    let text = ''
    try {
      return await streamReply(
        endpoint,
        model,
        {
          model: model.id,
          effort,
          system: session.system,
          tools: tools.map((t) => t.spec),
          turns: session.turns
        },
        {
          text: (delta) => {
            text += delta
            this.stream(chatId, 'text', delta)
          },
          thinking: (delta) => this.stream(chatId, 'thought', delta),
          activity: () => (lastActivity = Date.now())
        },
        request.signal
      )
    } catch (error) {
      const partial: AssistantTurn = {
        role: 'assistant',
        model: model.id,
        api: model.api,
        text,
        toolCalls: []
      }
      if (signal.aborted) return { turn: partial, stop: 'end' }
      if (text) await this.append(session, { type: 'turn', turn: partial })
      if (stalled) {
        throw new Error(
          `${this.provider.name} sent nothing for ${STALL_TIMEOUT_MS / 60_000} minutes, so the reply was stopped. Send your message again to continue.`
        )
      }
      throw error
    } finally {
      clearInterval(watchdog)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** Consecutive chunks of the same kind form one block, as for ACP agents. */
  private stream(chatId: string, kind: 'text' | 'thought', delta: string): void {
    const last = store.lastItem(chatId)
    if (last?.kind === kind) this.emit(chatId, { ...last, text: last.text + delta })
    else this.emit(chatId, { kind, id: crypto.randomUUID(), text: delta })
  }

  /** Run a reply's tool calls in order, asking first where the chat's mode says to. */
  private async runCalls(
    chatId: string,
    session: Session,
    tools: Tool[],
    reply: AssistantTurn,
    signal: AbortSignal
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = []
    const chat = store.getChat(chatId)
    const cwd = store.getProject(chat.projectId).path
    for (const call of reply.toolCalls) {
      if (signal.aborted) {
        results.push(errorResult(call.id, 'Not run: the user stopped the turn.'))
        continue
      }
      const tool = tools.find((t) => t.spec.name === call.name)
      const args = parseArguments(call.arguments)
      const item: Extract<ChatItem, { kind: 'tool' }> = {
        kind: 'tool',
        // Call ids can repeat across replies (some models number them per reply).
        id: crypto.randomUUID(),
        title: tool?.title ?? call.name,
        toolKind: tool?.kind,
        status: 'pending',
        input: formatRaw(args ?? call.arguments)
      }
      this.emit(chatId, item)
      if (!tool || !args) {
        const message = !tool
          ? `There is no tool named "${call.name}".`
          : 'The arguments were not a valid JSON object.'
        this.emit(chatId, { ...item, status: 'failed', output: message })
        results.push(errorResult(call.id, message))
        continue
      }
      const allowed = await this.allow(chatId, session, tool, args, cwd)
      if (allowed !== 'allow') {
        this.emit(chatId, { ...item, status: allowed === 'cancelled' ? 'interrupted' : 'failed' })
        results.push(
          errorResult(
            call.id,
            allowed === 'cancelled'
              ? 'Not run: the user stopped the turn.'
              : 'The user rejected this tool call.'
          )
        )
        continue
      }
      this.emit(chatId, { ...item, status: 'in_progress' })
      const output = await runTool(tool, args, { cwd, chatId, signal })
      const shown =
        output.display ??
        output.content.map((p) => (p.type === 'text' ? p.text : `[${p.mimeType}]`)).join('\n')
      this.emit(chatId, {
        ...item,
        status: signal.aborted ? 'interrupted' : output.isError ? 'failed' : 'completed',
        output: limitOutput(shown)
      })
      results.push({ callId: call.id, content: output.content, isError: output.isError === true })
    }
    return results
  }

  /** Whether a call may run: read-only tools and "always allowed" ones run unless they leave the project. */
  private async allow(
    chatId: string,
    session: Session,
    tool: Tool,
    args: Record<string, unknown>,
    cwd: string
  ): Promise<'allow' | 'reject' | 'cancelled'> {
    const toolCall: acp.ToolCallUpdate = {
      toolCallId: crypto.randomUUID(),
      title: `${tool.title}: ${typeof (args.command ?? args.path ?? args.url) === 'string' ? (args.command ?? args.path ?? args.url) : JSON.stringify(args)}`,
      rawInput: args,
      locations: tool.paths(args, cwd).map((path) => ({ path }))
    }
    // Read-only tools run without asking only inside the project, in every mode.
    const outside = outsidePath(cwd, toolCall)
    if (!outside && (tool.readOnly || session.allowed.has(tool.spec.name))) return 'allow'
    const response = await requestPermission(
      this.events,
      this.permissions,
      chatId,
      toolCall,
      PERMISSION_OPTIONS
    )
    if (response.outcome.outcome === 'cancelled') return 'cancelled'
    const option = response.outcome.optionId
    if (option === 'allow_always')
      await this.append(session, { type: 'allow', tool: tool.spec.name })
    return option.startsWith('allow') ? 'allow' : 'reject'
  }

  /** Stop the chat's turn: the stream and any running command end now. */
  async cancel(chatId: string): Promise<void> {
    for (const [id, pending] of this.permissions) {
      if (pending.chatId !== chatId) continue
      this.permissions.delete(id)
      pending.resolve({ outcome: { outcome: 'cancelled' } })
      this.resolvePermissionItem(chatId, id, 'cancelled')
    }
    this.turns.get(chatId)?.abort()
  }

  /** Tool calls still shown as running when the turn ended did not finish. */
  endTurn(chatId: string): void {
    for (const item of store.getMessages(chatId)) {
      if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'in_progress')) {
        this.emit(chatId, { ...item, status: 'interrupted' })
      }
    }
  }

  resolvePermissionItem(chatId: string, id: string, resolved: string, auto = false): void {
    const item = store.findItem(chatId, id)
    if (item?.kind === 'permission') this.emit(chatId, { ...item, resolved, auto })
  }

  async explain(error: unknown): Promise<unknown> {
    return error
  }

  /** Stop every running turn (the app is quitting). */
  stop(): void {
    for (const turn of this.turns.values()) turn.abort()
  }

  private emit(chatId: string, item: ChatItem): void {
    emitItem(this.events, this.permissions, chatId, item)
  }
}

/** The model picker's list: "maker/name" where the maker is known, so models group by it. */
function modelOption(models: Model[], current: string): AgentOption {
  const values = models.map((m) => {
    const maker = makerOf(m.id)
    return { value: m.id, name: m.name.includes('/') || !maker ? m.name : `${maker}/${m.name}` }
  })
  // A model the provider stopped listing stays selectable for chats already on it.
  if (current && !values.some((v) => v.value === current))
    values.push({ value: current, name: current })
  return { id: 'model', name: 'Model', category: 'model', currentValue: current, values }
}

function makerOf(id: string): string | undefined {
  if (id.includes('/')) return id.split('/')[0]
  if (id.startsWith('claude-')) return 'anthropic'
  if (id.startsWith('gpt-')) return 'openai'
  return undefined
}

/** A model no longer listed: Claude ids answer on Messages, the rest on Chat Completions. */
function fallbackModel(id: string): Model {
  return { id, name: id, api: id.startsWith('claude-') ? 'messages' : 'chat', vision: false }
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Images over this are not sent inline: the APIs reject images over 5 MB. */
const MAX_INLINE_IMAGE = 5 * 1024 * 1024

/** The prompt and its attachments: images inline, files as paths the model reads itself. */
function userContent(text: string, blocks: acp.ContentBlock[]): Part[] {
  const parts: Part[] = [{ type: 'text', text }]
  const files: string[] = []
  for (const block of blocks) {
    if (block.type === 'image' && block.data.length * 0.75 <= MAX_INLINE_IMAGE) {
      parts.push({ type: 'image', mimeType: block.mimeType, data: block.data })
    } else if (block.type === 'image' && block.uri) {
      files.push(fileURLToPath(block.uri))
    } else if (block.type === 'image') {
      parts.push({ type: 'text', text: '[An attached image was over 5 MB and was left out.]' })
    } else if (block.type === 'resource_link') {
      files.push(fileURLToPath(block.uri))
    }
  }
  if (files.length > 0) {
    parts.push({
      type: 'text',
      text: `Attached files (read them with the read tool):\n${files.map((f) => `- ${f}`).join('\n')}`
    })
  }
  return parts
}

function errorResult(callId: string, message: string): ToolResult {
  return { callId, content: [{ type: 'text', text: message }], isError: true }
}
