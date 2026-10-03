import { useRef, useState } from 'react'
import { ThemeToggle } from './ThemeToggle'
import type { AppState } from '../../../shared/types'
import { BookIcon, ChevronIcon, CloseIcon, FolderIcon, PencilIcon, PlusIcon } from './icons'

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
      <div className="sidebar-drag" />
      <div className="sidebar-section">
        <div className="section-label">
          Projects
          <button
            className="icon-btn small"
            title="Add project folder"
            onClick={() => window.api.addProject()}
          >
            <PlusIcon width={14} height={14} />
          </button>
        </div>
        {state.projects.length === 0 && (
          <button className="add-project" onClick={() => window.api.addProject()}>
            <FolderIcon /> Open a project folder
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
                className={`project-row${project.id === selectedProjectId ? ' current' : ''}`}
                title={project.path}
                onClick={() => toggle(project.id)}
              >
                <ChevronIcon
                  width={12}
                  height={12}
                  className={`chevron${isCollapsed ? '' : ' open'}`}
                />
                <FolderIcon width={15} height={15} className="project-icon" />
                <span className="project-name">{project.name}</span>
                <button
                  className="icon-btn small hover-only"
                  title="Remove project (files stay on disk)"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (
                      confirm(
                        `Remove "${project.name}" and its chats from Just Harness? Files on disk are not touched.`
                      )
                    ) {
                      window.api.removeProject(project.id)
                    }
                  }}
                >
                  <CloseIcon width={13} height={13} />
                </button>
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
                    onClick={() => onSelectChat(chat.id)}
                  >
                    {chat.running && <span className="running-dot" />}
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
                    <button
                      className="icon-btn small hover-only"
                      title="Rename chat"
                      onClick={(e) => {
                        e.stopPropagation()
                        setRenaming(chat.id)
                      }}
                    >
                      <PencilIcon width={12} height={12} />
                    </button>
                    <button
                      className="icon-btn small hover-only"
                      title="Delete chat"
                      onClick={(e) => {
                        e.stopPropagation()
                        window.api.deleteChat(chat.id)
                      }}
                    >
                      <CloseIcon width={13} height={13} />
                    </button>
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
