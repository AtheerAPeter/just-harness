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
import { ChevronIcon } from './icons'

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
          {items.map((item) => (
            <Item key={item.id} item={item} chatId={chat.id} />
          ))}
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
      return (
        <Collapsible
          className="msg-tool"
          summary={
            <>
              <span className={`status-dot ${item.status}`} />
              <span className="tool-title">{item.title}</span>
              {item.toolKind && item.toolKind !== 'other' && (
                <span className="tool-kind">{item.toolKind}</span>
              )}
            </>
          }
        >
          {item.input && (
            <>
              <div className="tool-label">Input</div>
              <pre>{item.input}</pre>
            </>
          )}
          {item.output && (
            <>
              <div className="tool-label">Output</div>
              <pre>{item.output}</pre>
            </>
          )}
          {!item.input && !item.output && <div className="tool-label">No details</div>}
        </Collapsible>
      )
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
      return (
        <div className="msg-permission">
          <div className="permission-title">
            Allow <strong>{item.title}</strong>?
          </div>
          {item.resolved ? (
            <div className="permission-result">
              {item.resolved === 'cancelled'
                ? 'Cancelled'
                : item.options.find((o) => o.optionId === item.resolved)?.name}
              {item.auto && ' (auto)'}
            </div>
          ) : (
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
          )}
        </div>
      )
    case 'error':
      return <div className="msg-error">{item.text}</div>
  }
})

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
