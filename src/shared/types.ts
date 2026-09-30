export type AgentId = 'opencode' | 'cline'

export const AGENTS: { id: AgentId; label: string }[] = [
  { id: 'opencode', label: 'OpenCode' },
  { id: 'cline', label: 'Cline' }
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
  /** Approve every permission request automatically (allow once). */
  bypassPermissions?: boolean
  /** Refuse any tool request that touches a path outside the project folder. */
  projectOnly?: boolean
  /** Last page the chat's browser showed, reopened when its browser comes back. */
  browserUrl?: string
  /** Whether the browser panel is open in this chat. */
  browserOpen?: boolean
  createdAt: number
  updatedAt: number
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

export interface AgentStatus {
  agent: AgentId
  available: boolean
  version?: string
  error?: string
}

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
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

export interface BrowserState {
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
