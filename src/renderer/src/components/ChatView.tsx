import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
    const off = window.api.onItem((chatId, item) => {
      if (chatId !== chat.id) return
      setItems((current) => {
        const index = current.findIndex((i) => i.id === item.id)
        if (index === -1) return [...current, item]
        const next = current.slice()
        next[index] = item
        return next
      })
    })
    return () => {
      cancelled = true
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
          {groupTools(items).map((block) =>
            Array.isArray(block) ? (
              <ToolRun key={block[0].id} tools={block} />
            ) : (
              <Item key={block.id} item={block} chatId={chat.id} />
            )
          )}
          {chat.running && <div className="working">Working…</div>}
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
      )
    case 'text':
      return (
        <div
          className="msg-text markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
        />
      )
    case 'thought':
      // Short one-line thoughts are progress notes between tool calls and stay
      // visible; longer ones are the model's raw reasoning and fold away.
      if (item.text.length <= THOUGHT_INLINE_MAX && !item.text.trim().includes('\n')) {
        return <div className="msg-thought">{item.text}</div>
      }
      return (
        <Collapsible className="msg-thought-block" summary="Thinking">
          <div
            className="markdown msg-thought"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
          />
        </Collapsible>
      )
    case 'tool':
      return <ToolRun tools={[item]} />
    case 'plan':
      return (
        <div className="msg-plan">
          {item.entries.map((entry, index) => (
            <div key={index} className={`plan-entry ${entry.status}`}>
              <span className="plan-box">{entry.status === 'completed' ? '✓' : ''}</span>
              {entry.content}
            </div>
          ))}
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

/** Runs of consecutive tool calls become one compact block. */
function groupTools(items: ChatItem[]): (ChatItem | ToolItem[])[] {
  const blocks: (ChatItem | ToolItem[])[] = []
  for (const item of items) {
    // Auto-approved permissions render nothing, so they must not split a run.
    if (item.kind === 'permission' && item.auto) continue
    const last = blocks[blocks.length - 1]
    if (item.kind === 'tool' && Array.isArray(last)) last.push(item)
    else blocks.push(item.kind === 'tool' ? [item] : item)
  }
  return blocks
}

/** Runs up to this long show every step; longer ones fold the middle. */
const RUN_FULL = 5

/** A short detail for a step: the URL, path, command or query it acted on. */
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
  for (const key of ['url', 'path', 'filePath', 'command', 'commands', 'query', 'pattern']) {
    const value = fields[key]
    const first = Array.isArray(value) ? value[0] : value
    if (typeof first === 'string' && first) {
      // Absolute paths keep their informative end: ".../05-buying-clothes/story.js".
      const parts = first.split('/')
      const text =
        first.startsWith('/') && parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : first
      return text.length > 60 ? `${text.slice(0, 59)}…` : text
    }
  }
  return undefined
}

/**
 * A run of back-to-back tool calls as a timeline: short runs show every step,
 * longer ones show the first steps, a "+ N more steps" fold, and the latest step.
 */
function ToolRun({ tools }: { tools: ToolItem[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const foldable = tools.length > RUN_FULL
  const shown = foldable && !open ? [...tools.slice(0, 3), tools[tools.length - 1]] : tools
  return (
    <div className="tool-rail">
      {shown.map((tool, index) => (
        <Fragment key={tool.id}>
          {/* The fold toggle stays where it was clicked, in both states. */}
          {foldable && index === 3 && (
            <button className="tool-step more" onClick={() => setOpen((o) => !o)}>
              {open ? 'Show fewer steps' : `+ ${tools.length - 4} more steps`}
            </button>
          )}
          <ToolStep tool={tool} />
        </Fragment>
      ))}
    </div>
  )
}

function ToolStep({ tool }: { tool: ToolItem }): React.JSX.Element {
  const detail = toolDetail(tool)
  return (
    <div className={`tool-step ${tool.status}`}>
      <span className="tool-name">
        {toolLabel(tool.title)}
        {detail && <span className="tool-detail"> {detail}</span>}
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
