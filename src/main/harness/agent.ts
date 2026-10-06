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
import {
  CONTEXT_FULL_MESSAGE,
  defaultEffort,
  effortLevels,
  parseArguments,
  streamReply,
  type Model
} from './wire'
import type { Provider, Source } from './provider'
import { browserTools, CORE_TOOLS, runTool, type Tool } from './tools'
import {
  AGENT_TOOL,
  AGENT_TOOL_NAME,
  brief,
  Limiter,
  MAX_PARALLEL,
  MAX_REQUESTS,
  parseTask,
  STEP_LIMIT_NOTE,
  subagentRefusal,
  type SubagentTask
} from './subagents'
import type {
  AssistantTurn,
  Effort,
  Part,
  Reply,
  Request,
  ToolCall,
  ToolResult,
  ToolSpec,
  Turn
} from './types'

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
  | { type: 'tools'; tools: ToolSpec[] }
  | { type: 'turn'; turn: Turn }
  | { type: 'allow'; tool: string }

interface Session {
  file: string
  system: string
  /** The tools the chat declares, fixed at its first request (see toolSpecs). */
  tools?: ToolSpec[]
  turns: Turn[]
  /** Tools the user chose "Always allow" for in this chat. */
  allowed: Set<string>
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/**
 * Who makes a reply's tool calls: the main agent, which may start subagents,
 * or a subagent, whose calls follow its task's rules.
 */
type Caller =
  | { spawn: (callId: string, args: Record<string, unknown>) => Promise<ToolResult> }
  | { subagent: SubagentTask; parentId: string }

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
  /** Subagents of each chat running at once (see MAX_PARALLEL). */
  private limiters = new Map<string, Limiter>()
  /** Per chat, the files running implement subagents own, by the agent call's item id. */
  private owners = new Map<string, Map<string, string>>()

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
        else if (entry.type === 'tools') session.tools = entry.tools
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
    if (entry.type === 'tools') session.tools = entry.tools
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
- Use bash for ls, rg, find, git, builds and tests. Commands that keep running (dev servers, watchers) must be started in the background with & and their output redirected to a file; otherwise the call waits until they exit.
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
    this.limiters.delete(chatId)
    this.owners.delete(chatId)
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
      const tools = await this.tools()
      const specs = await this.toolSpecs(session, tools)
      await this.closeOpenCalls(session)
      await this.append(session, {
        type: 'turn',
        turn: { role: 'user', content: userContent(text, blocks) }
      })
      const request = { system: session.system, tools: specs, turns: session.turns }
      for (;;) {
        if (signal.aborted) return { stopReason: 'cancelled' }
        const choice = await this.choice(chatId)
        const reply = await this.reply(chatId, request, choice, signal, {
          keep: (partial) => this.append(session, { type: 'turn', turn: partial })
        })
        if (reply.turn.text || reply.turn.toolCalls.length > 0) {
          await this.append(session, { type: 'turn', turn: reply.turn })
        }
        if (signal.aborted) return { stopReason: 'cancelled' }
        // Cut off by the context window: calls in it may be incomplete, and the
        // next request would not fit either. Calls left unanswered are closed
        // when the chat is used again (closeOpenCalls).
        if (reply.stop === 'context_full') throw new Error(CONTEXT_FULL_MESSAGE)
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
            : await this.runCalls(chatId, session, tools, reply.turn, signal, {
                spawn: (callId, args) =>
                  this.runSubagent(chatId, session, tools, request, choice, callId, args, signal)
              })
        await this.append(session, { type: 'turn', turn: { role: 'tool', results } })
      }
    } finally {
      if (this.turns.get(chatId) === turn) this.turns.delete(chatId)
    }
  }

  /**
   * The tools the chat declares, fixed at its first request and replayed
   * unchanged after. Changing a tool's text or the set mid-conversation would
   * invalidate the thinking that newer Claude models replay (a 400 on accounts
   * where that is enforced) and miss the prompt cache, so app updates and a
   * browser that fails to connect leave a chat's tools as they were. Chats from
   * before tools were stored keep the ones they had, which had no subagents.
   */
  private async toolSpecs(session: Session, tools: Tool[]): Promise<ToolSpec[]> {
    if (session.tools) return session.tools
    const core = CORE_TOOLS.map((t) => t.spec)
    const browser = tools.filter((t) => !CORE_TOOLS.includes(t)).map((t) => t.spec)
    const specs =
      session.turns.length === 0 ? [...core, AGENT_TOOL, ...browser] : [...core, ...browser]
    await this.append(session, { type: 'tools', tools: specs })
    return specs
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
   * Stream one reply. The main agent's (`main` set) is shown in the chat as it
   * arrives, and when cut short (Stop, an error, a stall) the text that arrived
   * is kept, so the model knows what it already said. A subagent's is not shown:
   * only its report is.
   */
  private async reply(
    chatId: string,
    request: Pick<Request, 'system' | 'tools' | 'turns'>,
    { source, model, effort }: Choice,
    signal: AbortSignal,
    main?: { keep: (partial: AssistantTurn) => Promise<void> }
  ): Promise<Reply> {
    // Fetched for every request: credentials can change (signing in again, a renewed token).
    const endpoint = await this.provider.endpoint(source.id, chatId)
    const sending = new AbortController()
    const onAbort = (): void => sending.abort()
    signal.addEventListener('abort', onAbort)
    let lastActivity = Date.now()
    let stalled = false
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity < STALL_TIMEOUT_MS) return
      stalled = true
      sending.abort()
    }, STALL_CHECK_MS)
    let text = ''
    try {
      return await streamReply(
        endpoint,
        model,
        { model: model.id, effort, ...request },
        {
          text: (delta) => {
            text += delta
            if (main) this.stream(chatId, 'text', delta)
          },
          thinking: (delta) => {
            if (main) this.stream(chatId, 'thought', delta)
          },
          activity: () => (lastActivity = Date.now())
        },
        sending.signal
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
      if (text && main) await main.keep(partial)
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

  /**
   * Run a reply's tool calls, asking first where the chat's mode says to. Calls
   * run in order, except subagents: they start at once and run alongside, and
   * every result is returned in the order of the calls.
   */
  private async runCalls(
    chatId: string,
    session: Session,
    tools: Tool[],
    reply: AssistantTurn,
    signal: AbortSignal,
    caller: Caller
  ): Promise<ToolResult[]> {
    const results: (ToolResult | Promise<ToolResult>)[] = []
    const cwd = store.getProject(store.getChat(chatId).projectId).path
    for (const call of reply.toolCalls) {
      if (signal.aborted) {
        results.push(errorResult(call.id, 'Not run: the user stopped the turn.'))
        continue
      }
      const args = parseArguments(call.arguments)
      if (call.name === AGENT_TOOL_NAME && args && 'spawn' in caller) {
        results.push(caller.spawn(call.id, args))
        continue
      }
      results.push(await this.runCall(chatId, session, tools, call, args, signal, cwd, caller))
    }
    return Promise.all(results)
  }

  /** Run one tool call: refused, rejected by the user, or run, and shown in the chat. */
  private async runCall(
    chatId: string,
    session: Session,
    tools: Tool[],
    call: ToolCall,
    args: Record<string, unknown> | undefined,
    signal: AbortSignal,
    cwd: string,
    caller: Caller
  ): Promise<ToolResult> {
    const tool = tools.find((t) => t.spec.name === call.name)
    const item: ToolItem = {
      kind: 'tool',
      // Call ids can repeat across replies (some models number them per reply).
      id: crypto.randomUUID(),
      title: tool?.title ?? call.name,
      toolKind: tool?.kind,
      status: 'pending',
      input: formatRaw(args ?? call.arguments),
      ...('subagent' in caller ? { parentId: caller.parentId } : {})
    }
    this.emit(chatId, item)
    const refuse = (message: string): ToolResult => {
      this.emit(chatId, { ...item, status: 'failed', output: message })
      return errorResult(call.id, message)
    }
    if (!args) return refuse('The arguments were not a valid JSON object.')
    // A subagent's rules come first: they also cover tools it cannot have.
    const rule =
      'subagent' in caller ? subagentRefusal(caller.subagent, call.name, args, cwd) : undefined
    if (rule) return refuse(rule)
    if (!tool) return refuse(`There is no tool named "${call.name}" available right now.`)
    const allowed = await this.allow(chatId, session, tool, args, cwd)
    if (allowed !== 'allow') {
      this.emit(chatId, { ...item, status: allowed === 'cancelled' ? 'interrupted' : 'failed' })
      return errorResult(
        call.id,
        allowed === 'cancelled'
          ? 'Not run: the user stopped the turn.'
          : 'The user rejected this tool call.'
      )
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
    return { callId: call.id, content: output.content, isError: output.isError === true }
  }

  // --- Subagents ------------------------------------------------------------

  /**
   * Run one subagent to the end; its report is the agent call's result. A
   * failure is an error result, and the main agent decides what to do next.
   */
  private async runSubagent(
    chatId: string,
    session: Session,
    tools: Tool[],
    request: Pick<Request, 'system' | 'tools'>,
    choice: Choice,
    callId: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<ToolResult> {
    const cwd = store.getProject(store.getChat(chatId).projectId).path
    const item: ToolItem = {
      kind: 'tool',
      id: crypto.randomUUID(),
      title: 'Subagent',
      toolKind: AGENT_TOOL_NAME,
      status: 'pending',
      input: formatRaw(args)
    }
    const fail = (message: string, status: ToolItem['status'] = 'failed'): ToolResult => {
      this.emit(chatId, { ...item, status, output: message })
      return errorResult(callId, message)
    }
    let task: SubagentTask
    try {
      task = parseTask(args, cwd)
    } catch (error) {
      this.emit(chatId, item)
      return fail((error as Error).message)
    }
    item.title = `${task.type === 'explore' ? 'Explore' : 'Implement'}: ${task.description}`
    item.input = task.prompt
    this.emit(chatId, item)

    // Implementers running at once never share a file.
    let owners = this.owners.get(chatId)
    if (!owners) this.owners.set(chatId, (owners = new Map()))
    const taken = task.files.find((file) => owners.has(file))
    if (taken) {
      return fail(
        `${taken} belongs to another implement subagent that is still running. Wait for its report, or give this one other files.`
      )
    }
    for (const file of task.files) owners.set(file, item.id)

    let limiter = this.limiters.get(chatId)
    if (!limiter) this.limiters.set(chatId, (limiter = new Limiter(MAX_PARALLEL)))
    let started = false
    try {
      await limiter.acquire(signal)
      started = true
      this.emit(chatId, { ...item, status: 'in_progress' })
      const report = await this.subagentLoop(
        chatId,
        session,
        tools,
        request,
        choice,
        task,
        item.id,
        signal
      )
      this.emit(chatId, { ...item, status: 'completed', output: limitOutput(report) })
      return { callId, content: [{ type: 'text', text: limitOutput(report) }], isError: false }
    } catch (error) {
      return signal.aborted
        ? fail('Not finished: the user stopped the turn.', 'interrupted')
        : fail(`The subagent failed: ${(error as Error).message}`)
    } finally {
      if (started) limiter.release()
      for (const file of task.files) if (owners.get(file) === item.id) owners.delete(file)
    }
  }

  /**
   * A subagent's own loop: the chat's system prompt and tools (so its requests
   * read the cached prefix), its brief as the first message, and a transcript
   * kept only while it runs. Its last text is its report.
   */
  private async subagentLoop(
    chatId: string,
    session: Session,
    tools: Tool[],
    { system, tools: specs }: Pick<Request, 'system' | 'tools'>,
    choice: Choice,
    task: SubagentTask,
    parentId: string,
    signal: AbortSignal
  ): Promise<string> {
    const turns: Turn[] = [{ role: 'user', content: [{ type: 'text', text: brief(task) }] }]
    let report = ''
    for (let step = 1; ; step++) {
      signal.throwIfAborted()
      const reply = await this.reply(chatId, { system, tools: specs, turns }, choice, signal)
      signal.throwIfAborted()
      if (reply.turn.text || reply.turn.toolCalls.length > 0) turns.push(reply.turn)
      if (reply.turn.text) report = reply.turn.text
      if (reply.stop === 'context_full') throw new Error('its context window filled up.')
      if (reply.turn.toolCalls.length === 0)
        return report || 'The subagent finished without a report.'
      if (step > MAX_REQUESTS) {
        return `${report}\n\n(The subagent reached its step limit before it reported.)`.trim()
      }
      const results =
        reply.stop === 'max_tokens'
          ? reply.turn.toolCalls.map((call) =>
              errorResult(
                call.id,
                'Not run: the reply hit the output limit, so the arguments may be cut off. Call the tool again with complete arguments.'
              )
            )
          : await this.runCalls(chatId, session, tools, reply.turn, signal, {
              subagent: task,
              parentId
            })
      turns.push({ role: 'tool', results })
      if (step === MAX_REQUESTS) {
        turns.push({ role: 'user', content: [{ type: 'text', text: STEP_LIMIT_NOTE }] })
      }
    }
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
