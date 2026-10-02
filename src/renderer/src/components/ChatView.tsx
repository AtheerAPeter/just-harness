import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { ChevronIcon, FileIcon, LockIcon } from './icons'

interface ChatViewProps {
  chat: Chat
  statuses: Partial<Record<AgentId, AgentStatus>>
  projectPath: string
  onAgentChange: (agent: AgentId) => void
  onOptionChange: (optionId: string, value: string) => void
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
            <Item key={item.id} item={item} chatId={chat.id} />
          ))}
          {chat.running && <Working />}
        </div>
      </div>
      <div className="composer-wrap">
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

const Item = memo(function Item({
  item,
  chatId
}: {
  item: ChatItem
  chatId: string
}): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user">
          <span className="bullet">&gt;</span>
          <div className="msg-body">
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
        <div className="msg-text">
          <span className="bullet">●</span>
          <div
            className="msg-body markdown"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
          />
        </div>
      )
    case 'thought':
      // Short one-line thoughts are progress notes between tool calls and stay
      // visible; longer ones are the model's raw reasoning and fold away.
      if (item.text.length <= THOUGHT_INLINE_MAX && !item.text.trim().includes('\n')) {
        return (
          <div className="msg-thought">
            <span className="bullet">✻</span>
            <div className="msg-body">{item.text}</div>
          </div>
        )
      }
      return (
        <Collapsible className="msg-thought-block" summary="✻ Thinking…">
          <div
            className="markdown thought-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
          />
        </Collapsible>
      )
    case 'tool':
      return <ToolCall tool={item} />
    case 'plan':
      return (
        <div className="msg-plan">
          <div className="tool-head">
            <span className="bullet">●</span>
            <span className="tool-name">Update Todos</span>
          </div>
          <div className="tool-result">
            <span className="elbow">⎿</span>
            <div>
              {item.entries.map((entry, index) => (
                <div key={index} className={`plan-entry ${entry.status}`}>
                  <span>{entry.status === 'completed' ? '☒' : '☐'}</span>
                  {entry.content}
                </div>
              ))}
            </div>
          </div>
        </div>
      )
    case 'permission':
      // Bypass mode approved it; nothing to show.
      if (item.auto) return <></>
      if (item.resolved) {
        const choice = item.options.find((o) => o.optionId === item.resolved)
        const allowed = choice?.kind.startsWith('allow')
        return (
          <div className="msg-tool">
            {item.resolved === 'cancelled' ? 'Cancelled' : allowed ? 'Allowed' : 'Denied'}{' '}
            {toolLabel(item.title)}
          </div>
        )
      }
      return (
        <div className="msg-permission">
          <div className="permission-title">Allow {toolLabel(item.title)}?</div>
          {item.outside && (
            <div className="permission-note">
              <LockIcon width={12} height={12} /> Outside the project: {item.outside}
            </div>
          )}
          <div className="permission-actions">
            {item.options.map((option) => (
              <button
                key={option.optionId}
                className={option.kind.startsWith('allow') ? 'btn primary' : 'btn'}
                onClick={() => window.api.resolvePermission(chatId, item.id, option.optionId)}
              >
                {option.name}
              </button>
            ))}
          </div>
        </div>
      )
    case 'error':
      return <div className="msg-error">{item.text}</div>
    case 'notice':
      return <div className="msg-notice">{item.text}</div>
  }
})

/**
 * A short name for a tool call: drops arguments (agents put them after ":") and
 * MCP server prefixes, e.g. "harness_browser__click: {...}" -> "browser · click".
 */
/** Thoughts up to this length on one line are shown inline instead of folded. */
const THOUGHT_INLINE_MAX = 300

function toolLabel(title: string): string {
  const name = title.split(':')[0].trim()
  const mcp = name.match(/^harness_(\w+?)_{1,2}(\w+)$/)
  const label = mcp ? `${humanize(mcp[1])} · ${humanize(mcp[2])}` : humanize(name)
  return label.length > 60 ? `${label.slice(0, 59)}…` : label
}

/** "fetch_web_content" -> "Fetch web content" */
function humanize(name: string): string {
  const words = name.replace(/[_.]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/** Result lines shown under a tool call before the rest folds away. */
const RESULT_PREVIEW = 3

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
      // Absolute paths keep their informative end: ".../05-buying-clothes/story.js".
      const parts = first.split('/')
      const text =
        first.startsWith('/') && parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : first
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

/** The lines under "⎿": a summary for reads, otherwise the output itself. */
function resultLines(tool: ToolItem): string[] {
  const output = tool.output?.replace(/\s+$/, '')
  if (!output) {
    if (tool.status === 'pending' || tool.status === 'in_progress') return ['Running…']
    return [tool.status === 'failed' ? 'Failed' : 'Done']
  }
  const results = outputResults(output)
  if (tool.toolKind === 'read' && tool.status === 'completed') {
    if (results.length > 1) return [`Read ${results.length} files`]
    const count = results[0].split('\n').length
    return [`Read ${count} line${count === 1 ? '' : 's'}`]
  }
  return results.join('\n').split('\n')
}

/** Diff lines get Claude Code's red/green rows. */
function lineClass(line: string): string | undefined {
  if (line.startsWith('--- ')) return 'diff-file'
  if (line.startsWith('+ ')) return 'diff-add'
  if (line.startsWith('- ')) return 'diff-del'
  return undefined
}

/** Claude Code's names for the ACP tool kinds. */
const KIND_NAMES: Record<string, string> = {
  read: 'Read',
  edit: 'Update',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  execute: 'Bash',
  fetch: 'Fetch'
}

/**
 * The name shown before "(detail)". Some agents title a call with the tool's id
 * ("read_files: ..."), others with what it does ("ls -la episodes"); the latter
 * would repeat the detail, so those calls are named by their kind instead.
 */
function toolName(tool: ToolItem): string {
  const head = tool.title.split(':')[0].trim()
  const isId = /^[\w.-]+$/.test(head) && !toolDetail(tool)?.startsWith(head)
  if (!isId && tool.toolKind && KIND_NAMES[tool.toolKind]) return KIND_NAMES[tool.toolKind]
  return toolLabel(tool.title)
}

/** One tool call, laid out like Claude Code: "⏺ Name(detail)" and its result under "⎿". */
function ToolCall({ tool }: { tool: ToolItem }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const detail = toolDetail(tool)
  const lines = resultLines(tool)
  const hidden = lines.length - RESULT_PREVIEW
  const shown = open || hidden <= 0 ? lines : lines.slice(0, RESULT_PREVIEW)
  return (
    <div className={`tool-call ${tool.status}`}>
      <div className="tool-head">
        <span className="bullet">●</span>
        <span className="tool-title">
          <span className="tool-name">{toolName(tool)}</span>
          {detail && <span className="tool-detail">({detail})</span>}
        </span>
      </div>
      <div className="tool-result">
        <span className="elbow">⎿</span>
        <div className="tool-lines">
          {shown.map((line, index) => (
            <div key={index} className={lineClass(line)}>
              {line || ' '}
            </div>
          ))}
          {hidden > 0 && (
            <button className="tool-more" onClick={() => setOpen((o) => !o)}>
              {open ? 'Show less' : `… +${hidden} line${hidden === 1 ? '' : 's'} (click to expand)`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Claude Code's spinner glyphs, cycled while the agent works. */
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']

function Working(): React.JSX.Element {
  const [frame, setFrame] = useState(0)
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER.length)
      setSeconds(Math.floor((Date.now() - started) / 1000))
    }, 120)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="working">
      <span className="bullet">{SPINNER[frame]}</span>
      <span>
        Working… <span className="working-time">({seconds}s)</span>
      </span>
    </div>
  )
}

function Collapsible({
  className,
  summary,
  children
}: {
  className: string
  summary: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={`${className} collapsible${open ? ' open' : ''}`}>
      <button className="collapsible-summary" onClick={() => setOpen((o) => !o)}>
        <ChevronIcon width={12} height={12} className="chevron" />
        {summary}
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  )
}
