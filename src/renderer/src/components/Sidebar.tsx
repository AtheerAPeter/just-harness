import { useState } from 'react'
import type { AppState } from '../../../shared/types'
import { BookIcon, ChevronIcon, CloseIcon, FolderIcon, PlusIcon } from './icons'

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
                chats.map((chat) => (
                  <div
                    key={chat.id}
                    className={`chat-row${view === 'chat' && chat.id === selectedChatId ? ' selected' : ''}`}
                    onClick={() => onSelectChat(chat.id)}
                  >
                    {chat.running && <span className="running-dot" />}
                    <span className="chat-title">{chat.title}</span>
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
      </div>
    </nav>
  )
}
