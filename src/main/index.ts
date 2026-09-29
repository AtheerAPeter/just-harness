import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeTheme,
  systemPreferences
} from 'electron'
import { basename, join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import appIcon from '../../resources/icon.png?asset'
import type {
  AgentCommand,
  AgentId,
  AgentOption,
  Chat,
  ChatItem,
  Rect,
  SkillScope,
  Theme
} from '../shared/types'
import * as store from './store'
import { AgentManager } from './agents'
import { BuiltinBrowser } from './browser'
import { startBrowserMcp } from './browser-mcp'
import { registerBrowserWithCline } from './cline-mcp'
import { installMenu } from './menu'
import { loadShellPath } from './shell-env'
import * as skills from './skills'
import { listProjectFiles } from './files'

let mainWindow: BrowserWindow
let browser: BuiltinBrowser | undefined

function send(channel: string, ...args: unknown[]): void {
  if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

const agents = new AgentManager(
  {
    item: (chatId: string, item: ChatItem) => send('chat:item', chatId, item),
    options: (chatId: string, options: AgentOption[]) => send('chat:options', chatId, options),
    commands: (chatId: string, commands: AgentCommand[]) => send('chat:commands', chatId, commands),
    stateChanged: () => send('state:changed', store.getState())
  },
  () => browser?.state()
)

function createWindow(): BuiltinBrowser {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 560,
    show: false,
    titleBarStyle: 'hiddenInset',
    // Centred on the 52px toolbar row.
    trafficLightPosition: { x: 20, y: 19 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  systemPreferences.on('accent-color-changed', (_event, color) =>
    send('system:accent', `#${color}`)
  )

  const browser = new BuiltinBrowser(
    mainWindow,
    (state) => send('browser:state', state),
    () => send('browser:show')
  )

  // Links in chat messages open in the built-in browser, not the system one.
  // Other schemes (mailto: and the like) still go to their macOS handler.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:/i.test(details.url)) browser.open(details.url).catch(() => undefined)
    else shell.openExternal(details.url)
    return { action: 'deny' }
  })

  return browser
}

/**
 * nativeTheme drives prefers-color-scheme in the app and in browser pages, and
 * the native window material, so one setting switches everything.
 */
function setTheme(theme: Theme): void {
  nativeTheme.themeSource = theme
  store.setTheme(theme)
  installMenu((command) => send('menu', command), theme, setTheme)
  send('state:changed', store.getState())
}

function registerIpc(browser: BuiltinBrowser): void {
  ipcMain.handle('theme:set', (_e, theme: Theme) => setTheme(theme))
  ipcMain.handle('state:get', () => store.getState())
  ipcMain.handle('system:accent', () => `#${systemPreferences.getAccentColor()}`)

  ipcMain.handle('project:add', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Add project'
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
    const existing = store.getState().projects.find((p) => p.path === path)
    if (existing) return existing
    const project = { id: crypto.randomUUID(), name: basename(path), path, createdAt: Date.now() }
    store.addProject(project)
    send('state:changed', store.getState())
    return project
  })

  ipcMain.handle('project:remove', (_e, projectId: string) => {
    store.removeProject(projectId)
    send('state:changed', store.getState())
  })

  ipcMain.handle(
    'chat:create',
    (_e, projectId: string, agent: AgentId, settings: Record<string, string>) => {
      const chat: Chat = {
        id: crypto.randomUUID(),
        projectId,
        title: 'New chat',
        agent,
        settings,
        running: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      store.addChat(chat)
      send('state:changed', store.getState())
      return chat
    }
  )

  ipcMain.handle('chat:delete', (_e, chatId: string) => agents.deleteChat(chatId))

  ipcMain.handle('chat:rename', (_e, chatId: string, title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return
    store.updateChat(chatId, { title: trimmed, renamed: true })
    send('state:changed', store.getState())
  })
  ipcMain.handle('chat:messages', (_e, chatId: string) => store.getMessages(chatId))

  ipcMain.handle(
    'chat:setAgent',
    (_e, chatId: string, agent: AgentId, settings: Record<string, string>) =>
      agents.changeAgent(chatId, agent, settings)
  )
  ipcMain.handle('chat:open', (_e, chatId: string) => agents.open(chatId))

  // Fire and forget: progress arrives through chat:item and state:changed events.
  ipcMain.handle('chat:send', (_e, chatId: string, text: string) => {
    void agents.send(chatId, text)
  })
  ipcMain.handle('chat:setBypass', (_e, chatId: string, enabled: boolean) =>
    agents.setBypassPermissions(chatId, enabled)
  )
  ipcMain.handle('chat:cancel', (_e, chatId: string) => agents.cancel(chatId))
  ipcMain.handle('chat:setOption', (_e, chatId: string, optionId: string, value: string) =>
    agents.setOption(chatId, optionId, value)
  )
  ipcMain.handle('chat:permission', (_e, chatId: string, permissionId: string, optionId: string) =>
    agents.resolvePermission(chatId, permissionId, optionId)
  )

  ipcMain.handle('agents:status', (_e, agent: AgentId) => agents.status(agent))

  ipcMain.on('browser:setBounds', (_e, rect: Rect | null) => browser.setBounds(rect))
  ipcMain.handle('browser:navigate', (_e, url: string) =>
    browser.navigate(url).catch(() => undefined)
  )
  ipcMain.handle('browser:back', () => browser.back())
  ipcMain.handle('browser:forward', () => browser.forward())
  ipcMain.handle('browser:reload', () => browser.reload())
  ipcMain.handle('browser:clearData', () => browser.clearData())
  ipcMain.handle('browser:state', () => browser.state())

  ipcMain.handle('files:list', (_e, projectPath: string) => listProjectFiles(projectPath))
  ipcMain.handle('skills:list', (_e, projectPath?: string) => skills.listSkills(projectPath))
  ipcMain.handle('skills:read', (_e, path: string, projectPath?: string) =>
    skills.readSkill(path, projectPath)
  )
  ipcMain.handle('skills:create', (_e, name: string, scope: SkillScope, projectPath?: string) =>
    skills.createSkill(name, scope, projectPath)
  )
  ipcMain.handle('skills:save', (_e, path: string, content: string, projectPath?: string) =>
    skills.saveSkill(path, content, projectPath)
  )
  ipcMain.handle('skills:delete', (_e, path: string, projectPath?: string) =>
    skills.deleteSkill(path, projectPath)
  )
  ipcMain.handle('skills:reveal', (_e, path: string) => shell.showItemInFolder(path))
}

// One instance only: a second one would share the same data files and browser profile.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => {
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.setName('Just Harness')

app.whenReady().then(async () => {
  // A packaged build takes its icon from the bundle; in development the Electron
  // binary's own icon would show, so set it here.
  if (!app.isPackaged) app.dock?.setIcon(appIcon)
  electronApp.setAppUserModelId('dev.justharness.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  await loadShellPath()
  // Set before the window exists so it opens in the right appearance.
  nativeTheme.themeSource = store.getState().theme ?? 'system'
  installMenu((command) => send('menu', command), nativeTheme.themeSource, setTheme)
  browser = createWindow()
  registerIpc(browser)
  const endpoint = await startBrowserMcp(browser)
  // Only when cline is installed; failures are logged and the app works without it.
  agents.status('cline').then(({ available }) => {
    if (!available) return
    registerBrowserWithCline(endpoint).catch((error) =>
      console.error('Could not register the browser tools with cline:', error.message)
    )
  })
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  agents.stopAll()
  store.flush()
  ;(browser?.flush() ?? Promise.resolve()).finally(() => app.quit())
})

// Single-window app: closing the window quits, which also stops the agent processes.
app.on('window-all-closed', () => app.quit())
