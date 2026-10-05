import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  AgentCommand,
  Attachment,
  AgentModels,
  AgentOption,
  OpenChatResult,
  AgentStatus,
  AgentId,
  AppState,
  BrowserState,
  Chat,
  ChatItem,
  Project,
  Rect,
  Skill,
  SkillScope,
  Theme
} from '../shared/types'
import type { MenuCommand } from '../main/menu'

function on<Args extends unknown[]>(
  channel: string,
  listener: (...args: Args) => void
): () => void {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]): void =>
    listener(...(args as Args))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke('state:get'),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  onState: (listener: (state: AppState) => void) => on('state:changed', listener),
  onMenu: (listener: (command: MenuCommand) => void) => on('menu', listener),
  setTheme: (theme: Theme): Promise<void> => ipcRenderer.invoke('theme:set', theme),

  addProject: (): Promise<Project | null> => ipcRenderer.invoke('project:add'),
  removeProject: (projectId: string): Promise<void> =>
    ipcRenderer.invoke('project:remove', projectId),

  createChat: (
    projectId: string,
    agent: AgentId,
    settings: Record<string, string>,
    permissions: Pick<Chat, 'bypassPermissions' | 'projectOnly'> = {}
  ): Promise<Chat> => ipcRenderer.invoke('chat:create', projectId, agent, settings, permissions),
  deleteChat: (chatId: string): Promise<void> => ipcRenderer.invoke('chat:delete', chatId),
  renameChat: (chatId: string, title: string): Promise<void> =>
    ipcRenderer.invoke('chat:rename', chatId, title),
  getMessages: (chatId: string): Promise<ChatItem[]> => ipcRenderer.invoke('chat:messages', chatId),
  setAgent: (chatId: string, agent: AgentId, settings: Record<string, string>): Promise<void> =>
    ipcRenderer.invoke('chat:setAgent', chatId, agent, settings),
  send: (chatId: string, text: string, attachments: Attachment[] = []): Promise<void> =>
    ipcRenderer.invoke('chat:send', chatId, text, attachments),
  /** Choose files to attach with the system file picker. */
  pickFiles: (): Promise<Attachment[]> => ipcRenderer.invoke('files:pick'),
  /** The path of a dropped or pasted file (empty for data with no file, like a screenshot). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  cancel: (chatId: string): Promise<void> => ipcRenderer.invoke('chat:cancel', chatId),
  setProjectOnly: (chatId: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('chat:setProjectOnly', chatId, enabled),
  setBypassPermissions: (chatId: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('chat:setBypass', chatId, enabled),
  setOption: (chatId: string, optionId: string, value: string): Promise<void> =>
    ipcRenderer.invoke('chat:setOption', chatId, optionId, value),
  resolvePermission: (chatId: string, permissionId: string, optionId: string): Promise<void> =>
    ipcRenderer.invoke('chat:permission', chatId, permissionId, optionId),
  onItem: (listener: (chatId: string, item: ChatItem) => void) => on('chat:item', listener),

  openChat: (chatId: string): Promise<OpenChatResult> => ipcRenderer.invoke('chat:open', chatId),
  onCommands: (listener: (chatId: string, commands: AgentCommand[]) => void) =>
    on('chat:commands', listener),
  onOptions: (listener: (chatId: string, options: AgentOption[]) => void) =>
    on('chat:options', listener),
  agentStatus: (agent: AgentId): Promise<AgentStatus> => ipcRenderer.invoke('agents:status', agent),
  agentModels: (agent: AgentId, projectId: string): Promise<AgentModels> =>
    ipcRenderer.invoke('agents:models', agent, projectId),

  browser: {
    setBounds: (rect: Rect | null): void => ipcRenderer.send('browser:setBounds', rect),
    /** Which chat's page the panel shows. */
    setChat: (chatId: string | null): void => ipcRenderer.send('browser:setChat', chatId),
    navigate: (url: string): Promise<void> => ipcRenderer.invoke('browser:navigate', url),
    back: (): Promise<void> => ipcRenderer.invoke('browser:back'),
    forward: (): Promise<void> => ipcRenderer.invoke('browser:forward'),
    reload: (): Promise<void> => ipcRenderer.invoke('browser:reload'),
    selectTab: (tabId: string): Promise<void> => ipcRenderer.invoke('browser:selectTab', tabId),
    closeTab: (tabId: string): Promise<void> => ipcRenderer.invoke('browser:closeTab', tabId),
    newTab: (): Promise<void> => ipcRenderer.invoke('browser:newTab'),
    clearData: (): Promise<void> => ipcRenderer.invoke('browser:clearData'),
    getState: (): Promise<BrowserState> => ipcRenderer.invoke('browser:state'),
    onState: (listener: (state: BrowserState) => void) => on('browser:state', listener),
    /** Open or close the browser panel in a chat. */
    setOpen: (chatId: string, open: boolean): Promise<void> =>
      ipcRenderer.invoke('browser:setOpen', chatId, open)
  },

  listFiles: (projectPath: string): Promise<string[]> =>
    ipcRenderer.invoke('files:list', projectPath),

  skills: {
    list: (projectPath?: string): Promise<Skill[]> =>
      ipcRenderer.invoke('skills:list', projectPath),
    read: (path: string, projectPath?: string): Promise<string> =>
      ipcRenderer.invoke('skills:read', path, projectPath),
    create: (name: string, scope: SkillScope, projectPath?: string): Promise<string> =>
      ipcRenderer.invoke('skills:create', name, scope, projectPath),
    save: (path: string, content: string, projectPath?: string): Promise<void> =>
      ipcRenderer.invoke('skills:save', path, content, projectPath),
    remove: (path: string, projectPath?: string): Promise<void> =>
      ipcRenderer.invoke('skills:delete', path, projectPath),
    reveal: (path: string): Promise<void> => ipcRenderer.invoke('skills:reveal', path)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
