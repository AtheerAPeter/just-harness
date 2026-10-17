import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ThemeToggle } from './ThemeToggle'
import { Collapse } from './Collapse'
import { ProjectTile } from './ProjectIcon'
import { RowMenu } from './RowMenu'
import { colorValue } from '../lib/project-colors'
import { startedChats, type AppState, type Chat } from '../../../shared/types'
import { readPref, writePref } from '../lib/prefs'
import { waitingOn } from '../lib/background'
import {
  BookIcon,
  ChevronIcon,
  ComposeIcon,
  FolderPlusIcon,
  SearchIcon,
  SlidersIcon
} from './icons'

/** Settled chats listed before "Show more", and how many each click adds. */
const SETTLED_PAGE = 20
/** The Settled list's height until the user drags it, and below which a drag closes it. */
const SETTLED_HEIGHT = 320
const SETTLED_MIN = 60
/** Room kept for the top bar, the live chats and the footer while dragging the list up. */
const SETTLED_ROOM = 180
/** The sidebar's width until the user drags its edge, and how narrow or wide it may get. */
const SIDEBAR_WIDTH = 244
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 440

interface SidebarProps {
  /** Hidden, it slides out but stays mounted, keeping its scroll and search. */
  open: boolean
  state: AppState
  selectedChatId?: string
  view: 'chat' | 'skills' | 'settings'
  onSelectChat: (chatId: string) => void
  /** Start a chat: the user picks its project first. */
  onNewChat: () => void
  onShowSkills: () => void
  onShowSettings: () => void
}

/**
 * Chats that need the user or are working sit at the top; every other chat is
 * settled, in its own section at the bottom. Each chat shows its project's icon
 * and color, which is how chats of different projects are told apart.
 */
export function Sidebar({
  open,
  state,
  selectedChatId,
  view,
  onSelectChat,
  onNewChat,
  onShowSkills,
  onShowSettings
}: SidebarProps): React.JSX.Element {
  /** Lead chats whose chats the user opened; every lead starts closed. */
  const [openLeads, setOpenLeads] = useState<Set<string>>(new Set())
  /** The selected chat that was last brought into view. */
  const [revealedChatId, setRevealedChatId] = useState<string>()
  const [settledOpen, setSettledOpen] = useState(() => readPref('settledOpen', true))
  const [settledShown, setSettledShown] = useState(SETTLED_PAGE)
  const [settledHeight, setSettledHeight] = useState(() =>
    readPref('settledHeight', SETTLED_HEIGHT)
  )
  /** The list's height while its header is being dragged. */
  const [dragHeight, setDragHeight] = useState<number>()
  /** Set when a drag ends, so the click that follows it does not also open or close the list. */
  const dragged = useRef(false)
  const navRef = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(() => readPref('sidebarWidth', SIDEBAR_WIDTH))
  const [resizing, setResizing] = useState(false)
  useLayoutEffect(() => {
    // The window's layout and the sidebar's slide both use this width.
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`)
  }, [width])
  useEffect(() => writePref('sidebarWidth', width), [width])
  useRowMotion(navRef, dragHeight !== undefined || resizing)
  /** The chat whose title is being edited in place. */
  const [renaming, setRenaming] = useState<string>()
  /** The search text; undefined while the search field is closed. */
  const [query, setQuery] = useState<string>()
  const [version, setVersion] = useState<string>()
  /** A newer release's version, once the app has found one. */
  const [update, setUpdate] = useState<string | null>(null)
  useEffect(() => {
    window.api.appVersion().then(setVersion)
    window.api.update.available().then(setUpdate)
    return window.api.update.onAvailable(setUpdate)
  }, [])
  useEffect(() => writePref('settledOpen', settledOpen), [settledOpen])
  useEffect(() => writePref('settledHeight', settledHeight), [settledHeight])
  const now = useNow()

  const projects = new Map(state.projects.map((p) => [p.id, p]))
  // Open the Settled section and the chat that leads a newly selected chat, so a new or picked
  // chat stays in view. Done while rendering, once per selection; the user can close them after.
  const selectedChat = state.chats.find((c) => c.id === selectedChatId)
  if (selectedChat && selectedChatId !== revealedChatId) {
    setRevealedChatId(selectedChatId)
    if (!settledOpen && !selectedChat.running) setSettledOpen(true)
    if (selectedChat.startedBy && !openLeads.has(selectedChat.startedBy)) {
      setOpenLeads(new Set(openLeads).add(selectedChat.startedBy))
    }
  }
  const q = query?.trim().toLowerCase() ?? ''
  const matches = (chat: Chat): boolean =>
    !q ||
    chat.title.toLowerCase().includes(q) ||
    Boolean(projects.get(chat.projectId)?.name.toLowerCase().includes(q))
  const chats = state.chats.filter(matches).sort((a, b) => b.updatedAt - a.updatedAt)
  // A chat that started chats leads them: they are listed under it, wherever it is listed.
  // While searching, every match is listed on its own.
  const started = startedChats(state.chats)
  const nested = (chat: Chat): boolean =>
    !q && chat.startedBy != null && !!started.get(chat.startedBy)
  // A lead is working while any chat it started is, even between its own turns, so it does not
  // jump between the lists each time a report starts and ends one of its turns. So is a chat with
  // commands or a timer in the background: each wakes it, so it is not done.
  const startedWorking = (chat: Chat): number =>
    started.get(chat.id)?.filter((c) => c.running).length ?? 0
  const working = (chat: Chat): boolean =>
    chat.running || Boolean(chat.background) || startedWorking(chat) > 0
  // Chats that need the user come first, then those still working. A waiting chat is also
  // running. Both lists show a chat even when it is also under the chat that leads it; but a
  // working chat whose lead is working too is shown under the lead only.
  const byId = new Map(state.chats.map((c) => [c.id, c]))
  const leadWorking = (chat: Chat): boolean => {
    const lead = nested(chat) ? byId.get(chat.startedBy!) : undefined
    return Boolean(lead && working(lead) && !lead.waiting)
  }
  const waiting = chats.filter((c) => c.waiting)
  const running = chats.filter((c) => working(c) && !c.waiting && !leadWorking(c))
  const settled = chats.filter((c) => !working(c) && !c.waiting && !nested(c))
  // While searching, settled matches are always listed.
  const settledShut = !settledOpen && !q
  /** Whether the open chat is this one or one it leads, to keep it in view past "Show more". */
  const holdsSelected = (chat: Chat): boolean =>
    chat.id === selectedChatId ||
    Boolean(started.get(chat.id)?.some((c) => c.id === selectedChatId))

  function toggleLead(chatId: string): void {
    setOpenLeads((current) => {
      const next = new Set(current)
      if (next.has(chatId)) next.delete(chatId)
      else next.add(chatId)
      return next
    })
  }

  /** One chat, led by its project's icon and color; live ones are also tinted in the color. */
  function chatRow(chat: Chat, live: boolean): React.JSX.Element {
    const project = projects.get(chat.projectId)
    const color = live && project?.color ? colorValue(project.color) : undefined
    const led = q ? undefined : started.get(chat.id)
    const workingLed = led?.filter((c) => c.running).length ?? 0
    const isOpen = openLeads.has(chat.id)
    const row = (
      <div
        key={chat.id}
        data-chat={chat.id}
        className={`chat-row${led ? ' lead' : ''}${color ? ' colored' : ''}${view === 'chat' && chat.id === selectedChatId ? ' selected' : ''}`}
        style={color ? ({ '--project-color': color } as React.CSSProperties) : undefined}
        title={[
          project?.name,
          chat.waiting
            ? 'Waiting for approval'
            : (!chat.running && waitingOn(chat, startedWorking(chat))) || chat.preview
        ]
          .filter(Boolean)
          .join(' · ')}
        onClick={() => onSelectChat(chat.id)}
      >
        {project ? <ProjectTile project={project} size={12} /> : <span />}
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
          {led && (
            <button
              className={`lead-toggle${isOpen ? ' open' : ''}`}
              title={`Started ${led.length} ${led.length === 1 ? 'chat' : 'chats'}, ${workingLed} working. ${isOpen ? 'Hide' : 'Show'} them.`}
              aria-expanded={isOpen}
              onClick={(e) => {
                e.stopPropagation()
                toggleLead(chat.id)
              }}
            >
              <span className={`lead-count${workingLed > 0 ? ' active' : ''}`}>
                {workingLed}/{led.length}
              </span>
              <ChevronIcon width={10} height={10} className="chevron" />
            </button>
          )}
          <ChatStatus chat={chat} working={working(chat)} now={now} />
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
    )
    if (!led) return row
    return (
      <Fragment key={chat.id}>
        {row}
        <Collapse open={isOpen} className="chat-children">
          {led.map((c) => chatRow(c, live))}
        </Collapse>
      </Fragment>
    )
  }

  /**
   * Dragging the Settled header up or down resizes the list; dragged nearly
   * shut, it closes. A click without a drag opens or closes it.
   */
  function dragSettled(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return
    const head = event.currentTarget
    const startY = event.clientY
    const startHeight = settledOpen ? settledHeight : 0
    const max = Math.max(SETTLED_MIN, (navRef.current?.clientHeight ?? 0) - SETTLED_ROOM)
    let height: number | undefined
    const onMove = (e: PointerEvent): void => {
      const dy = startY - e.clientY
      if (height === undefined && Math.abs(dy) < 4) return
      height = Math.min(max, Math.max(0, startHeight + dy))
      setDragHeight(height)
    }
    const onUp = (): void => {
      head.removeEventListener('pointermove', onMove)
      head.removeEventListener('pointerup', onUp)
      head.removeEventListener('pointercancel', onUp)
      if (height === undefined) return
      dragged.current = true
      setDragHeight(undefined)
      if (height < SETTLED_MIN) {
        setSettledOpen(false)
      } else {
        setSettledHeight(height)
        setSettledOpen(true)
      }
    }
    head.setPointerCapture(event.pointerId)
    head.addEventListener('pointermove', onMove)
    head.addEventListener('pointerup', onUp)
    head.addEventListener('pointercancel', onUp)
  }

  /** Dragging the sidebar's right edge resizes it. */
  function dragWidth(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    const edge = event.currentTarget
    const startX = event.clientX
    const startWidth = width
    const onMove = (e: PointerEvent): void => {
      const next = startWidth + e.clientX - startX
      setWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(next))))
    }
    const onUp = (): void => {
      edge.removeEventListener('pointermove', onMove)
      edge.removeEventListener('pointerup', onUp)
      edge.removeEventListener('pointercancel', onUp)
      setResizing(false)
    }
    setResizing(true)
    edge.setPointerCapture(event.pointerId)
    edge.addEventListener('pointermove', onMove)
    edge.addEventListener('pointerup', onUp)
    edge.addEventListener('pointercancel', onUp)
  }

  function settledList(): React.JSX.Element {
    const limit = q ? settled.length : settledShown
    const visible = settled.slice(0, limit)
    const selected = settled.find(holdsSelected)
    if (selected && !visible.includes(selected)) visible.push(selected)
    return (
      <>
        {visible.map((chat) => chatRow(chat, false))}
        {settled.length > limit && (
          <div className="chat-more">
            <button onClick={() => setSettledShown(limit + SETTLED_PAGE)}>
              Show more ({settled.length - limit})
            </button>
          </div>
        )}
      </>
    )
  }

  return (
    <nav
      className={`sidebar${open ? '' : ' closed'}${resizing ? ' resizing' : ''}`}
      inert={!open}
      ref={navRef}
    >
      <div
        className="sidebar-edge"
        title="Drag to resize, double-click to reset"
        onPointerDown={dragWidth}
        onDoubleClick={() => setWidth(SIDEBAR_WIDTH)}
      />
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
        <button className="icon-btn" title="New chat (⌘N)" onClick={onNewChat}>
          <ComposeIcon />
        </button>
      </div>
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
        {q && chats.length === 0 && <div className="side-empty">No matching chats</div>}
      </div>
      {settled.length > 0 && (
        <div className="settled">
          <button
            className={`settled-head${settledShut ? '' : ' open'}`}
            aria-expanded={!settledShut}
            title="Drag to resize, click to open or close"
            onPointerDown={dragSettled}
            onClick={() => {
              if (dragged.current) dragged.current = false
              else setSettledOpen((o) => !o)
            }}
          >
            <span className="settled-grab" />
            <span className="settled-line">
              Settled · {settled.length}
              <span className="spacer" />
              <ChevronIcon width={10} height={10} className="chevron" />
            </span>
          </button>
          <div
            className={`settled-list${dragHeight !== undefined ? ' dragging' : ''}`}
            style={{ height: dragHeight ?? (settledShut ? 0 : settledHeight) }}
            inert={settledShut && dragHeight === undefined}
          >
            {settledList()}
          </div>
        </div>
      )}
      <div className="sidebar-footer">
        <button
          className={`icon-btn${view === 'settings' ? ' on' : ''}`}
          title="Settings (⌘,)"
          onClick={onShowSettings}
        >
          <SlidersIcon />
        </button>
        <ThemeToggle />
        {update ? (
          <UpdateButton version={update} />
        ) : (
          version && <span className="app-version">v{version}</span>
        )}
      </div>
    </nav>
  )
}

/** In place of the version once a newer release is out. Installing it quits and reopens the app. */
function UpdateButton({ version }: { version: string }): React.JSX.Element {
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string>()

  async function install(): Promise<void> {
    setInstalling(true)
    setError(undefined)
    try {
      await window.api.update.install()
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(e)
      )
    } finally {
      setInstalling(false)
    }
  }

  return (
    <button
      className="app-update"
      disabled={installing}
      title={error ?? `Quit, install v${version} and open it again`}
      onClick={install}
    >
      <span className={`dot${error ? ' failed' : ''}`} />
      {installing ? 'Updating…' : error ? 'Update failed · Retry' : `Update to v${version}`}
    </button>
  )
}

/**
 * Chats that change place slide there from where they were, and chats that
 * appear fade in. Places are kept after every render and on every scroll or
 * resize, so only a change in the lists reads as a move; nothing moves while
 * the user drags (paused).
 */
function useRowMotion(root: RefObject<HTMLElement | null>, paused: boolean): void {
  const places = useRef<Map<string, number>>(undefined)

  /** Each row's place without the slide it may be in the middle of, and that slide's offset. */
  function measure(): Map<string, { el: HTMLElement; top: number; offset: number }> {
    const rows = new Map<string, { el: HTMLElement; top: number; offset: number }>()
    for (const el of root.current?.querySelectorAll<HTMLElement>('[data-chat]') ?? []) {
      const rect = el.getBoundingClientRect()
      // Rows in a closed section have no place.
      if (rect.height === 0 || rows.has(el.dataset.chat!)) continue
      const offset = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42
      rows.set(el.dataset.chat!, { el, top: rect.top - offset, offset })
    }
    return rows
  }

  useLayoutEffect(() => {
    const before = places.current
    const rows = measure()
    places.current = new Map([...rows].map(([id, row]) => [id, row.top]))
    if (!before || paused || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    for (const [id, { el, top, offset }] of rows) {
      const from = before.get(id)
      if (from === undefined) {
        el.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1 }], ROW_IN)
      } else if (Math.abs(from + offset - top) > 1) {
        el.getAnimations().forEach((a) => a.cancel())
        el.animate(
          [{ transform: `translateY(${from + offset - top}px)` }, { transform: 'none' }],
          ROW_MOVE
        )
      }
    }
  })

  useEffect(() => {
    const keep = (): void => {
      places.current = new Map([...measure()].map(([id, row]) => [id, row.top]))
    }
    const el = root.current
    el?.addEventListener('scroll', keep, true)
    window.addEventListener('resize', keep)
    return () => {
      el?.removeEventListener('scroll', keep, true)
      window.removeEventListener('resize', keep)
    }
  })
}

/** The motion curve and durations of styles.css (--ease, --move). */
const ROW_IN: KeyframeAnimationOptions = { duration: 260, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }
const ROW_MOVE: KeyframeAnimationOptions = {
  duration: 320,
  easing: 'cubic-bezier(0.32, 0.72, 0, 1)'
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

/**
 * Waiting for the user, working on a turn, waiting between turns on what will
 * wake it (commands, a timer, the chats it started), or else when the chat
 * last changed.
 */
function ChatStatus({
  chat,
  working,
  now
}: {
  chat: Chat
  working: boolean
  now: number
}): React.JSX.Element {
  if (chat.waiting) return <span className="chat-status chat-dot waiting" />
  if (chat.running) return <span className="chat-status chat-dot running" />
  if (working) return <span className="chat-status chat-dot background" />
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
