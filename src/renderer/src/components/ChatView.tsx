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
import { CheckIcon, FileIcon, LockIcon } from './icons'

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
  const replies = useMemo(() => finalReplies(items, chat.running), [items, chat.running])

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
          {items.map((item) => (
            <Item key={item.id} item={item} chatId={chat.id} reply={replies.has(item.id)} />
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

/**
 * The text that closes each finished turn: the agent's messages after its last
 * step. The timeline ends above them. A turn still running has no closing text yet.
 */
function finalReplies(items: ChatItem[], running: boolean): Set<string> {
  const replies = new Set<string>()
  let trailing = !running
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'user') trailing = true
    else if (trailing && item.kind === 'text') replies.add(item.id)
    // Requests bypass mode approved are not shown, so they do not end the reply.
    else if (!(item.kind === 'permission' && item.auto)) trailing = false
  }
  return replies
}
type PlanEntry = Extract<ChatItem, { kind: 'plan' }>['entries'][number]

/**
 * Every item is a step on the timeline: a node on the line at the left, then the
 * step itself. Tool calls take one row: what they did, on what, and the result.
 */
const Item = memo(function Item({
  item,
  chatId,
  reply
}: {
  item: ChatItem
  chatId: string
  /** The agent's closing answer: shown under the timeline, off the line. */
  reply: boolean
}): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return (
        <div className="step user">
          <div className="step-body">
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
        <div className={reply ? 'step reply' : 'step say'}>
          <div
            className="step-body markdown"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
          />
        </div>
      )
    case 'thought':
      // Short one-line thoughts are progress notes between tool calls and stay
      // visible; longer ones are the model's raw reasoning and fold away.
      if (item.text.length <= THOUGHT_INLINE_MAX && !item.text.trim().includes('\n')) {
        return (
          <div className="step think">
            <div className="step-body">{item.text}</div>
          </div>
        )
      }
      return <Thinking text={item.text} />
    case 'tool':
      return <ToolStep tool={item} />
    case 'plan':
      return <PlanStep entries={item.entries} />
    case 'permission': {
      // Bypass mode approved it; nothing to show.
      if (item.auto) return <></>
      if (item.resolved) {
        const choice = item.options.find((o) => o.optionId === item.resolved)
        const allowed = choice?.kind.startsWith('allow')
        return (
          <div className="step resolved">
            <div className="step-line">
              <span className="step-kind">
                {item.resolved === 'cancelled' ? 'Cancelled' : allowed ? 'Allowed' : 'Denied'}
              </span>
              <span className="step-target">{toolLabel(item.title)}</span>
            </div>
          </div>
        )
      }
      const args = item.title.includes(':') ? item.title.slice(item.title.indexOf(':') + 1) : ''
      // Refusing on the left, the usual answer on the far right.
      const options = [...item.options].sort((a, b) => OPTION_ORDER[a.kind] - OPTION_ORDER[b.kind])
      return (
        <div className="step ask">
          <div className="ask-box">
            <div className="ask-text">
              <div className="ask-question">
                Allow <span className="ask-tool">{toolLabel(item.title)}</span>?
              </div>
              {args.trim() && <div className="ask-args">{args.trim()}</div>}
              {item.outside && (
                <div className="permission-note">
                  <LockIcon width={12} height={12} /> Outside the project: {item.outside}
                </div>
              )}
            </div>
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
        </div>
      )
    }
    case 'error':
      return (
        <div className="step error">
          <div className="step-body">{item.text}</div>
        </div>
      )
    case 'notice':
      return (
        <div className="step notice">
          <div className="step-body">{item.text}</div>
        </div>
      )
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

/** One tool call. Edits show their diff; other output opens on click. */
function ToolStep({ tool }: { tool: ToolItem }): React.JSX.Element {
  const lines = outputLines(tool)
  const isDiff = lines.some((l) => lineClass(l) === 'diff-add' || lineClass(l) === 'diff-del')
  const [open, setOpen] = useState(isDiff)
  const [all, setAll] = useState(false)
  const [kind, target] = toolKindAndTarget(tool)
  // A read's output is the file itself, already summed up as its line count.
  const expandable = lines.length > 0 && tool.toolKind !== 'read'
  const hidden = lines.length - OUTPUT_PREVIEW
  const shown = all || hidden <= 0 ? lines : lines.slice(0, OUTPUT_PREVIEW)
  return (
    <div className={`step tool ${tool.status}`}>
      <button
        className="step-line"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="step-kind">{kind}</span>
        <span className="step-target">{target}</span>
        <span className="step-result">
          <ToolResult tool={tool} lines={lines} />
        </span>
      </button>
      {expandable && open && (
        <div className="step-output">
          {shown.map((line, index) => (
            <div key={index} className={lineClass(line)}>
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
}

/** Long reasoning, folded to one row. */
function Thinking({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="step think">
      <button className="step-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="step-kind">Thinking</span>
        <span className="step-target step-prose">{open ? '' : text.split('\n')[0]}</span>
      </button>
      {open && (
        <div
          className="step-output markdown thought-body"
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

/** A todo update on the timeline: one row with the current item, the list on click. */
function PlanStep({ entries }: { entries: PlanEntry[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const done = entries.filter((e) => e.status === 'completed').length
  const current = entries.find((e) => e.status !== 'completed') ?? entries[entries.length - 1]
  return (
    <div className="step plan">
      <button className="step-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="step-kind">Todos</span>
        <span className="step-target step-prose">{current?.content}</span>
        <span className="step-result">
          {done} of {entries.length}
        </span>
      </button>
      {open && (
        <div className="step-output plain">
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
    <div className="step working">
      <div className="step-body">
        Working… <span className="working-time">{seconds}s, Esc to stop</span>
      </div>
    </div>
  )
}
