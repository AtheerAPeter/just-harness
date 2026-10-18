export type AgentId =
  | 'opencode'
  | 'cline'
  | 'commandcode'
  | 'commandcode-api'
  | 'opencode-api'
  | 'cline-api'
  | 'custom-api'

export const AGENTS: { id: AgentId; label: string }[] = [
  { id: 'opencode', label: 'OpenCode' },
  { id: 'cline', label: 'Cline' },
  { id: 'commandcode', label: 'Command Code' },
  { id: 'commandcode-api', label: 'Command Code API' },
  { id: 'opencode-api', label: 'OpenCode API' },
  { id: 'cline-api', label: 'Cline API' },
  { id: 'custom-api', label: 'Custom providers' }
]

/** The agents the app runs itself, one per provider API; custom-api runs the providers added in Settings. */
export const HARNESS_AGENTS = [
  'commandcode-api',
  'opencode-api',
  'cline-api',
  'custom-api'
] as const
export type HarnessAgentId = (typeof HARNESS_AGENTS)[number]

export function isHarnessAgent(agent: string): agent is HarnessAgentId {
  return (HARNESS_AGENTS as readonly string[]).includes(agent)
}

/**
 * The wire format a custom provider speaks: OpenAI Chat Completions, OpenAI
 * Responses, or Anthropic Messages.
 */
export type ProviderApi = 'chat' | 'responses' | 'messages'

/** A provider the user added in Settings, as the window sees it: never its key. */
export interface CustomProvider {
  id: string
  name: string
  api: ProviderApi
  /** Where the API lives, e.g. https://api.openai.com/v1. */
  baseURL: string
  /** Sent with every request, after the key, so they can replace its header. */
  headers: Record<string, string>
  /** The model ids to offer; empty lists the ones the provider's /models returns. */
  models: string[]
  /** The saved key's last four characters; null when it has none. */
  keyHint: string | null
}

/**
 * A provider to save. `apiKey` undefined keeps the saved key, null removes it.
 * Without an id, it is added.
 */
export interface CustomProviderInput {
  id?: string
  name: string
  api: ProviderApi
  baseURL: string
  headers: Record<string, string>
  models: string[]
  apiKey?: string | null
}

/**
 * Well-known providers, to fill in the form with. `catalog` is the provider's
 * id on models.dev, where its models' output limits and image input are read
 * (for any provider at the same address).
 */
export const PROVIDER_PRESETS: {
  name: string
  api: ProviderApi
  baseURL: string
  catalog?: string
  /** Local servers take no key. */
  keyless?: boolean
}[] = [
  { name: 'OpenAI', api: 'responses', baseURL: 'https://api.openai.com/v1', catalog: 'openai' },
  {
    name: 'Anthropic',
    api: 'messages',
    baseURL: 'https://api.anthropic.com/v1',
    catalog: 'anthropic'
  },
  {
    name: 'OpenRouter',
    api: 'chat',
    baseURL: 'https://openrouter.ai/api/v1',
    catalog: 'openrouter'
  },
  {
    name: 'Google Gemini',
    api: 'chat',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    catalog: 'google'
  },
  { name: 'DeepSeek', api: 'chat', baseURL: 'https://api.deepseek.com', catalog: 'deepseek' },
  { name: 'xAI', api: 'chat', baseURL: 'https://api.x.ai/v1', catalog: 'xai' },
  { name: 'Groq', api: 'chat', baseURL: 'https://api.groq.com/openai/v1', catalog: 'groq' },
  { name: 'Mistral', api: 'chat', baseURL: 'https://api.mistral.ai/v1', catalog: 'mistral' },
  { name: 'Ollama', api: 'chat', baseURL: 'http://localhost:11434/v1', keyless: true },
  {
    name: 'LM Studio',
    api: 'chat',
    baseURL: 'http://localhost:1234/v1',
    catalog: 'lmstudio',
    keyless: true
  }
]

/** What a provider serves now: how many models, or why they could not be listed. */
export interface CustomProviderCheck {
  models?: number
  error?: string
}

export const PROJECT_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink'
] as const
export type ProjectColor = (typeof PROJECT_COLORS)[number]

export const PROJECT_ICONS = [
  'folder',
  'globe',
  'terminal',
  'book',
  'chat',
  'wrench',
  'shield',
  'gauge',
  'pencil',
  'lock'
] as const
export type ProjectIconName = (typeof PROJECT_ICONS)[number]

export interface Project {
  id: string
  name: string
  path: string
  createdAt: number
  /** Marks the project's icon and its chats in the sidebar: a preset, or a custom #rrggbb. */
  color?: ProjectColor | `#${string}`
  /** Chosen by the user; unset shows the project's own icon (its favicon) if it has one. */
  icon?: ProjectIconName
}

export interface Chat {
  id: string
  projectId: string
  title: string
  /** Set once the user renames the chat; automatic titles no longer replace it. */
  renamed?: boolean
  agent: AgentId
  /**
   * The agent the chat switched from after it had started. The new agent has
   * none of the conversation, so its next message tells it to read the saved one.
   */
  handoff?: AgentId
  /** ACP session id, set once the first prompt has been sent. */
  sessionId?: string
  /** Selected values for the agent's session options, keyed by option id (model, mode, ...). */
  settings: Record<string, string>
  running: boolean
  /** True while a permission request in this chat waits for the user. */
  waiting?: boolean
  /** The user's messages sent while the chat works, waiting to join its turn or follow it. */
  waitingMessages?: { id: string; text: string }[]
  /**
   * What the chat has going in the background, each of which wakes it when
   * it ends or goes off (see chats-mcp.ts), so a chat between turns is not
   * done. Only for this launch: quitting stops them.
   */
  background?: ChatBackground
  /** The first line of the chat's last message, shown under its title in the sidebar. */
  preview?: string
  /** What the user typed in the composer and has not sent yet. */
  draft?: string
  /** Approve every permission request automatically (allow once). */
  bypassPermissions?: boolean
  /** Refuse any tool request that touches a path outside the project folder. */
  projectOnly?: boolean
  /** The chat's browser tabs, reopened when its browser comes back. */
  browserTabs?: SavedTabs
  /** Whether the browser panel is open in this chat; every chat starts closed at launch. */
  browserOpen?: boolean
  /**
   * The chat whose agent started this one with start_chat (chats-mcp.ts), or
   * null when the user did. Absent only in chats saved before it was recorded,
   * until the next launch looks it up.
   */
  startedBy?: string | null
  createdAt: number
  updatedAt: number
}

/** A chat's commands running with run_in_background, and its timer (see set_timer). */
export interface ChatBackground {
  /** Oldest first; `started` in ms since the epoch. */
  commands: { pid: number; command: string; started: number }[]
  /** `at`: when it goes off, in ms since the epoch. */
  timer?: { note: string; at: number }
}

/**
 * The chats each chat started (see Chat.startedBy), in the order it started
 * them. A chat whose starter was deleted is listed on its own again.
 */
export function startedChats(chats: Chat[]): Map<string, Chat[]> {
  const ids = new Set(chats.map((c) => c.id))
  const started = new Map<string, Chat[]>()
  for (const chat of [...chats].sort((a, b) => a.createdAt - b.createdAt)) {
    if (chat.startedBy && ids.has(chat.startedBy)) {
      started.set(chat.startedBy, [...(started.get(chat.startedBy) ?? []), chat])
    }
  }
  return started
}

/** A file or image attached to a message: a path on disk, or pasted image data. */
export interface Attachment {
  name: string
  path?: string
  mimeType?: string
  /** Base64 contents, for pasted images that have no file. */
  data?: string
}

/** The scheme the window loads chat images with (see main/images.ts). */
export const IMAGE_SCHEME = 'chat-image'

/** Where the window loads one of a chat's saved images from. */
export function imageUrl(chatId: string, file: string): string {
  return `${IMAGE_SCHEME}://${chatId}/${file}`
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
  /** Why the list is empty, when it could not be read. */
  error?: string
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

/**
 * Who sent a message the user did not write (see chats-mcp.ts): another
 * chat's agent, with the title it had then (saved before senders had a kind,
 * so the kind may be missing); a command the chat ran in the background,
 * reporting that it ended; the timer the chat set; or the app, reporting that
 * a chat this one started ended its turn without reporting back.
 */
export type ChatSender =
  | { kind?: 'chat'; chatId: string; title: string }
  | { kind: 'command'; command: string }
  | { kind: 'timer'; note: string }
  | { kind: 'ended'; chatId: string; title: string }

/** The chat a message came from, when another chat sent it. */
export function senderChat(from: ChatSender | undefined): string | undefined {
  return from && (from.kind === undefined || from.kind === 'chat') ? from.chatId : undefined
}

/** 'interrupted': the turn ended before the agent finished the call. */
export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'interrupted'

export type ChatItem =
  | {
      kind: 'user'
      id: string
      text: string
      /**
       * Names of files and images sent with the message, and for images the
       * copy the chat saved to show them (see main/images.ts).
       */
      attachments?: { name: string; image: boolean; file?: string }[]
      /** When it was sent, in ms since the epoch. */
      sentAt?: number
      /** How long the agent worked on it, once its turn has ended. */
      workedMs?: number
      /** Sent by another chat's agent or a background command (see chats-mcp.ts), not by the user. */
      from?: ChatSender
    }
  | {
      kind: 'text'
      id: string
      text: string
      /** Images the agent sent after the text, as saved by the chat (see main/images.ts). */
      images?: string[]
    }
  | { kind: 'thought'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      title: string
      /** An ACP tool kind, or 'agent' for a subagent the app's own agent started. */
      toolKind?: string
      status: ToolStatus
      input?: string
      output?: string
      /** Images in the output, such as a screenshot, as saved by the chat (see main/images.ts). */
      images?: string[]
      /** The subagent call this call was made in, for calls shown under their subagent. */
      parentId?: string
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
      /**
       * Set when the app asks the user something other than whether a tool may
       * run (signing in to an MCP server): shown in place of "Allow …?".
       */
      question?: string
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
  /** The page's icon, as the page declares it. */
  favicon?: string
  /** The tab the agent is working in: it acted on it last, in a turn still running. */
  controlled: boolean
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
