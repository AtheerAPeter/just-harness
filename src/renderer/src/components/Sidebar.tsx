import { useEffect, useRef, useState } from 'react'
import { ThemeToggle } from './ThemeToggle'
import { Collapse } from './Collapse'
import type { AppState, Chat, Project } from '../../../shared/types'
import { readPref, writePref } from '../lib/prefs'
import { useOverlay } from '../lib/overlays'
import {
  BookIcon,
  ChevronIcon,
  ClockIcon,
  FolderIcon,
  FolderPlusIcon,
  MoreIcon,
  PlusIcon,
  SearchIcon
} from './icons'

/** Chats listed per project before "Show more", and how many each click adds. */
const CHAT_PAGE = 5
const CHAT_MORE = 10
/** Chats listed in the Recent view before "Show more", and how many each click adds. */
const RECENT_PAGE = 20

/** How the chats below "Needs you" and "Working" are listed. */
type ListMode = 'project' | 'recent'

interface SidebarProps {
  /** Hidden, it slides out but stays mounted, keeping its scroll and search. */
  open: boolean
  state: AppState
  selectedChatId?: string
  selectedProjectId?: string
  view: 'chat' | 'skills'
  onSelectChat: (chatId: string) => void
  onNewChat: (projectId: string) => void
  onShowSkills: () => void
}

export function Sidebar({
  open,
  state,
  selectedChatId,
  selectedProjectId,
  view,
  onSelectChat,
  onNewChat,
  onShowSkills
}: SidebarProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** How many chats each project shows, and the Recent list under its own key. */
  const [shown, setShown] = useState<Record<string, number>>({})
  /** The chat whose title is being edited in place. */
  const [renaming, setRenaming] = useState<string>()
  const [mode, setMode] = useState<ListMode>(() => readPref('sidebarMode', 'project'))
  /** The search text; undefined while the search field is closed. */
  const [query, setQuery] = useState<string>()
  const [version, setVersion] = useState<string>()
  useEffect(() => {
    window.api.appVersion().then(setVersion)
  }, [])
  useEffect(() => writePref('sidebarMode', mode), [mode])
  const now = useNow()

  const projects = new Map(state.projects.map((p) => [p.id, p]))
  const q = query?.trim().toLowerCase() ?? ''
  const matches = (chat: Chat): boolean =>
    !q ||
    chat.title.toLowerCase().includes(q) ||
    Boolean(projects.get(chat.projectId)?.name.toLowerCase().includes(q))
  const chats = state.chats.filter(matches).sort((a, b) => b.updatedAt - a.updatedAt)
  // Chats that need the user come first, then those still working. A waiting chat is also running.
  const waiting = chats.filter((c) => c.waiting)
  const running = chats.filter((c) => c.running && !c.waiting)
  const rest = chats.filter((c) => !c.running && !c.waiting)

  function toggle(projectId: string): void {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  function newChat(): void {
    if (selectedProjectId) onNewChat(selectedProjectId)
    else window.api.addProject()
  }

  /** One chat. Pinned and Recent rows say which project the chat belongs to. */
  function chatRow(chat: Chat, withProject: boolean): React.JSX.Element {
    const project = projects.get(chat.projectId)
    return (
      <div
        key={chat.id}
        className={`chat-row${view === 'chat' && chat.id === selectedChatId ? ' selected' : ''}`}
        title={chat.waiting ? 'Waiting for approval' : chat.preview || undefined}
        onClick={() => onSelectChat(chat.id)}
      >
        <span className={`chat-dot${chat.waiting ? ' waiting' : chat.running ? ' running' : ''}`} />
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
        {withProject && project && (
          <div className="chat-sub">
            <FolderIcon width={11} height={11} />
            <span>
              {project.name}
              {chat.waiting && ' · Waiting for approval'}
            </span>
          </div>
        )}
      </div>
    )
  }

  function projectGroup(project: Project): React.JSX.Element | null {
    const own = rest.filter((c) => c.projectId === project.id)
    // While searching, only projects with a match are listed, open and in full.
    if (q && own.length === 0) return null
    const total = state.chats.filter((c) => c.projectId === project.id).length
    const isCollapsed = !q && collapsed.has(project.id)
    const limit = q ? own.length : (shown[project.id] ?? CHAT_PAGE)
    const visible = own.slice(0, limit)
    // Keep the open chat visible even when it is older than the cutoff.
    const selected = own.find((c) => c.id === selectedChatId)
    if (selected && !visible.includes(selected)) visible.push(selected)
    return (
      <div key={project.id} className="project">
        <div
          className={`project-row${project.id === selectedProjectId ? ' current' : ''}${isCollapsed ? ' collapsed' : ''}`}
          title={project.path}
          onClick={() => toggle(project.id)}
        >
          <ChevronIcon width={10} height={10} className="chevron" />
          <FolderIcon width={14} height={14} className="project-icon" />
          <span className="project-name">{project.name}</span>
          <span className="project-count">{total}</span>
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
            className="icon-btn small row-add"
            title="New chat"
            onClick={(e) => {
              e.stopPropagation()
              onNewChat(project.id)
            }}
          >
            <PlusIcon width={14} height={14} />
          </button>
        </div>
        <Collapse open={!isCollapsed} className="project-chats">
          {visible.map((chat) => chatRow(chat, false))}
          {!q && (own.length > limit || limit > CHAT_PAGE) && (
            <div className="chat-more">
              {own.length > limit && (
                <button
                  onClick={() =>
                    setShown((current) => ({ ...current, [project.id]: limit + CHAT_MORE }))
                  }
                >
                  Show more ({own.length - limit})
                </button>
              )}
              {limit > CHAT_PAGE && (
                <button
                  onClick={() => setShown((current) => ({ ...current, [project.id]: CHAT_PAGE }))}
                >
                  Show less
                </button>
              )}
            </div>
          )}
        </Collapse>
      </div>
    )
  }

  function recentList(): React.JSX.Element {
    const limit = q ? rest.length : (shown[RECENT_KEY] ?? RECENT_PAGE)
    const visible = rest.slice(0, limit)
    const selected = rest.find((c) => c.id === selectedChatId)
    if (selected && !visible.includes(selected)) visible.push(selected)
    const startOfToday = new Date(now).setHours(0, 0, 0, 0)
    const today = visible.filter((c) => c.updatedAt >= startOfToday)
    const earlier = visible.filter((c) => c.updatedAt < startOfToday)
    return (
      <>
        {today.length > 0 && <div className="side-label">Today</div>}
        {today.map((chat) => chatRow(chat, true))}
        {earlier.length > 0 && <div className="side-label">Earlier</div>}
        {earlier.map((chat) => chatRow(chat, true))}
        {rest.length > limit && (
          <div className="chat-more">
            <button
              onClick={() =>
                setShown((current) => ({ ...current, [RECENT_KEY]: limit + RECENT_PAGE }))
              }
            >
              Show more ({rest.length - limit})
            </button>
          </div>
        )}
      </>
    )
  }

  return (
    <nav className={`sidebar${open ? '' : ' closed'}`} inert={!open}>
      {/* The window buttons sit at its left; it drags the window. */}
      <div className="sidebar-top">
        <button
          className={`icon-btn${query !== undefined ? ' on' : ''}`}
          title="Search chats"
          onClick={() => setQuery((current) => (current === undefined ? '' : undefined))}
        >
          <SearchIcon />
        </button>
        <button
          className={`icon-btn${view === 'skills' ? ' on' : ''}`}
          title="Skills"
          onClick={onShowSkills}
        >
          <BookIcon />
        </button>
        <button
          className="icon-btn"
          title="Open project folder (⌘O)"
          onClick={() => window.api.addProject()}
        >
          <FolderPlusIcon />
        </button>
      </div>
      <button className="new-chat" title="New chat (⌘N)" onClick={newChat}>
        <PlusIcon width={15} height={15} />
        New chat
        <kbd>⌘N</kbd>
      </button>
      {query !== undefined && (
        <label className="sidebar-search">
          <SearchIcon width={14} height={14} />
          <input
            autoFocus
            placeholder="Search chats"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              // Handled: closing the search must not also stop the agent.
              e.preventDefault()
              setQuery(undefined)
            }}
          />
        </label>
      )}
      <div className="segmented sidebar-mode" role="tablist">
        <button
          role="tab"
          aria-selected={mode === 'project'}
          className={mode === 'project' ? 'on' : ''}
          onClick={() => setMode('project')}
        >
          <FolderIcon width={13} height={13} />
          By project
        </button>
        <button
          role="tab"
          aria-selected={mode === 'recent'}
          className={mode === 'recent' ? 'on' : ''}
          onClick={() => setMode('recent')}
        >
          <ClockIcon width={13} height={13} />
          Recent
        </button>
      </div>
      <div className="sidebar-section">
        {state.projects.length === 0 && (
          <button className="add-project" onClick={() => window.api.addProject()}>
            <FolderPlusIcon /> Open a project folder
          </button>
        )}
        {waiting.length > 0 && (
          <>
            <div className="side-label waiting">
              Needs you <b>{waiting.length}</b>
            </div>
            {waiting.map((chat) => chatRow(chat, true))}
          </>
        )}
        {running.length > 0 && (
          <>
            <div className="side-label">
              Working <b>{running.length}</b>
            </div>
            {running.map((chat) => chatRow(chat, true))}
          </>
        )}
        {mode === 'project' ? (
          <>
            {state.projects.length > 0 && (waiting.length > 0 || running.length > 0) && (
              <div className="side-label">Projects</div>
            )}
            {state.projects.map(projectGroup)}
          </>
        ) : (
          recentList()
        )}
        {q && chats.length === 0 && <div className="side-empty">No matching chats</div>}
      </div>
      <div className="sidebar-footer">
        <ThemeToggle />
        {version && <span className="app-version">v{version}</span>}
      </div>
    </nav>
  )
}

/** The Recent list's key in the per-list "Show more" counts; project ids never look like this. */
const RECENT_KEY = ':recent'

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
  const menuRef = useRef<HTMLDivElement>(null)
  useOverlay(menuRef, Boolean(at))

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
        <div className="menu" role="menu" style={at} ref={menuRef}>
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
