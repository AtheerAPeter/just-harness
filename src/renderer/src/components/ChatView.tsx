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
import {
  ChevronIcon,
  FileIcon,
  GlobeIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  ToolIcon
} from './icons'

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
              <div className="tool-group" key={block[0].id}>
                {block.map((tool) => (
                  <ToolRow key={tool.id} tool={tool} />
                ))}
              </div>
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
      return <div className="msg-user">{item.text}</div>
    case 'text':
      return (
        <div
          className="msg-text markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
        />
      )
    case 'thought':
      return (
        <Collapsible className="msg-thought" summary="Thinking">
          <div
            className="markdown"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
          />
        </Collapsible>
      )
    case 'tool':
      return <ToolRow tool={item} />
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
  }
})

/**
 * A short name for a tool call: drops arguments (agents put them after ":") and
 * MCP server prefixes, e.g. "harness_browser__click: {...}" -> "browser · click".
 */
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

/** Icon for an ACP tool kind (read, edit, search, execute, fetch, ...). */
function ToolKindIcon({ kind }: { kind?: string }): React.JSX.Element {
  const size = { width: 13, height: 13 }
  if (kind === 'search') return <SearchIcon {...size} />
  if (kind === 'fetch') return <GlobeIcon {...size} />
  if (kind === 'execute') return <TerminalIcon {...size} />
  if (kind === 'read') return <FileIcon {...size} />
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return <PencilIcon {...size} />
  return <ToolIcon {...size} />
}

function ToolRow({ tool }: { tool: ToolItem }): React.JSX.Element {
  return (
    <div className={`msg-tool ${tool.status}`}>
      <span className="status-dot" />
      <ToolKindIcon kind={tool.toolKind} />
      <span className="tool-name">{toolLabel(tool.title)}</span>
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
