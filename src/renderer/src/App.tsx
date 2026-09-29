import { useCallback, useEffect, useState } from 'react'
import { AGENTS, type AgentStatus, type AgentId, type AppState } from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { SkillsView } from './components/SkillsView'
import { BrowserPanel } from './components/BrowserPanel'
import { ChatIcon, GlobeIcon } from './components/icons'

/** Per-viewer UI preferences. Storage can be unavailable, so every access is guarded. */
function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Preferences are a convenience; losing them is fine.
  }
}

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState>({ projects: [], chats: [] })
  const [selectedChatId, setSelectedChatId] = useState<string | undefined>(() =>
    readPref('selectedChat', undefined)
  )
  const [view, setView] = useState<'chat' | 'skills'>('chat')
  const [browserOpen, setBrowserOpen] = useState(() => readPref('browserOpen', false))
  const [browserWidth, setBrowserWidth] = useState(() => readPref('browserWidth', 520))
  const [statuses, setStatuses] = useState<Partial<Record<AgentId, AgentStatus>>>({})

  useEffect(() => {
    window.api.getState().then(setState)
    const offState = window.api.onState(setState)
    const offShow = window.api.browser.onShowRequest(() => setBrowserOpen(true))
    for (const { id } of AGENTS) {
      window.api.agentStatus(id).then((status) => setStatuses((c) => ({ ...c, [id]: status })))
    }
    return () => {
      offState()
      offShow()
    }
  }, [])

  useEffect(() => writePref('selectedChat', selectedChatId), [selectedChatId])
  useEffect(() => writePref('browserOpen', browserOpen), [browserOpen])
  useEffect(() => writePref('browserWidth', browserWidth), [browserWidth])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setBrowserOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const chat = state.chats.find((c) => c.id === selectedChatId)
  const project = state.projects.find((p) => p.id === chat?.projectId) ?? state.projects[0]

  const newChat = useCallback(async (projectId: string) => {
    const agent = readPref<AgentId>('lastAgent', 'opencode')
    const created = await window.api.createChat(projectId, agent, readPref(`settings:${agent}`, {}))
    setSelectedChatId(created.id)
    setView('chat')
  }, [])

  async function changeAgent(agent: AgentId): Promise<void> {
    if (!chat) return
    writePref('lastAgent', agent)
    await window.api.setAgent(chat.id, agent, readPref(`settings:${agent}`, {}))
  }

  async function changeOption(optionId: string, value: string): Promise<void> {
    if (!chat) return
    // Remember the choice so the next chat with this agent starts the same way.
    writePref(`settings:${chat.agent}`, {
      ...readPref(`settings:${chat.agent}`, {}),
      [optionId]: value
    })
    await window.api.setOption(chat.id, optionId, value)
  }

  return (
    <div className="app">
      <Sidebar
        state={state}
        selectedChatId={chat?.id}
        selectedProjectId={project?.id}
        view={view}
        onSelectChat={(id) => {
          setSelectedChatId(id)
          setView('chat')
        }}
        onNewChat={newChat}
        onShowSkills={() => setView('skills')}
      />
      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            {view === 'skills' ? 'Skills' : chat ? chat.title : 'Just Harness'}
            {view === 'chat' && project && chat && <span className="muted"> · {project.name}</span>}
          </div>
          <button
            className={`icon-btn${browserOpen ? ' on' : ''}`}
            title="Toggle browser (⌘B)"
            onClick={() => setBrowserOpen((o) => !o)}
          >
            <GlobeIcon />
          </button>
        </header>
        {view === 'skills' ? (
          <SkillsView key={project?.id} project={project} />
        ) : chat && project ? (
          <ChatView
            key={`${chat.id}:${chat.agent}`}
            chat={chat}
            statuses={statuses}
            projectPath={project.path}
            onAgentChange={changeAgent}
            onOptionChange={changeOption}
          />
        ) : (
          <div className="welcome">
            <ChatIcon width={28} height={28} />
            {!project ? (
              <>
                <h2>Open a project to start</h2>
                <p>Chats run OpenCode or Cline inside a project folder.</p>
                <button className="btn primary" onClick={() => window.api.addProject()}>
                  Open folder
                </button>
              </>
            ) : (
              <>
                <h2>Start a chat</h2>
                <button className="btn primary" onClick={() => newChat(project.id)}>
                  New chat in {project.name}
                </button>
              </>
            )}
          </div>
        )}
      </main>
      {browserOpen && (
        <BrowserPanel
          width={browserWidth}
          onResize={setBrowserWidth}
          onClose={() => setBrowserOpen(false)}
        />
      )}
    </div>
  )
}
