export type AgentId =
  'opencode' | 'cline' | 'commandcode' | 'commandcode-api' | 'opencode-api' | 'cline-api'

export const AGENTS: { id: AgentId; label: string }[] = [
  { id: 'opencode', label: 'OpenCode' },
  { id: 'cline', label: 'Cline' },
  { id: 'commandcode', label: 'Command Code' },
  { id: 'commandcode-api', label: 'Command Code API' },
  { id: 'opencode-api', label: 'OpenCode API' },
  { id: 'cline-api', label: 'Cline API' }
]

export interface Project {
  id: string
  name: string
  path: string
  createdAt: number
}

export interface Chat {
  id: string
  projectId: string
  title: string
  /** Set once the user renames the chat; automatic titles no longer replace it. */
  renamed?: boolean
  agent: AgentId
  /** ACP session id, set once the first prompt has been sent. */
  sessionId?: string
  /** Selected values for the agent's session options, keyed by option id (model, mode, ...). */
  settings: Record<string, string>
  running: boolean
  /** True while a permission request in this chat waits for the user. */
  waiting?: boolean
  /** The first line of the chat's last message, shown under its title in the sidebar. */
  preview?: string
  /** Approve every permission request automatically (allow once). */
  bypassPermissions?: boolean
  /** Refuse any tool request that touches a path outside the project folder. */
  projectOnly?: boolean
  /** The chat's browser tabs, reopened when its browser comes back. */
  browserTabs?: SavedTabs
  /** Whether the browser panel is open in this chat. */
  browserOpen?: boolean
  createdAt: number
  updatedAt: number
}

/** A file or image attached to a message: a path on disk, or pasted image data. */
export interface Attachment {
  name: string
  path?: string
  mimeType?: string
  /** Base64 contents, for pasted images that have no file. */
  data?: string
}

export type Theme = 'system' | 'light' | 'dark'

export interface AppState {
  projects: Project[]
  chats: Chat[]
  /** Appearance; 'system' follows macOS. Missing in state saved by older versions. */
  theme?: Theme
}

/** A session option exposed by the agent (model, mode, reasoning effort, ...). */
export interface AgentOption {
  id: string
  name: string
  category: string
  currentValue: string
  values: { value: string; name: string; description?: string }[]
}

/** A slash command the agent advertises (ACP available_commands_update). */
export interface AgentCommand {
  name: string
  description: string
}

export interface OpenChatResult {
  options: AgentOption[]
  commands: AgentCommand[]
  error?: string
}

/**
 * The options a model is picked from. Agents report them in the "model" category:
 * the model list last, and before it the option the list depends on, if any
 * (cline's provider).
 */
export function modelOptions(options: AgentOption[]): {
  model?: AgentOption
  source?: AgentOption
} {
  const listed = options.filter((o) => o.category === 'model')
  return { model: listed.at(-1), source: listed.length > 1 ? listed.at(-2) : undefined }
}

/** One list of models an agent offers: all of them, or those of one of its providers. */
export interface ModelSource {
  /** The source option's value this list comes with (cline's provider); unset when there is one list. */
  setting?: { optionId: string; value: string; name: string }
  /** The model option, as the agent reports it with that setting. */
  option: AgentOption
}

/** The models an agent offers, for picking one before a chat uses that agent. */
export interface AgentModels {
  sources: ModelSource[]
  error?: string
}

export interface AgentStatus {
  agent: AgentId
  available: boolean
  version?: string
  error?: string
}

/** 'interrupted': the turn ended before the agent finished the call. */
export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'interrupted'

export type ChatItem =
  | {
      kind: 'user'
      id: string
      text: string
      /** Names of files and images sent with the message. */
      attachments?: { name: string; image: boolean }[]
    }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thought'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      title: string
      toolKind?: string
      status: ToolStatus
      input?: string
      output?: string
    }
  | { kind: 'plan'; id: string; entries: { content: string; status: string }[] }
  | {
      kind: 'permission'
      id: string
      title: string
      options: { optionId: string; name: string; kind: string }[]
      /** optionId chosen, or 'cancelled'. Undefined while waiting on the user. */
      resolved?: string
      /** Approved by bypass-permissions mode rather than by the user. */
      auto?: boolean
      /** Project-only mode: the path outside the project this request touches. */
      outside?: string
    }
  | { kind: 'error'; id: string; text: string }
  /** Something the app tells the user about the chat, such as a finished compaction. */
  | { kind: 'notice'; id: string; text: string }

/** A chat's browser tabs as saved between launches: their pages and which one was active. */
export interface SavedTabs {
  urls: string[]
  active: number
}

export interface BrowserTab {
  /** Short id agents use: t1, t2, ... */
  id: string
  title: string
  url: string
  loading: boolean
}

/** The selected chat's browser: its tabs, and the active tab's page. */
export interface BrowserState {
  tabs: BrowserTab[]
  activeTab?: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type SkillScope = 'project' | 'global'

export interface Skill {
  name: string
  description: string
  /** Absolute path to SKILL.md. */
  path: string
  scope: SkillScope
  /** Agents that discover this skill from its location. */
  agents: AgentId[]
}
