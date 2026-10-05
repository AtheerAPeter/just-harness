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
import {
  CheckIcon,
  ChevronIcon,
  CursorIcon,
  FileIcon,
  GlobeIcon,
  ListIcon,
  LockIcon,
  PencilIcon,
  SearchIcon,
  ShieldIcon,
  SparkIcon,
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
  const blocks = useMemo(() => toBlocks(items), [items])

  useEffect(() => {
    let cancelled = false
    stickToBottom.current = true
    window.api.getMessages(chat.id).then((loaded) => {
      if (!cancelled) setItems(loaded)
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
          {blocks.map((block) =>
            block.kind === 'tools' ? (
              <ToolGroup key={block.id} tools={block.tools} />
            ) : (
              <Item key={block.item.id} item={block.item} chatId={chat.id} />
            )
          )}
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

/** What the chat shows: single items, and runs of tool calls grouped into one card. */
type Block =
  | { kind: 'item'; item: Exclude<ChatItem, ToolItem> }
  | { kind: 'tools'; id: string; tools: ToolItem[] }

function toBlocks(items: ChatItem[]): Block[] {
  const blocks: Block[] = []
  for (const item of items) {
    // Requests bypass mode approved are not shown, so they do not split a group.
    if (item.kind === 'permission' && item.auto) continue
    const last = blocks.at(-1)
    if (item.kind !== 'tool') blocks.push({ kind: 'item', item })
    else if (last?.kind === 'tools') last.tools.push(item)
    // The group is keyed by its first call, which stays first while the group grows.
    else blocks.push({ kind: 'tools', id: item.id, tools: [item] })
  }
  return blocks
}

const Item = memo(function Item({
  item,
  chatId
}: {
  item: Exclude<ChatItem, ToolItem>
  chatId: string
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
      return <Thinking text={item.text} />
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

const isRunning = (tool: ToolItem): boolean =>
  tool.status === 'pending' || tool.status === 'in_progress'

/** The kind column and what the call acted on. */
function toolKindAndTarget(tool: ToolItem): [string, string] {
  const detail = toolDetail(tool)
  const browser = tool.title.match(BROWSER_TOOL)
  if (browser) return ['Browser', [humanize(browser[1]), detail].filter(Boolean).join(' ')]
  const kind = (tool.toolKind && KIND_WORDS[tool.toolKind]) || 'Tool'
  return [kind, detail ?? toolLabel(tool.title)]
}

/** The right-hand column: what came of the call. */
function ToolResult({ tool, lines }: { tool: ToolItem; lines: string[] }): React.JSX.Element {
  if (isRunning(tool)) return <span className="spinner" />
  if (tool.status === 'failed') return <span className="result-bad">failed</span>
  if (tool.status === 'interrupted') return <>interrupted</>
  if (tool.toolKind === 'edit') {
    const added = lines.filter((l) => lineClass(l) === 'diff-add').length
    const removed = lines.filter((l) => lineClass(l) === 'diff-del').length
    if (added || removed)
      return (
        <>
          {added > 0 && <span className="result-add">+{added}</span>}{' '}
          {removed > 0 && <span className="result-del">−{removed}</span>}
        </>
      )
  }
  if (tool.toolKind === 'read') {
    const files = tool.output ? outputResults(tool.output).length : 0
    if (files > 1) return <>{files} files</>
  }
  if (lines.length === 0) return <>done</>
  return (
    <>
      {lines.length} line{lines.length === 1 ? '' : 's'}
    </>
  )
}

/** What a call did, for its icon and for naming the group it is in. */
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

const CALL_ICONS: Record<CallKind, (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element> = {
  read: FileIcon,
  search: SearchIcon,
  edit: PencilIcon,
  run: TerminalIcon,
  fetch: GlobeIcon,
  browser: CursorIcon,
  other: WrenchIcon
}

/** How a group sums up its calls of each kind: "2 reads · 1 search". */
const CALL_NOUNS: Record<CallKind, [string, string]> = {
  read: ['read', 'reads'],
  search: ['search', 'searches'],
  edit: ['edit', 'edits'],
  run: ['command', 'commands'],
  fetch: ['fetch', 'fetches'],
  browser: ['browser step', 'browser steps'],
  other: ['tool', 'tools']
}

/** The group's name, from the most telling kind of call in it. */
function groupTitle(kinds: CallKind[]): string {
  if (kinds.includes('edit')) return 'Changed'
  if (kinds.includes('run')) return 'Ran'
  if (kinds.includes('browser')) return 'Browsed'
  if (kinds.every((k) => k === 'other')) return 'Used tools'
  return 'Explored'
}

function CallTile({ kind }: { kind: CallKind }): React.JSX.Element {
  const Icon = CALL_ICONS[kind]
  return (
    <span className="tile">
      <Icon width={13} height={13} />
    </span>
  )
}

/**
 * A run of tool calls as one card: the kinds of call, what they add up to, and
 * one row per call inside. It stays open while a call runs or when it holds a
 * diff; otherwise it folds to its header.
 */
function ToolGroup({ tools }: { tools: ToolItem[] }): React.JSX.Element {
  const [open, setOpen] = useState<boolean>()
  const kinds = tools.map(callKind)
  const distinct = [...new Set(kinds)]
  const counts = distinct.map((kind) => {
    const n = kinds.filter((k) => k === kind).length
    return `${n} ${CALL_NOUNS[kind][n === 1 ? 0 : 1]}`
  })
  const lines = tools.filter((t) => t.toolKind === 'edit').flatMap(outputLines)
  const added = lines.filter((l) => lineClass(l) === 'diff-add').length
  const removed = lines.filter((l) => lineClass(l) === 'diff-del').length
  const failed = tools.filter((t) => t.status === 'failed').length
  const running = tools.some(isRunning)
  const shown = open ?? (running || added + removed > 0)
  return (
    <div className={`tool-group${shown ? ' open' : ''}`}>
      <button className="group-head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <span className="tile-stack">
          {distinct.slice(0, 4).map((kind) => (
            <CallTile key={kind} kind={kind} />
          ))}
        </span>
        <span className="group-title">{groupTitle(distinct)}</span>
        <span className="group-sum">{counts.join(' · ')}</span>
        <span className="spacer" />
        {failed > 0 && <span className="result-bad">{failed} failed</span>}
        {(added > 0 || removed > 0) && (
          <span className="group-diff">
            {added > 0 && <span className="result-add">+{added}</span>}
            {removed > 0 && <span className="result-del">−{removed}</span>}
          </span>
        )}
        {running && <span className="spinner" />}
        <ChevronIcon width={11} height={11} className="chevron" />
      </button>
      {shown && (
        <div className="group-body">
          {tools.map((tool) => (
            <ToolStep key={tool.id} tool={tool} />
          ))}
        </div>
      )}
    </div>
  )
}

/** One tool call. Edits show their diff; other output opens on click. */
const ToolStep = memo(function ToolStep({ tool }: { tool: ToolItem }): React.JSX.Element {
  const lines = outputLines(tool)
  // Only an edit's output is a diff; a "- " in other output is a list item, not a removed line.
  const diffClass = (line: string): string | undefined =>
    tool.toolKind === 'edit' ? lineClass(line) : undefined
  const isDiff = lines.some((l) => diffClass(l) === 'diff-add' || diffClass(l) === 'diff-del')
  const [open, setOpen] = useState(isDiff)
  const [all, setAll] = useState(false)
  const [kind, target] = toolKindAndTarget(tool)
  // A read's output is the file itself, already summed up as its line count.
  const expandable = lines.length > 0 && tool.toolKind !== 'read'
  const hidden = lines.length - OUTPUT_PREVIEW
  const shown = all || hidden <= 0 ? lines : lines.slice(0, OUTPUT_PREVIEW)
  return (
    <div className={`tool-step ${tool.status}`}>
      <button
        className="step-line"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <CallTile kind={callKind(tool)} />
        <span className="step-kind">{kind}</span>
        <span className="step-target">{target}</span>
        <span className="step-result">
          <ToolResult tool={tool} lines={lines} />
        </span>
      </button>
      {expandable && open && (
        <div className="step-output">
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
        </div>
      )}
    </div>
  )
})

/** Long reasoning, folded to one line. */
function Thinking({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={`thinking${open ? ' open' : ''}`}>
      <button className="thinking-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <SparkIcon width={13} height={13} />
        <span className="thinking-label">Thinking</span>
        {!open && <span className="thinking-line">{text.split('\n')[0]}</span>}
      </button>
      {open && (
        <div
          className="thinking-body markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
        />
      )}
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

/** A todo update in the chat: the progress in one row, the list on click. */
function PlanStep({ entries }: { entries: PlanEntry[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const done = entries.filter((e) => e.status === 'completed').length
  return (
    <div className={`plan-card${open ? ' open' : ''}`}>
      <button className="group-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="tile">
          <ListIcon width={13} height={13} />
        </span>
        <span className="group-title">Todos</span>
        <span className="plan-progress">
          <i style={{ width: `${entries.length ? (done / entries.length) * 100 : 0}%` }} />
        </span>
        <span className="group-sum">
          {done} of {entries.length}
        </span>
        <span className="spacer" />
        <ChevronIcon width={11} height={11} className="chevron" />
      </button>
      {open && (
        <div className="plan-body">
          <TodoList entries={entries} />
        </div>
      )}
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
      {open && <TodoList entries={entries} />}
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

function Working(): React.JSX.Element {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="working">
      <span className="spinner" />
      Working… <span className="working-time">{seconds}s, Esc to stop</span>
    </div>
  )
}
