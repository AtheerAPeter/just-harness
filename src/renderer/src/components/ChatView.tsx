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
import { CheckIcon, ChevronIcon, FileIcon, LockIcon, ShieldIcon } from './icons'

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
          {blocks.map((block, index) =>
            block.kind === 'tools' ? (
              <ToolGroup key={block.id} tools={block.tools} />
            ) : (
              <Item
                key={block.item.id}
                item={block.item}
                chatId={chat.id}
                live={chat.running && index === blocks.length - 1}
              />
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

/** What the chat shows: single items, and runs of tool calls grouped into one line. */
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

/** Files a read covered: one, or each file of a batched read (cline's read_files). */
function filesRead(tool: ToolItem): number {
  return tool.output ? Math.max(1, outputResults(tool.output).length) : 1
}

/**
 * What a group of calls did, the way Codex sums it up:
 * "Edited 2 files, explored 3 files, 1 search, ran 1 command".
 */
function groupSummary(tools: ToolItem[]): string {
  const of = (kind: CallKind): ToolItem[] => tools.filter((t) => callKind(t) === kind)
  const files = of('read').reduce((n, t) => n + filesRead(t), 0)
  const edited = new Set(of('edit').map((t) => toolDetail(t) ?? t.id)).size
  const explored = [
    files > 0 && plural(files, 'file', 'files'),
    of('search').length > 0 && plural(of('search').length, 'search', 'searches'),
    of('fetch').length > 0 && plural(of('fetch').length, 'page', 'pages')
  ].filter(Boolean)
  const parts = [
    edited > 0 && `edited ${plural(edited, 'file', 'files')}`,
    explored.length > 0 && `explored ${explored.join(', ')}`,
    of('run').length > 0 && `ran ${plural(of('run').length, 'command', 'commands')}`,
    of('browser').length > 0 &&
      `took ${plural(of('browser').length, 'browser step', 'browser steps')}`,
    of('other').length > 0 && `used ${plural(of('other').length, 'tool', 'tools')}`
  ].filter((part): part is string => Boolean(part))
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Lines added and removed across a group's edits. */
function diffTotals(tools: ToolItem[]): [number, number] {
  const lines = tools.filter((t) => t.toolKind === 'edit').flatMap(outputLines)
  return [
    lines.filter((l) => lineClass(l) === 'diff-add').length,
    lines.filter((l) => lineClass(l) === 'diff-del').length
  ]
}

function DiffCount({ added, removed }: { added: number; removed: number }): React.JSX.Element {
  return (
    <span className="diff-count">
      {added > 0 && <span className="result-add">+{added}</span>}
      {removed > 0 && <span className="result-del">−{removed}</span>}
    </span>
  )
}

/**
 * A run of tool calls as one line of text. While a call runs, the line says
 * what is happening and shimmers; once done it sums the group up. The calls
 * themselves open underneath on click.
 */
function ToolGroup({ tools }: { tools: ToolItem[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (tools.length === 1) return <CallRow tool={tools[0]} />
  const active = tools.findLast(isRunning)
  const failed = tools.filter((t) => t.status === 'failed').length
  const [added, removed] = diffTotals(tools)
  return (
    <div className={`activity${open ? ' open' : ''}`}>
      <button className="act-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {active ? (
          <span className="act-lead shimmer">
            {callVerb(active)[1]} {toolKindAndTarget(active)[1]}
          </span>
        ) : (
          <span className="act-lead">{groupSummary(tools)}</span>
        )}
        {(added > 0 || removed > 0) && <DiffCount added={added} removed={removed} />}
        {failed > 0 && <span className="result-bad">{failed} failed</span>}
        <ChevronIcon width={10} height={10} className="chevron" />
      </button>
      {open && (
        <div className="act-body">
          {callRows(tools).map((row) =>
            row.kind === 'reads' ? (
              <ReadsRow key={row.tools[0].id} tools={row.tools} />
            ) : (
              <CallRow key={row.tool.id} tool={row.tool} nested />
            )
          )}
        </div>
      )}
    </div>
  )
}

/** Reads in a row read as one line ("Read App.tsx, store.ts"); every other call is its own. */
type CallRowItem = { kind: 'reads'; tools: ToolItem[] } | { kind: 'call'; tool: ToolItem }

function callRows(tools: ToolItem[]): CallRowItem[] {
  const rows: CallRowItem[] = []
  for (const tool of tools) {
    const last = rows.at(-1)
    const plainRead = tool.toolKind === 'read' && tool.status !== 'failed'
    if (plainRead && last?.kind === 'reads') last.tools.push(tool)
    else if (plainRead) rows.push({ kind: 'reads', tools: [tool] })
    else rows.push({ kind: 'call', tool })
  }
  return rows
}

/** Several reads on one line. A read's output is the file itself, so there is nothing to open. */
function ReadsRow({ tools }: { tools: ToolItem[] }): React.JSX.Element {
  const reading = tools.some(isRunning)
  return (
    <div className="call">
      <div className="call-line">
        <span className={`call-verb${reading ? ' shimmer' : ''}`}>
          {reading ? 'Reading' : 'Read'}
        </span>
        <span className="call-target">{tools.map((t) => toolKindAndTarget(t)[1]).join(', ')}</span>
      </div>
    </div>
  )
}

/**
 * One call: its verb, what it acted on, and what came of it. Edits open on
 * their diff; other output opens on click.
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
  const isDiff = lines.some((l) => diffClass(l) === 'diff-add' || diffClass(l) === 'diff-del')
  const [open, setOpen] = useState(nested === true && isDiff)
  const [all, setAll] = useState(false)
  const running = isRunning(tool)
  const [done, doing] = callVerb(tool)
  const target = toolKindAndTarget(tool)[1]
  // A read's output is the file itself, already summed up as its line count.
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
        <span className={`call-verb${running ? ' shimmer' : ''}`}>{running ? doing : done}</span>
        <span className="call-target">{target}</span>
        <CallResult tool={tool} lines={lines} />
        {expandable && <ChevronIcon width={10} height={10} className="chevron" />}
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

/** What came of a call, after its target. Nothing while it runs: the verb shimmers instead. */
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
  if (tool.toolKind === 'read') {
    const files = filesRead(tool)
    return files > 1 ? <span className="call-result">{files} files</span> : null
  }
  if (lines.length === 0) return null
  return <span className="call-result">{plural(lines.length, 'line', 'lines')}</span>
}

/** Reasoning: "Thinking" shimmers while it streams, then folds to "Thought". */
function Thinking({ text, live }: { text: string; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={`activity${open ? ' open' : ''}`}>
      <button className="act-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`act-lead${live ? ' shimmer' : ''}`}>{live ? 'Thinking' : 'Thought'}</span>
        {!open && <span className="act-detail">{text.split('\n')[0]}</span>}
        <ChevronIcon width={10} height={10} className="chevron" />
      </button>
      {open && (
        <div
          className="act-body thinking-body markdown"
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
      {open && (
        <div className="act-body">
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
