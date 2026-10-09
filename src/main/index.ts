import { app, shell, BrowserWindow, ipcMain, dialog, nativeTheme } from 'electron'
import { basename, join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import appIcon from '../../resources/icon.png?asset'
import type {
  AgentCommand,
  Attachment,
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
import { exaKeyHint, setExaKey } from './exa-key'
import { installMenu } from './menu'
import { loadShellPath } from './shell-env'
import * as skills from './skills'
import { listProjectFiles } from './files'

let mainWindow: BrowserWindow
let browser: BuiltinBrowser | undefined
/** Set once the app is quitting: closing the window then really closes it. */
let quitting = false

function send(channel: string, ...args: unknown[]): void {
  if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

const agents = new AgentManager(
  {
    item: (chatId: string, item: ChatItem) => send('chat:item', chatId, item),
    options: (chatId: string, options: AgentOption[]) => send('chat:options', chatId, options),
    commands: (chatId: string, commands: AgentCommand[]) => send('chat:commands', chatId, commands),
    stateChanged: () => {
      send('state:changed', store.getState())
      // A chat that stopped running may no longer need its browser page, and
      // no longer controls a tab.
      browser?.prune()
      browser?.endControl()
    }
  },
  (chatId) => browser?.state(chatId)
)

function createWindow(): BuiltinBrowser {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 560,
    show: false,
    titleBarStyle: 'hiddenInset',
    // Inside the sidebar panel, centred on the 52px toolbar row of the panels (10px in from the window edge).
    trafficLightPosition: { x: 24, y: 29 },
    // Opaque, in the chat's background color: a transparent window would make
    // macOS blend it with what is behind it on every frame.
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: false
    }
  })

  // A sheet attached in the same tick as show() is never drawn; the show event comes after.
  mainWindow.once('show', () => store.reportDamagedState(mainWindow))
  mainWindow.on('ready-to-show', () => mainWindow.show())
  // As in other Mac apps, closing the window hides it and the app stays in the
  // Dock: chats keep running, and the window comes back as it was. Quitting
  // (⌘Q) closes it for real and stops the agents.
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    // A full-screen window would leave an empty space behind; it leaves full screen first.
    if (mainWindow.isFullScreen()) {
      mainWindow.once('leave-full-screen', () => mainWindow.hide())
      mainWindow.setFullScreen(false)
    } else {
      mainWindow.hide()
    }
  })
  // A crashed renderer leaves the window blank. Chats live in this process, so
  // loading the window again loses nothing; one that keeps crashing is left to the user.
  let lastReload = 0
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`The window's renderer is gone: ${details.reason} (${details.exitCode})`)
    if (details.reason === 'clean-exit' || mainWindow.isDestroyed()) return
    if (Date.now() - lastReload < 30_000) {
      dialog.showErrorBox(
        'Just Harness stopped responding',
        'The window crashed again right after reloading. Quit and open the app again.'
      )
      return
    }
    lastReload = Date.now()
    mainWindow.webContents.reload()
  })
  nativeTheme.on('updated', () => {
    if (!mainWindow.isDestroyed()) mainWindow.setBackgroundColor(windowBackground())
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  const browser = new BuiltinBrowser(
    mainWindow,
    (state) => send('browser:state', state),
    (chatId) => setBrowserOpen(chatId, true),
    (chatId) => store.getState().chats.some((c) => c.id === chatId && c.running),
    {
      get: (chatId) => store.getState().chats.find((c) => c.id === chatId)?.browserTabs,
      set: (chatId, tabs) => {
        if (store.getState().chats.some((c) => c.id === chatId)) {
          store.updateChat(chatId, { browserTabs: tabs })
        }
      }
    }
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

/** The window's color behind the page, matching --canvas in styles.css. */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#0c0c0e' : '#eceef2'
}

/**
 * nativeTheme drives prefers-color-scheme in the app and in browser pages, and
 * the window background, so one setting switches everything.
 */
function setTheme(theme: Theme): void {
  nativeTheme.themeSource = theme
  store.setTheme(theme)
  installMenu((command) => send('menu', command), theme, setTheme)
  send('state:changed', store.getState())
}

/** The browser panel is open or closed per chat, saved with the chat. */
function setBrowserOpen(chatId: string, open: boolean): void {
  if (!store.getState().chats.some((c) => c.id === chatId)) return
  store.updateChat(chatId, { browserOpen: open })
  send('state:changed', store.getState())
}

function registerIpc(browser: BuiltinBrowser): void {
  ipcMain.handle('browser:setOpen', (_e, chatId: string, open: boolean) =>
    setBrowserOpen(chatId, open)
  )
  ipcMain.handle('theme:set', (_e, theme: Theme) => setTheme(theme))
  ipcMain.handle('state:get', () => store.getState())
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('exa:keyHint', () => exaKeyHint())
  ipcMain.handle('exa:setKey', (_e, key: string | null) => setExaKey(key))

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
    (
      _e,
      projectId: string,
      agent: AgentId,
      settings: Record<string, string>,
      permissions: Pick<Chat, 'bypassPermissions' | 'projectOnly'> = {}
    ) => {
      const chat: Chat = {
        id: crypto.randomUUID(),
        projectId,
        title: 'New chat',
        agent,
        settings,
        bypassPermissions: permissions.bypassPermissions,
        projectOnly: permissions.projectOnly,
        running: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      store.addChat(chat)
      send('state:changed', store.getState())
      return chat
    }
  )

  ipcMain.handle('chat:delete', async (_e, chatId: string) => {
    await agents.deleteChat(chatId)
    browser.closeChat(chatId)
  })

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
  ipcMain.handle('chat:send', (_e, chatId: string, text: string, attachments?: Attachment[]) => {
    void agents.send(chatId, text, attachments)
  })
  ipcMain.handle('files:pick', async (): Promise<Attachment[]> => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      buttonLabel: 'Attach'
    })
    return result.canceled ? [] : result.filePaths.map((path) => ({ name: basename(path), path }))
  })
  ipcMain.handle(
    'chat:setPermissions',
    (_e, chatId: string, permissions: Pick<Chat, 'bypassPermissions' | 'projectOnly'>) =>
      agents.setPermissions(chatId, permissions)
  )
  ipcMain.handle('chat:cancel', (_e, chatId: string) => agents.cancel(chatId))
  ipcMain.handle('chat:setOption', (_e, chatId: string, optionId: string, value: string) =>
    agents.setOption(chatId, optionId, value)
  )
  ipcMain.handle('chat:permission', (_e, chatId: string, permissionId: string, optionId: string) =>
    agents.resolvePermission(chatId, permissionId, optionId)
  )

  ipcMain.handle('agents:status', (_e, agent: AgentId) => agents.status(agent))
  ipcMain.handle('agents:models', (_e, agent: AgentId, projectId: string) =>
    agents.models(agent, projectId)
  )

  ipcMain.on('browser:setChat', (_e, chatId: string | null) =>
    browser.setActiveChat(chatId ?? undefined)
  )
  ipcMain.on('browser:setBounds', (_e, rect: Rect | null) => browser.setBounds(rect))
  ipcMain.on('browser:setHidden', (_e, hidden: boolean) => browser.setPanelHidden(hidden))
  ipcMain.handle('browser:capture', () => browser.capturePanel())
  ipcMain.handle('browser:navigate', (_e, url: string) =>
    browser.navigate(url).catch(() => undefined)
  )
  ipcMain.handle('browser:back', () => browser.back())
  ipcMain.handle('browser:forward', () => browser.forward())
  ipcMain.handle('browser:reload', () => browser.reload())
  ipcMain.handle('browser:selectTab', (_e, tabId: string) => browser.selectActiveChatTab(tabId))
  ipcMain.handle('browser:closeTab', (_e, tabId: string) => browser.closeActiveChatTab(tabId))
  ipcMain.handle('browser:newTab', () => browser.newActiveChatTab())
  ipcMain.on('browser:menu', (_e, x: number, y: number) => browser.showMenu(x, y))
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
  mainWindow.show()
})

// Clicking the Dock icon brings back a closed (hidden) window.
app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
})

app.setName('Just Harness')

app.whenReady().then(async () => {
  // A packaged build takes its icon from the bundle; in development the Electron
  // binary's own icon would show, so set it here.
  if (!app.isPackaged) app.dock?.setIcon(appIcon)
  electronApp.setAppUserModelId('dev.justharness.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // Only commands need PATH, and they wait for it; the window does not.
  void loadShellPath()
  // Set before the window exists so it opens in the right appearance.
  nativeTheme.themeSource = store.getState().theme ?? 'system'
  installMenu((command) => send('menu', command), nativeTheme.themeSource, setTheme)
  browser = createWindow()
  registerIpc(browser)
  const endpoint = await startBrowserMcp(browser, {
    chatForBrowserId: (id) => store.getState().chats.find((c) => c.id.startsWith(id))?.id,
    fallbackChat: () => agents.latestActiveChat()
  })
  // Only when cline is installed; failures are logged and the app works without it.
  agents.status('cline').then(({ available }) => {
    if (!available) return
    registerBrowserWithCline(endpoint).catch((error) =>
      console.error('Could not register the browser tools with cline:', error.message)
    )
  })
})

app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  const stopped = agents.stopAll()
  // A failed save (a full disk) must not keep the app from quitting.
  try {
    store.flush()
  } catch (error) {
    console.error('Could not save before quitting:', error)
  }
  browser?.closeAll()
  Promise.allSettled([stopped, browser?.flush()]).finally(() => app.quit())
})

// Closing the window only hides it, so it closes for good only while quitting.
// Should it go any other way, the app quits rather than run without a window.
app.on('window-all-closed', () => app.quit())
