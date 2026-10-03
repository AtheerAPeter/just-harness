import { useEffect, useRef, useState } from 'react'
import { ThemeToggle } from './ThemeToggle'
import type { AppState, Chat } from '../../../shared/types'
import { BookIcon, ChevronIcon, FolderIcon, FolderPlusIcon, MoreIcon, PlusIcon } from './icons'

/** Chats listed per project before "Show more", and how many each click adds. */
const CHAT_PAGE = 5
const CHAT_MORE = 10

interface SidebarProps {
  state: AppState
  selectedChatId?: string
  selectedProjectId?: string
  view: 'chat' | 'skills'
  onSelectChat: (chatId: string) => void
  onNewChat: (projectId: string) => void
  onShowSkills: () => void
}

export function Sidebar({
  state,
  selectedChatId,
  selectedProjectId,
  view,
  onSelectChat,
  onNewChat,
  onShowSkills
}: SidebarProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** How many chats each project shows; projects not listed show CHAT_PAGE. */
  const [shown, setShown] = useState<Record<string, number>>({})
  /** The chat whose title is being edited in place. */
  const [renaming, setRenaming] = useState<string>()
  const now = useNow()

  function toggle(projectId: string): void {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  return (
    <nav className="sidebar">
      <div className="sidebar-top">
        <button
          className="icon-btn"
          title="Open project folder (⌘O)"
          onClick={() => window.api.addProject()}
        >
          <FolderPlusIcon />
        </button>
      </div>
      <div className="sidebar-section">
        {state.projects.length === 0 && (
          <button className="add-project" onClick={() => window.api.addProject()}>
            <FolderPlusIcon /> Open a project folder
          </button>
        )}
        {state.projects.map((project) => {
          const chats = state.chats
            .filter((c) => c.projectId === project.id)
            .sort((a, b) => b.updatedAt - a.updatedAt)
          const isCollapsed = collapsed.has(project.id)
          const limit = shown[project.id] ?? CHAT_PAGE
          const visible = chats.slice(0, limit)
          // Keep the open chat visible even when it is older than the cutoff.
          const selected = chats.find((c) => c.id === selectedChatId)
          if (selected && !visible.includes(selected)) visible.push(selected)
          return (
            <div key={project.id} className="project">
              <div
                className={`project-row${project.id === selectedProjectId ? ' current' : ''}${isCollapsed ? ' collapsed' : ''}`}
                title={project.path}
                onClick={() => toggle(project.id)}
              >
                <FolderIcon width={14} height={14} className="project-icon" />
                <span className="project-name">{project.name}</span>
                <span className="project-count">{chats.length}</span>
                <ChevronIcon width={10} height={10} className="chevron" />
                <span className="spacer" />
                <RowMenu
                  label="Project options"
                  items={[
                    {
                      name: 'Remove project',
                      danger: true,
                      onSelect: () => {
                        if (
                          confirm(
                            `Remove "${project.name}" and its chats from Just Harness? Files on disk are not touched.`
                          )
                        ) {
                          window.api.removeProject(project.id)
                        }
                      }
                    }
                  ]}
                />
                <button
                  className="icon-btn small"
                  title="New chat"
                  onClick={(e) => {
                    e.stopPropagation()
                    onNewChat(project.id)
                  }}
                >
                  <PlusIcon width={14} height={14} />
                </button>
              </div>
              {!isCollapsed &&
                visible.map((chat) => (
                  <div
                    key={chat.id}
                    className={`chat-row${view === 'chat' && chat.id === selectedChatId ? ' selected' : ''}`}
                    title={chat.waiting ? 'Waiting for approval' : chat.preview || undefined}
                    onClick={() => onSelectChat(chat.id)}
                  >
                    <span
                      className={`chat-dot${chat.waiting ? ' waiting' : chat.running ? ' running' : ''}`}
                    />
                    <div className="chat-line">
                      {renaming === chat.id ? (
                        <RenameField
                          title={chat.title}
                          onDone={(title) => {
                            setRenaming(undefined)
                            if (title !== undefined && title.trim() && title !== chat.title) {
                              window.api.renameChat(chat.id, title)
                            }
                          }}
                        />
                      ) : (
                        <span className="chat-title" onDoubleClick={() => setRenaming(chat.id)}>
                          {chat.title}
                        </span>
                      )}
                      <ChatStatus chat={chat} now={now} />
                      <RowMenu
                        label="Chat options"
                        items={[
                          { name: 'Rename', onSelect: () => setRenaming(chat.id) },
                          {
                            name: 'Delete',
                            danger: true,
                            onSelect: () => window.api.deleteChat(chat.id)
                          }
                        ]}
                      />
                    </div>
                  </div>
                ))}
              {!isCollapsed && (chats.length > limit || limit > CHAT_PAGE) && (
                <div className="chat-more">
                  {chats.length > limit && (
                    <button
                      onClick={() =>
                        setShown((current) => ({ ...current, [project.id]: limit + CHAT_MORE }))
                      }
                    >
                      Show more ({chats.length - limit})
                    </button>
                  )}
                  {limit > CHAT_PAGE && (
                    <button
                      onClick={() =>
                        setShown((current) => ({ ...current, [project.id]: CHAT_PAGE }))
                      }
                    >
                      Show less
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="sidebar-footer">
        <button
          className={`nav-item${view === 'skills' ? ' selected' : ''}`}
          onClick={onShowSkills}
        >
          <BookIcon /> Skills
        </button>
        <ThemeToggle />
      </div>
    </nav>
  )
}

/** Inline title editor. Enter or leaving the field saves; Escape cancels (undefined). */
function RenameField({
  title,
  onDone
}: {
  title: string
  onDone: (title: string | undefined) => void
}): React.JSX.Element {
  const [value, setValue] = useState(title)
  const done = useRef(false)
  const finish = (result: string | undefined): void => {
    if (done.current) return
    done.current = true
    onDone(result)
  }
  return (
    <input
      className="rename-field"
      autoFocus
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(value)
        else if (e.key === 'Escape') {
          // Handled: cancelling the rename must not also stop the agent.
          e.preventDefault()
          finish(undefined)
        }
      }}
    />
  )
}

/** When the chat last changed; running and waiting chats show their dot instead. */
function ChatStatus({ chat, now }: { chat: Chat; now: number }): React.JSX.Element | null {
  if (chat.waiting || chat.running) return null
  return <span className="chat-status chat-time">{relativeTime(chat.updatedAt, now)}</span>
}

/** The current time, updated every minute so relative times stay right. */
function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

const DAY = 86_400_000

/** "now", "5m", "3h" today, then "Yesterday", a weekday, or a date, like Mail. */
function relativeTime(time: number, now: number): string {
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  if (time >= startOfToday) return `${Math.floor(minutes / 60)}h`
  if (time >= startOfToday - DAY) return 'Yesterday'
  const date = new Date(time)
  if (time >= startOfToday - 6 * DAY)
    return date.toLocaleDateString(undefined, { weekday: 'short' })
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {})
  })
}

interface RowMenuItem {
  name: string
  danger?: boolean
  onSelect: () => void
}

/**
 * A row's ⋮ button and its menu. The menu is fixed to the window, so the
 * scrolling sidebar cannot clip it; near the bottom it opens upward.
 */
function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }): React.JSX.Element {
  const [at, setAt] = useState<React.CSSProperties>()
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!at) return
    const onPointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setAt(undefined)
    }
    // Capture phase, and handled: closing the menu must not also stop the agent.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setAt(undefined)
    }
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [at])

  function toggle(button: HTMLElement): void {
    if (at) return setAt(undefined)
    const rect = button.getBoundingClientRect()
    const right = window.innerWidth - rect.right
    const roomBelow = window.innerHeight - rect.bottom
    setAt(
      roomBelow > MENU_ROOM
        ? { top: rect.bottom + 4, right }
        : { bottom: window.innerHeight - rect.top + 4, right }
    )
  }

  return (
    <div
      className={`row-menu${at ? ' open' : ''}`}
      ref={rootRef}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="icon-btn small"
        title={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        onClick={(e) => toggle(e.currentTarget)}
      >
        <MoreIcon width={14} height={14} />
      </button>
      {at && (
        <div className="menu" role="menu" style={at}>
          {items.map((item) => (
            <button
              key={item.name}
              role="menuitem"
              className={item.danger ? 'danger' : undefined}
              autoFocus={item === items[0]}
              onClick={() => {
                setAt(undefined)
                item.onSelect()
              }}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Space a row menu needs below its button to open downward. */
const MENU_ROOM = 120
