import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentCommand,
  AgentId,
  AgentOption,
  AgentStatus,
  Chat,
  ChatItem,
  Skill
} from '../../../shared/types'
import { renderMarkdown } from '../lib/markdown'
import { Composer } from './Composer'
import { Collapse } from './Collapse'
import {
  BookIcon,
  CheckIcon,
  ChevronIcon,
  DiffIcon,
  FileIcon,
  GlobeIcon,
  LockIcon,
  PencilIcon,
  SearchIcon,
  ShieldIcon,
  TerminalIcon,
  WrenchIcon
} from './icons'

interface ChatViewProps {
  chat: Chat
  statuses: Partial<Record<AgentId, AgentStatus>>
  projectPath: string
  onAgentChange: (agent: AgentId, settings: Record<string, string>) => void
  onOptionChange: (optionId: string, value: string) => Promise<void>
}

export function ChatView({
  chat,
  statuses,
  projectPath,
  onAgentChange,
  onOptionChange
}: ChatViewProps): React.JSX.Element {
  const [items, setItems] = useState<ChatItem[]>([])
  const [options, setOptions] = useState<AgentOption[]>()
  const [optionsError, setOptionsError] = useState<string>()
  const [commands, setCommands] = useState<AgentCommand[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const plan = useMemo(() => items.findLast((i) => i.kind === 'plan'), [items])
  const turns = useMemo(() => toTurns(items), [items])
  /** Items there when the chat opened; only ones that arrive after animate in. */
  const [loaded, setLoaded] = useState<Set<string>>()

  useEffect(() => {
    let cancelled = false
    stickToBottom.current = true
    window.api.getMessages(chat.id).then((loaded) => {
      if (cancelled) return
      setItems(loaded)
      setLoaded(new Set(loaded.map((item) => item.id)))
    })
    // Streaming sends an update per chunk, often faster than the screen redraws,
    // so updates are collected and applied once per frame.
    let queued = new Map<string, ChatItem>()
    let frame = 0
    const apply = (): void => {
      frame = 0
      const updates = queued
      queued = new Map()
      setItems((current) => {
        const next = current.slice()
        const index = new Map(next.map((item, i) => [item.id, i]))
        for (const item of updates.values()) {
          const at = index.get(item.id)
          if (at === undefined) {
            index.set(item.id, next.length)
            next.push(item)
          } else next[at] = item
        }
        return next
      })
    }
    const off = window.api.onItem((chatId, item) => {
      if (chatId !== chat.id) return
      queued.set(item.id, item)
      frame ||= requestAnimationFrame(apply)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      off()
    }
  }, [chat.id])

  // Opening the chat starts its agent session, whose options (model, mode, ...) fill the pickers.
  useEffect(() => {
    let cancelled = false
    window.api.openChat(chat.id).then((result) => {
      if (cancelled) return
      setOptions(result.options)
      setCommands(result.commands)
      setOptionsError(result.error)
    })
    const offOptions = window.api.onOptions((chatId, next) => {
      if (chatId === chat.id) setOptions(next)
    })
    const offCommands = window.api.onCommands((chatId, next) => {
      if (chatId === chat.id) setCommands(next)
    })
    return () => {
      cancelled = true
      offOptions()
      offCommands()
    }
  }, [chat.id])

  // Skills for the / menu. Re-read on focus so skills edited elsewhere show up.
  useEffect(() => {
    const load = (): void => {
      window.api.skills.list(projectPath).then(setSkills)
    }
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [projectPath])

  // Escape stops the agent, unless something else used the key first (a menu, a rename field).
  useEffect(() => {
    if (!chat.running) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing) window.api.cancel(chat.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [chat.id, chat.running])

  // Follow new output unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [items, chat.running])

  return (
    <div className="chat">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="chat-items">
          {items.length === 0 && (
            <div className="chat-empty">
              <h2>{chat.title === 'New chat' ? 'What should we build?' : chat.title}</h2>
              <p>Pick an agent and model below. The agent works inside this project’s folder.</p>
            </div>
          )}
          {turns.map((turn, index) => (
            <TurnView
              key={turn.id}
              turn={turn}
              chatId={chat.id}
              projectPath={projectPath}
              live={chat.running && index === turns.length - 1}
              loaded={loaded}
            />
          ))}
          {chat.running && !chat.waiting && <Working />}
        </div>
      </div>
      <div className="composer-wrap">
        {plan?.entries.some((e) => e.status !== 'completed') && (
          <TodoStrip entries={plan.entries} />
        )}
        <Composer
          chat={chat}
          statuses={statuses}
          options={options}
          optionsError={optionsError}
          commands={commands}
          skills={skills}
          started={items.some((i) => i.kind === 'user')}
          projectPath={projectPath}
          onAgentChange={onAgentChange}
          onOptionChange={onOptionChange}
        />
      </div>
    </div>
  )
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type PlanEntry = Extract<ChatItem, { kind: 'plan' }>['entries'][number]

/**
 * What a turn's work shows: single items, runs of tool calls grouped into one
 * line, and subagents, each one line with the calls it made underneath.
 */
type Block =
  | { kind: 'item'; item: Exclude<ChatItem, ToolItem> }
  | { kind: 'tools'; id: string; tools: ToolItem[] }
  | { kind: 'agent'; item: ToolItem; steps: ToolItem[] }

function toBlocks(items: ChatItem[]): Block[] {
  const steps = new Map<string, ToolItem[]>()
  for (const item of items) {
    if (item.kind !== 'tool' || !item.parentId) continue
    const list = steps.get(item.parentId)
    if (list) list.push(item)
    else steps.set(item.parentId, [item])
  }
  const blocks: Block[] = []
  for (const item of items) {
    // Requests bypass mode approved are not shown, so they do not split a group.
    if (item.kind === 'permission' && item.auto) continue
    // A subagent's calls are shown under it.
    if (item.kind === 'tool' && item.parentId) continue
    const last = blocks.at(-1)
    if (item.kind === 'tool' && item.toolKind === 'agent') {
      blocks.push({ kind: 'agent', item, steps: steps.get(item.id) ?? [] })
    } else if (item.kind !== 'tool') blocks.push({ kind: 'item', item })
    else if (last?.kind === 'tools') last.tools.push(item)
    // The group is keyed by its first call, which stays first while the group grows.
    else blocks.push({ kind: 'tools', id: item.id, tools: [item] })
  }
  return blocks
}

type UserItem = Extract<ChatItem, { kind: 'user' }>

/**
 * A message and what the agent did with it, as Codex shows a turn: the work
 * (its commentary on the way and its tool calls) and the final answer after
 * it. The work ends with the last tool call, thought or permission request;
 * the text after that is the answer. Text still streaming at the end counts as
 * the answer until a tool call follows it.
 */
interface Turn {
  id: string
  user?: UserItem
  work: ChatItem[]
  answer: ChatItem[]
}

const WORK_KINDS = new Set<ChatItem['kind']>(['tool', 'thought', 'plan', 'permission'])

function toTurns(items: ChatItem[]): Turn[] {
  const groups: { user?: UserItem; items: ChatItem[] }[] = []
  for (const item of items) {
    if (item.kind === 'user') groups.push({ user: item, items: [] })
    else if (groups.length > 0) groups.at(-1)!.items.push(item)
    else groups.push({ items: [item] })
  }
  return groups.map(({ user, items: turnItems }) => {
    const end = turnItems.findLastIndex((item) => WORK_KINDS.has(item.kind)) + 1
    return {
      id: user?.id ?? turnItems[0].id,
      user,
      work: turnItems.slice(0, end),
      answer: turnItems.slice(end)
    }
  })
}

/** One turn: the message, the work folded under "Worked for …", the answer, and the files edited. */
function TurnView({
  turn,
  chatId,
  projectPath,
  live,
  loaded
}: {
  turn: Turn
  chatId: string
  projectPath: string
  /** The agent is working on this turn. */
  live: boolean
  /** Items there when the chat opened; only ones that arrive after animate in. */
  loaded?: Set<string>
}): React.JSX.Element {
  const work = useMemo(() => toBlocks(turn.work), [turn.work])
  const answer = useMemo(() => toBlocks(turn.answer), [turn.answer])
  const edits = useMemo(() => editedFiles(turn.work, projectPath), [turn.work, projectPath])
  return (
    <>
      {turn.user && (
        <BlockFrame id={turn.user.id} loaded={loaded}>
          <Item item={turn.user} chatId={chatId} live={false} />
        </BlockFrame>
      )}
      {work.length > 0 && (
        <BlockFrame id={`${turn.id}:work`} loaded={loaded}>
          <TurnWork live={live} workedMs={turn.user?.workedMs}>
            {work.map((block, index) => (
              <BlockView
                key={blockId(block)}
                block={block}
                chatId={chatId}
                live={live && answer.length === 0 && index === work.length - 1}
                loaded={loaded}
              />
            ))}
          </TurnWork>
        </BlockFrame>
      )}
      {answer.map((block, index) => (
        <BlockView
          key={blockId(block)}
          block={block}
          chatId={chatId}
          live={live && index === answer.length - 1}
          loaded={loaded}
        />
      ))}
      {!live && edits.length > 0 && (
        <BlockFrame id={`${turn.id}:edits`} loaded={loaded}>
          <EditsCard files={edits} />
        </BlockFrame>
      )}
    </>
  )
}

const blockId = (block: Block): string => (block.kind === 'tools' ? block.id : block.item.id)

/** A block of the chat; ones that arrive while it is open rise in. */
function BlockFrame({
  id,
  loaded,
  children
}: {
  id: string
  loaded?: Set<string>
  children: React.ReactNode
}): React.JSX.Element {
  return <div className={loaded && !loaded.has(id) ? 'block enter' : 'block'}>{children}</div>
}

function BlockView({
  block,
  chatId,
  live,
  loaded
}: {
  block: Block
  chatId: string
  live: boolean
  loaded?: Set<string>
}): React.JSX.Element {
  return (
    <BlockFrame id={blockId(block)} loaded={loaded}>
      {block.kind === 'tools' ? (
        <ToolGroup tools={block.tools} />
      ) : block.kind === 'agent' ? (
        <AgentRow item={block.item} steps={block.steps} />
      ) : (
        <Item item={block.item} chatId={chatId} live={live} />
      )}
    </BlockFrame>
  )
}

/**
 * A turn's work, as Codex shows it: "Activity" while the agent works, then
 * "Worked for 1m 4s" once the turn is done, when it folds away above the
 * answer. A click opens or folds it at any time.
 */
function TurnWork({
  live,
  workedMs,
  children
}: {
  live: boolean
  workedMs?: number
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(live)
  // Open while the agent works, folded when it finishes (React's pattern for
  // state that follows a prop: compare with the value at the last render).
  const [wasLive, setWasLive] = useState(live)
  if (wasLive !== live) {
    setWasLive(live)
    setOpen(live)
  }
  const label = !live && workedMs !== undefined ? `Worked for ${workedFor(workedMs)}` : 'Activity'
  return (
    <div className={`turn-work${open ? ' open' : ''}`}>
      <button className="turn-work-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
        <ChevronIcon width={11} height={11} className="chevron" />
      </button>
      <Collapse open={open} className="turn-work-body">
        {children}
      </Collapse>
    </div>
  )
}

/** "45s", "1m 4s", "1h 2m": how long a turn took, as Codex writes it. */
function workedFor(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

const Item = memo(function Item({
  item,
  chatId,
  live
}: {
  item: Exclude<ChatItem, ToolItem>
  chatId: string
  /** The last thing in the chat while the agent works on it. */
  live: boolean
}): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return (
        <div className="user-msg">
          <div className="bubble">
            {item.text}
            {item.attachments && (
              <div className="msg-attachments">
                {item.attachments.map((a, index) => (
                  <span className="attachment" key={index}>
                    <FileIcon width={12} height={12} />
                    <span className="attachment-name">{a.name}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )
    case 'text':
      return (
        <div
          className="say markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
        />
      )
    case 'thought':
      // Short one-line thoughts are progress notes between tool calls and stay
      // visible; longer ones are the model's raw reasoning and fold away.
      if (item.text.length <= THOUGHT_INLINE_MAX && !item.text.trim().includes('\n')) {
        return <div className="note">{item.text}</div>
      }
      return <Thinking text={item.text} live={live} />
    case 'plan':
      return <PlanStep entries={item.entries} />
    case 'permission': {
      if (item.resolved) {
        const choice = item.options.find((o) => o.optionId === item.resolved)
        const allowed = choice?.kind.startsWith('allow')
        return (
          <div className="resolved">
            {item.resolved === 'cancelled' ? 'Cancelled' : allowed ? 'Allowed' : 'Denied'}{' '}
            <span className="resolved-tool">{toolLabel(item.title)}</span>
          </div>
        )
      }
      const args = item.title.includes(':') ? item.title.slice(item.title.indexOf(':') + 1) : ''
      // Refusing on the left, the usual answer on the far right.
      const options = [...item.options].sort((a, b) => OPTION_ORDER[a.kind] - OPTION_ORDER[b.kind])
      return (
        <div className="ask-card">
          <div className="ask-head">
            <span className="ask-icon">
              <ShieldIcon width={15} height={15} />
            </span>
            <div className="ask-question">
              Allow <span className="ask-tool">{toolLabel(item.title)}</span>?
            </div>
          </div>
          {args.trim() && <div className="ask-args">{args.trim()}</div>}
          {item.outside && (
            <div className="permission-note">
              <LockIcon width={12} height={12} /> Outside the project: {item.outside}
            </div>
          )}
          <div className="ask-actions">
            {options.map((option, index) => (
              <button
                key={option.optionId}
                className={index === options.length - 1 ? 'btn primary' : 'btn'}
                onClick={() => window.api.resolvePermission(chatId, item.id, option.optionId)}
              >
                {option.name}
              </button>
            ))}
          </div>
        </div>
      )
    }
    case 'error':
      return <div className="chat-error">{item.text}</div>
    case 'notice':
      return <div className="chat-notice">{item.text}</div>
  }
})

/** Where each kind of permission answer sits in the row of buttons. */
const OPTION_ORDER: Record<string, number> = {
  reject_always: 0,
  reject_once: 1,
  allow_always: 2,
  allow_once: 3
}

/** Thoughts up to this length on one line are shown inline instead of folded. */
const THOUGHT_INLINE_MAX = 300

/** Output lines shown under an open step before the rest folds away. */
const OUTPUT_PREVIEW = 12

const BROWSER_TOOL = /^harness_browser_{1,2}(\w+)/

/**
 * A short name for a tool call: drops arguments (agents put them after ":") and
 * MCP server prefixes, e.g. "harness_browser__click: {...}" -> "Browser · click".
 */
function toolLabel(title: string): string {
  const name = title.split(':')[0].trim()
  const mcp = name.match(/^harness_(\w+?)_{1,2}(\w+)$/)
  // Snake-case tool ids read better humanized; commands and paths stay as typed.
  const label = mcp
    ? `${humanize(mcp[1])} · ${humanize(mcp[2])}`
    : /^[a-z]+(_[a-z]+)+$/i.test(name)
      ? humanize(name)
      : shortPath(name)
  return label.length > 60 ? `${label.slice(0, 59)}…` : label
}

/** Absolute paths keep their informative end: ".../05-buying-clothes/story.js". */
function shortPath(text: string): string {
  const parts = text.split('/')
  return text.startsWith('/') && parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : text
}

/** "fetch_web_content" -> "Fetch web content" */
function humanize(name: string): string {
  const words = name.replace(/[_.]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A short detail for a call: the URL, path, command or query it acted on. */
function toolDetail(tool: ToolItem): string | undefined {
  if (!tool.input) return undefined
  let input: unknown
  try {
    input = JSON.parse(tool.input)
  } catch {
    return undefined
  }
  if (!input || typeof input !== 'object') return undefined
  const fields = input as Record<string, unknown>
  for (const key of [
    'url',
    'path',
    'filePath',
    'command',
    'commands',
    'query',
    'queries',
    'pattern',
    'files'
  ]) {
    const value = fields[key]
    let first = Array.isArray(value) ? value[0] : value
    // Cline lists files as objects: {"files": [{"path": "..."}]}.
    if (first && typeof first === 'object') first = (first as Record<string, unknown>).path
    if (typeof first === 'string' && first) {
      const text = shortPath(first)
      return text.length > 80 ? `${text.slice(0, 79)}…` : text
    }
  }
  return undefined
}

/**
 * The output's text. Cline answers batched tools (run_commands, read_files,
 * search_codebase) with a JSON list of {query, result}; those become their results.
 */
function outputResults(output: string): string[] {
  try {
    const parsed: unknown = JSON.parse(output)
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((entry) => typeof entry?.result === 'string')
    )
      return parsed.map((entry: { result: string }) => entry.result.replace(/\s+$/, ''))
  } catch {
    // Plain text output.
  }
  return [output]
}

/** The call's output as lines, or none. */
function outputLines(tool: ToolItem): string[] {
  const output = tool.output?.replace(/\s+$/, '')
  return output ? outputResults(output).join('\n').split('\n') : []
}

/** Diff lines get red and green rows. */
function lineClass(line: string): string | undefined {
  if (line.startsWith('--- ')) return 'diff-file'
  if (line.startsWith('+ ')) return 'diff-add'
  if (line.startsWith('- ')) return 'diff-del'
  return undefined
}

/** The word in the kind column for each ACP tool kind. */
const KIND_WORDS: Record<string, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  execute: 'Run',
  fetch: 'Fetch'
}

/** The kind column and what the call acted on. */
function toolKindAndTarget(tool: ToolItem): [string, string] {
  const detail = toolDetail(tool)
  const browser = tool.title.match(BROWSER_TOOL)
  if (browser) return ['Browser', [humanize(browser[1]), detail].filter(Boolean).join(' ')]
  const kind = (tool.toolKind && KIND_WORDS[tool.toolKind]) || 'Tool'
  return [kind, detail ?? toolLabel(tool.title)]
}

/** What a call did, for the words that describe it and for summing up a group. */
type CallKind = 'read' | 'search' | 'edit' | 'run' | 'fetch' | 'browser' | 'other'

function callKind(tool: ToolItem): CallKind {
  if (BROWSER_TOOL.test(tool.title)) return 'browser'
  switch (tool.toolKind) {
    case 'read':
    case 'search':
    case 'fetch':
      return tool.toolKind
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit'
    case 'execute':
      return 'run'
    default:
      return 'other'
  }
}

/** The verb for a call, finished and in progress: "Ran" and "Running". */
function callVerb(tool: ToolItem): [string, string] {
  switch (tool.toolKind) {
    case 'delete':
      return ['Deleted', 'Deleting']
    case 'move':
      return ['Moved', 'Moving']
  }
  const verbs: Record<CallKind, [string, string]> = {
    read: ['Read', 'Reading'],
    search: ['Searched', 'Searching'],
    edit: ['Edited', 'Editing'],
    run: ['Ran', 'Running'],
    fetch: ['Fetched', 'Fetching'],
    browser: ['Browser', 'Browser'],
    other: ['Called', 'Calling']
  }
  return verbs[callKind(tool)]
}

const isRunning = (tool: ToolItem): boolean =>
  tool.status === 'pending' || tool.status === 'in_progress'

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

function DiffCount({ added, removed }: { added: number; removed: number }): React.JSX.Element {
  return (
    <span className="diff-count">
      {added > 0 && <span className="result-add">+{added}</span>}
      {removed > 0 && <span className="result-del">−{removed}</span>}
    </span>
  )
}

/**
 * What a group of calls did, in Codex's words and order: "Loaded a tool, read
 * files, ran commands". Each kind of call says so once, and its icon leads the
 * line.
 */
type Category = 'tool' | 'read' | 'edit' | 'run' | 'fetch' | 'browser'

const CATEGORY_ORDER: Category[] = ['tool', 'read', 'edit', 'run', 'fetch', 'browser']

function category(tool: ToolItem): Category {
  const kind = callKind(tool)
  return kind === 'search' ? 'read' : kind === 'other' ? 'tool' : kind
}

/** Each category's words for one call and for several. */
const CATEGORY_WORDS: Record<Category, [string, string]> = {
  tool: ['used a tool', 'used tools'],
  read: ['read a file', 'read files'],
  edit: ['edited a file', 'edited files'],
  run: ['ran a command', 'ran commands'],
  fetch: ['fetched a page', 'fetched pages'],
  browser: ['used the browser', 'used the browser']
}

const CATEGORY_ICONS: Record<Category, (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element> = {
  tool: WrenchIcon,
  read: BookIcon,
  edit: PencilIcon,
  run: TerminalIcon,
  fetch: GlobeIcon,
  browser: GlobeIcon
}

/** The icon of one call, by what it did. */
function CallIcon({ tool }: { tool: ToolItem }): React.JSX.Element {
  const Icon = callKind(tool) === 'search' ? SearchIcon : CATEGORY_ICONS[category(tool)]
  return <Icon width={15} height={15} className="call-icon" />
}

function groupCategories(tools: ToolItem[]): Category[] {
  const present = new Set(tools.map(category))
  return CATEGORY_ORDER.filter((c) => present.has(c))
}

function groupSummary(tools: ToolItem[]): string {
  const text = groupCategories(tools)
    .map((c) => {
      const calls = tools.filter((t) => category(t) === c)
      if (c === 'read' && calls.every((t) => callKind(t) === 'search')) return 'searched the code'
      // Edits count the files they touched, not the calls.
      const count =
        c === 'edit' ? new Set(calls.map((t) => toolDetail(t) ?? t.id)).size : calls.length
      return CATEGORY_WORDS[c][count === 1 ? 0 : 1]
    })
    .join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * A run of tool calls as one line, as Codex shows it: the kinds of calls it
 * made, behind the icon of the first. While a call runs, the line says what is
 * happening and shimmers. One row per call opens underneath on click; a single
 * call is shown as its own row straight away.
 */
function ToolGroup({ tools }: { tools: ToolItem[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (tools.length === 1) return <CallRow tool={tools[0]} />
  const active = tools.findLast(isRunning)
  const failed = tools.filter((t) => t.status === 'failed').length
  const Icon = CATEGORY_ICONS[groupCategories(tools)[0]]
  return (
    <div className={`activity${open ? ' open' : ''}`}>
      <button
        className="act-line tool-line"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon width={15} height={15} className="call-icon" />
        {active ? (
          <span className="act-lead shimmer">
            {callVerb(active)[1]} {toolKindAndTarget(active)[1]}
          </span>
        ) : (
          <span className="act-lead">{groupSummary(tools)}</span>
        )}
        {failed > 0 && <span className="result-bad">{failed} failed</span>}
        <ChevronIcon width={10} height={10} className="chevron" />
      </button>
      <Collapse open={open} className="tool-rows">
        {tools.map((tool) => (
          <CallRow key={tool.id} tool={tool} nested />
        ))}
      </Collapse>
    </div>
  )
}

/**
 * A subagent as one line: what it works on, shimmering while it runs, and how
 * many steps it took. Its calls and its report open underneath on click.
 */
function AgentRow({ item, steps }: { item: ToolItem; steps: ToolItem[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const running = isRunning(item)
  // The title is "Explore: what it does" or "Implement: what it does".
  const split = item.title.indexOf(': ')
  const type = split > 0 ? item.title.slice(0, split) : ''
  const what = split > 0 ? item.title.slice(split + 2) : item.title
  const implement = type === 'Implement'
  const verb = implement
    ? running
      ? 'Implementing'
      : 'Implemented'
    : running
      ? 'Exploring'
      : 'Explored'
  const Icon = implement ? PencilIcon : BookIcon
  const report = useMemo(
    () => (item.status === 'completed' && item.output ? renderMarkdown(item.output) : undefined),
    [item.status, item.output]
  )
  return (
    <div className={`activity${open ? ' open' : ''}`}>
      <button
        className="act-line tool-line"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon width={15} height={15} className="call-icon" />
        <span className={`act-lead${running ? ' shimmer' : ''}`}>{verb}</span>
        <span className="act-detail agent-task">{what}</span>
        {steps.length > 0 && (
          <span className="call-result">{plural(steps.length, 'step', 'steps')}</span>
        )}
        {item.status === 'failed' && <span className="result-bad">failed</span>}
        {item.status === 'interrupted' && <span className="call-result">interrupted</span>}
        <ChevronIcon width={10} height={10} className="chevron" />
      </button>
      <Collapse open={open} className="tool-rows">
        {steps.map((tool) => (
          <CallRow key={tool.id} tool={tool} nested />
        ))}
        {report ? (
          <div className="markdown agent-report" dangerouslySetInnerHTML={{ __html: report }} />
        ) : (
          item.status === 'failed' &&
          item.output && <div className="agent-report">{item.output}</div>
        )}
      </Collapse>
    </div>
  )
}

/**
 * One call, as a Codex row: its icon, verb and what it acted on (a file in a
 * muted, underlined style), and what came of it. Edits open on their diff;
 * other output opens on click.
 */
const CallRow = memo(function CallRow({
  tool,
  nested
}: {
  tool: ToolItem
  /** Inside an open group, under its summary line. */
  nested?: boolean
}): React.JSX.Element {
  const lines = outputLines(tool)
  // Only an edit's output is a diff; a "- " in other output is a list item, not a removed line.
  const diffClass = (line: string): string | undefined =>
    tool.toolKind === 'edit' ? lineClass(line) : undefined
  // Closed until clicked, as in Codex; the turn's edit card has the diffs too.
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  const running = isRunning(tool)
  const [done, doing] = callVerb(tool)
  const target = toolKindAndTarget(tool)[1]
  const file = callKind(tool) === 'read' || callKind(tool) === 'edit'
  // A read's output is the file itself: nothing to open.
  const expandable = lines.length > 0 && tool.toolKind !== 'read'
  const hidden = lines.length - OUTPUT_PREVIEW
  const shown = all || hidden <= 0 ? lines : lines.slice(0, OUTPUT_PREVIEW)
  return (
    <div className={`call${nested ? '' : ' alone'}${open ? ' open' : ''}`}>
      <button
        className="call-line"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <CallIcon tool={tool} />
        <span className={`call-verb${running ? ' shimmer' : ''}`}>{running ? doing : done}</span>
        <span className={`call-target${file ? ' file' : ''}`}>{target}</span>
        <CallResult tool={tool} lines={lines} />
        {expandable && <ChevronIcon width={10} height={10} className="chevron" />}
      </button>
      {expandable && (
        <Collapse open={open} className="step-output">
          {shown.map((line, index) => (
            <div key={index} className={diffClass(line)}>
              {line || ' '}
            </div>
          ))}
          {hidden > 0 && (
            <button className="step-more" onClick={() => setAll((a) => !a)}>
              {all ? 'Show less' : `Show ${hidden} more line${hidden === 1 ? '' : 's'}`}
            </button>
          )}
        </Collapse>
      )}
    </div>
  )
})

/** What came of a call, after its target: a failure, or an edit's line counts. */
function CallResult({
  tool,
  lines
}: {
  tool: ToolItem
  lines: string[]
}): React.JSX.Element | null {
  if (isRunning(tool)) return null
  if (tool.status === 'failed') return <span className="result-bad">failed</span>
  if (tool.status === 'interrupted') return <span className="call-result">interrupted</span>
  if (tool.toolKind === 'edit') {
    const added = lines.filter((l) => lineClass(l) === 'diff-add').length
    const removed = lines.filter((l) => lineClass(l) === 'diff-del').length
    if (added || removed) return <DiffCount added={added} removed={removed} />
  }
  return null
}

/** A file a turn edited, with its diff lines and how many were added and removed. */
interface FileEdit {
  path: string
  added: number
  removed: number
  lines: string[]
}

/**
 * The files a turn's edits touched, in the order first edited, from the edits'
 * diffs ("--- path", then "+ " and "- " lines); subagents' edits included.
 * Paths inside the project are shown relative to it.
 */
function editedFiles(items: ChatItem[], projectPath: string): FileEdit[] {
  const files = new Map<string, FileEdit>()
  for (const item of items) {
    if (item.kind !== 'tool' || item.toolKind !== 'edit' || item.status !== 'completed') continue
    let file: FileEdit | undefined
    for (const line of outputLines(item)) {
      const kind = lineClass(line)
      if (kind === 'diff-file') {
        const absolute = line.slice(4).trim()
        const path = absolute.startsWith(`${projectPath}/`)
          ? absolute.slice(projectPath.length + 1)
          : absolute
        file = files.get(path)
        if (!file) files.set(path, (file = { path, added: 0, removed: 0, lines: [] }))
        continue
      }
      if (!file) continue
      file.lines.push(line)
      if (kind === 'diff-add') file.added++
      else if (kind === 'diff-del') file.removed++
    }
  }
  return [...files.values()].filter((f) => f.added > 0 || f.removed > 0)
}

/**
 * The files a finished turn edited, as Codex's card: the totals, then a row per
 * file with its folder dimmed. A row opens on its diff; "View changes" opens all.
 */
function EditsCard({ files }: { files: FileEdit[] }): React.JSX.Element {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  const allOpen = files.every((f) => open.has(f.path))
  const toggle = (path: string): void =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  return (
    <div className="edits-card">
      <div className="edits-head">
        <span className="edits-icon">
          <DiffIcon width={18} height={18} />
        </span>
        <span className="edits-summary">
          <span className="edits-title">Edited {plural(files.length, 'file', 'files')}</span>
          <DiffCount added={added} removed={removed} />
        </span>
        <button
          className="btn edits-view"
          onClick={() => setOpen(allOpen ? new Set() : new Set(files.map((f) => f.path)))}
        >
          {allOpen ? 'Hide changes' : 'View changes'}
        </button>
      </div>
      {files.map((file) => {
        const slash = file.path.lastIndexOf('/')
        return (
          <div key={file.path} className={`edits-file${open.has(file.path) ? ' open' : ''}`}>
            <button
              className="edits-row"
              aria-expanded={open.has(file.path)}
              onClick={() => toggle(file.path)}
            >
              <span className="edits-path">
                {slash > 0 && <span className="edits-dir">{file.path.slice(0, slash + 1)}</span>}
                {file.path.slice(slash + 1)}
              </span>
              <DiffCount added={file.added} removed={file.removed} />
            </button>
            <Collapse open={open.has(file.path)} className="step-output edits-diff">
              {file.lines.map((line, index) => (
                <div key={index} className={lineClass(line)}>
                  {line || ' '}
                </div>
              ))}
            </Collapse>
          </div>
        )
      })}
    </div>
  )
}

/** Reasoning: "Thinking" shimmers while it streams, then folds to "Thought". */
function Thinking({ text, live }: { text: string; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={`activity${open ? ' open' : ''}`}>
      <button className="act-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`act-lead${live ? ' shimmer' : ''}`}>{live ? 'Thinking' : 'Thought'}</span>
        <span className="act-detail">{text.split('\n')[0]}</span>
        <ChevronIcon width={10} height={10} className="chevron" />
      </button>
      <Collapse open={open} className="act-body thinking-body">
        <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      </Collapse>
    </div>
  )
}

function TodoList({ entries }: { entries: PlanEntry[] }): React.JSX.Element {
  return (
    <div className="todo-list">
      {entries.map((entry, index) => (
        <div key={index} className={`todo ${entry.status}`}>
          <span className="todo-box">
            {entry.status === 'completed' && <CheckIcon width={10} height={10} />}
          </span>
          {entry.content}
        </div>
      ))}
    </div>
  )
}

/** A todo update in the chat: one line with the progress, the list on click. */
function PlanStep({ entries }: { entries: PlanEntry[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const done = entries.filter((e) => e.status === 'completed').length
  return (
    <div className={`activity${open ? ' open' : ''}`}>
      <button className="act-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="act-lead">Updated todos</span>
        <span className="act-detail">
          {done} of {entries.length} done
        </span>
        <ChevronIcon width={10} height={10} className="chevron" />
      </button>
      <Collapse open={open} className="act-body">
        <TodoList entries={entries} />
      </Collapse>
    </div>
  )
}

/** The chat's open todos, pinned above the composer while the agent works through them. */
function TodoStrip({ entries }: { entries: PlanEntry[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const done = entries.filter((e) => e.status === 'completed').length
  const next =
    entries.find((e) => e.status === 'in_progress') ?? entries.find((e) => e.status !== 'completed')
  return (
    <div className={`todo-strip${open ? ' open' : ''}`}>
      <Collapse open={open} className="todo-strip-list">
        <TodoList entries={entries} />
      </Collapse>
      <button className="todo-bar" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="todo-label">Todos</span>
        <span className="todo-bars">
          {entries.map((entry, index) => (
            <i key={index} className={entry.status} />
          ))}
        </span>
        <span>
          {done} of {entries.length}
        </span>
        {next && <span className="todo-next">Next: {next.content}</span>}
      </button>
    </div>
  )
}

/** "12s", then "1m 05s", then "1h 02m 05s", like Codex's status line. */
function elapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = String(seconds % 60).padStart(2, '0')
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${seconds}s`
}

function Working(): React.JSX.Element {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="working">
      <span className="shimmer">Working</span>
      <span className="working-time">{elapsed(seconds)} · Esc to stop</span>
    </div>
  )
}
