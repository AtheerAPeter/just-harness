import { useCallback, useEffect, useRef, useState } from 'react'
import { AGENTS, type AgentStatus, type AgentId, type AppState } from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { SkillsView } from './components/SkillsView'
import { SettingsView } from './components/SettingsView'
import { BrowserPanel } from './components/BrowserPanel'
import { ChatIcon, GlobeIcon, SidebarIcon } from './components/icons'
import { readPref, writePref } from './lib/prefs'

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState>({ projects: [], chats: [] })
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  const [selectedChatId, setSelectedChatId] = useState<string | undefined>(() =>
    readPref('selectedChat', undefined)
  )
  const [view, setView] = useState<'chat' | 'skills' | 'settings'>('chat')
  const [sidebarOpen, setSidebarOpen] = useState(() => readPref('sidebarOpen', true))
  const [browserWidth, setBrowserWidth] = useState(() => readPref('browserWidth', 520))
  const [statuses, setStatuses] = useState<Partial<Record<AgentId, AgentStatus>>>({})

  useEffect(() => {
    window.api.getState().then(setState)
    const offState = window.api.onState(setState)
    for (const { id } of AGENTS) {
      window.api.agentStatus(id).then((status) => setStatuses((c) => ({ ...c, [id]: status })))
    }
    return offState
  }, [])

  useEffect(() => writePref('selectedChat', selectedChatId), [selectedChatId])
  useEffect(() => writePref('sidebarOpen', sidebarOpen), [sidebarOpen])
  useEffect(() => writePref('browserWidth', browserWidth), [browserWidth])

  const chat = state.chats.find((c) => c.id === selectedChatId)
  // The browser panel belongs to the chat: each chat opens and closes its own.
  const browserOpen = Boolean(chat?.browserOpen)
  const toggleBrowser = useCallback((chatId: string | undefined, open?: boolean) => {
    if (!chatId) return
    const current = stateRef.current.chats.find((c) => c.id === chatId)
    window.api.browser.setOpen(chatId, open ?? !current?.browserOpen)
  }, [])

  // Each chat has its own browser page; the panel shows the selected chat's.
  const chatId = chat?.id
  useEffect(() => window.api.browser.setChat(chatId ?? null), [chatId])
  const project = state.projects.find((p) => p.id === chat?.projectId) ?? state.projects[0]

  const newChat = useCallback(async (projectId: string) => {
    const agent = readPref<AgentId>('lastAgent', 'opencode')
    const created = await window.api.createChat(
      projectId,
      agent,
      readPref(`settings:${agent}`, {}),
      // New chats start in the permission mode picked last.
      readPref('permissions', {})
    )
    setSelectedChatId(created.id)
    setView('chat')
  }, [])

  // Menu bar commands. The handler reads the current project through a ref so the
  // subscription is made once.
  const projectRef = useRef(project)
  const selectedChatRef = useRef(chat?.id)
  useEffect(() => {
    projectRef.current = project
    selectedChatRef.current = chat?.id
  }, [project, chat?.id])
  useEffect(
    () =>
      window.api.onMenu((command) => {
        if (command === 'toggle-sidebar') setSidebarOpen((o) => !o)
        else if (command === 'toggle-browser') toggleBrowser(selectedChatRef.current)
        else if (command === 'open-project') window.api.addProject()
        else if (command === 'open-settings') setView('settings')
        else if (command === 'new-chat') {
          if (projectRef.current) newChat(projectRef.current.id)
          else window.api.addProject()
        }
      }),
    [newChat, toggleBrowser]
  )

  async function changeAgent(agent: AgentId, chosen: Record<string, string>): Promise<void> {
    if (!chat) return
    writePref('lastAgent', agent)
    // What was picked along with the agent (its model) is remembered like any other choice.
    const settings = { ...readPref(`settings:${agent}`, {}), ...chosen }
    writePref(`settings:${agent}`, settings)
    await window.api.setAgent(chat.id, agent, settings)
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
    <div className={`app${sidebarOpen ? '' : ' sidebar-hidden'}`}>
      {/* Stays mounted so hiding it can slide instead of cut. */}
      <Sidebar
        open={sidebarOpen}
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
        onShowSettings={() => setView('settings')}
      />
      <main className="main">
        <header className="topbar">
          <button
            className="icon-btn"
            title={sidebarOpen ? 'Hide sidebar (⌃⌘S)' : 'Show sidebar (⌃⌘S)'}
            onClick={() => setSidebarOpen((o) => !o)}
          >
            <SidebarIcon />
          </button>
          <div className="topbar-title">
            {project && (view === 'skills' || (view === 'chat' && chat)) && (
              <span className="crumb">{project.name} / </span>
            )}
            <TopbarName
              id={view === 'chat' ? chat?.id : view}
              text={
                view === 'skills'
                  ? 'Skills'
                  : view === 'settings'
                    ? 'Settings'
                    : chat
                      ? chat.title
                      : 'Just Harness'
              }
            />
          </div>
          {view === 'chat' && chat?.waiting && (
            <span className="status-chip waiting">Needs you</span>
          )}
          {view === 'chat' && chat?.running && !chat.waiting && (
            <span className="status-chip running">
              <span className="spinner" />
              Working
            </span>
          )}
          <span className="spacer" />
          <button
            className={`icon-btn${browserOpen ? ' on' : ''}`}
            title="Toggle browser (⌘B)"
            disabled={!chat}
            onClick={() => toggleBrowser(chat?.id)}
          >
            <GlobeIcon />
          </button>
        </header>
        {view === 'skills' ? (
          <SkillsView key={project?.id} project={project} />
        ) : view === 'settings' ? (
          <SettingsView />
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
                <p>Chats run OpenCode, Cline or Command Code inside a project folder.</p>
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
          onClose={() => toggleBrowser(chat?.id, false)}
        />
      )}
    </div>
  )
}

/**
 * The title in the top bar. When the open chat's title changes (the agent
 * names a new chat), the new one fades in; switching chats swaps it at once.
 */
function TopbarName({ id, text }: { id?: string; text: string }): React.JSX.Element {
  const [last, setLast] = useState({ id, text, changed: false })
  if (last.id !== id || last.text !== text) setLast({ id, text, changed: last.id === id })
  return (
    <span key={`${id}:${text}`} className={`topbar-name${last.changed ? ' changed' : ''}`}>
      {text}
    </span>
  )
}
