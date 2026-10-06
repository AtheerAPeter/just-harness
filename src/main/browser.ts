import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  WebContentsView,
  session,
  type IpcMainEvent,
  type WebContents
} from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { extname, basename, join } from 'node:path'
import type { BrowserState, Rect, SavedTabs } from '../shared/types'
import { PageDriver } from './page-driver'

/**
 * `persist:` partitions are stored on disk, so cookies, localStorage and
 * IndexedDB (logins) survive restarts. Every chat's pages use the same
 * partition, so they all share the user's logins.
 *
 * Each chat has its own browser with tabs, so several chats can automate the
 * browser at once. The panel shows the selected chat's active tab; every other
 * tab, and the tabs of other chats that are running, stay alive, parked out of
 * sight. A chat's browser is closed when the chat is neither selected nor
 * running, and its tabs are reopened next time.
 */
const PARTITION = 'persist:browser'
const EMPTY_STATE: BrowserState = {
  tabs: [],
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false
}
/** Page size for chats working in the background before the panel was ever shown. */
const DEFAULT_BOUNDS = { x: 0, y: 0, width: 1024, height: 768 }
/** Tabs one chat's browser may have open. */
const MAX_TABS = 20
/** Corner radius of the page, matching .browser-viewport in styles.css. */
const PAGE_RADIUS = 12
/**
 * For tabs and the windows pages open as tabs. With the sandbox on, iframes get
 * no Node.js either way; they run the page preload (see onPageDialog).
 */
const TAB_PREFERENCES = {
  partition: PARTITION,
  sandbox: true,
  contextIsolation: true,
  nodeIntegrationInSubFrames: true
}

export interface Download {
  url: string
  path: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
}

/** An alert() or confirm() a page is waiting on. */
export interface PageDialog {
  type: 'alert' | 'confirm'
  message: string
  /** The site asking, as shown to the user. */
  site: string
  /**
   * Answer it: OK, or Cancel. Missing for a dialog Electron shows itself (from
   * a frame the page preload does not run in), which only the user can answer.
   */
  answer?: (accept: boolean) => void
}

/** A free file name in the folder: "name.ext", then "name (1).ext", ... */
function uniquePath(folder: string, fileName: string): string {
  const ext = extname(fileName)
  const stem = basename(fileName, ext) || 'download'
  let path = join(folder, `${stem}${ext}`)
  for (let n = 1; existsSync(path); n++) path = join(folder, `${stem} (${n})${ext}`)
  return path
}

/**
 * Where a page waits out of sight: left of the window, at its size. Pages are
 * parked rather than hidden because Chromium sends no mouse input to a page
 * that was never shown, and pages of background chats must stay clickable.
 */
function parked(bounds: Electron.Rectangle): Electron.Rectangle {
  return { ...bounds, x: -bounds.width - 100 }
}

function siteOf(url: string): string {
  try {
    return new URL(url).host || 'This page'
  } catch {
    return 'This page'
  }
}

/**
 * A tab of a chat's browser: its view, the driver agents use, and the dialog it
 * waits on. Emits 'dialog' when a dialog opens.
 */
export class ChatPage extends EventEmitter {
  readonly driver: PageDriver
  dialog?: PageDialog
  /** The message box showing the dialog to the user, while it is on screen. */
  box?: AbortController
  /** In the panel, as opposed to parked out of sight. */
  shown = false
  /** The page it shows, kept for reopening the tab after the browser closes. */
  url = ''
  /**
   * A reopened tab that has not loaded its page yet. Every page is a renderer
   * process, so saved tabs load when they are first used, not all at once.
   */
  unloaded = false
  /** Agent tool calls in progress on this page. */
  private automating = 0

  constructor(
    /** Short id agents use: t1, t2, ... */
    readonly id: string,
    readonly view: WebContentsView,
    /** The tab whose page opened this one (window.open, a link to a new tab). */
    readonly openedBy?: ChatPage
  ) {
    super()
    this.driver = new PageDriver(
      view.webContents,
      (native) => {
        if (native) this.openDialog({ ...native, site: siteOf(this.contents.getURL()) })
        else if (this.dialog && !this.dialog.answer) this.closeDialog()
      },
      () => this.shown
    )
  }

  get contents(): WebContents {
    return this.view.webContents
  }

  /** Load the page of a reopened tab, if it has not been loaded yet. Settles when it has loaded or failed. */
  load(): Promise<void> {
    if (!this.unloaded) return Promise.resolve()
    this.unloaded = false
    return this.contents.loadURL(this.url || 'about:blank').catch(() => undefined)
  }

  /** Whether an agent tool call is running on the page. */
  get automated(): boolean {
    return this.automating > 0
  }

  /** Run an agent tool call on the page. */
  async automate<T>(work: () => Promise<T>): Promise<T> {
    this.automating++
    try {
      return await work()
    } finally {
      this.automating--
    }
  }

  openDialog(dialog: PageDialog): void {
    this.dialog = dialog
    this.emit('dialog')
  }

  /** Forget the dialog and take its message box off the screen. */
  closeDialog(): void {
    this.box?.abort()
    this.box = undefined
    this.dialog = undefined
  }

  /** Cancel the dialog if there is one, so the page can go on (or go away). */
  dismissDialog(): void {
    this.dialog?.answer?.(false)
  }
}

/** The tabs of one chat's browser. */
interface ChatTabs {
  tabs: ChatPage[]
  active?: ChatPage
  /** For the next tab's id. */
  next: number
  /** While its saved tabs are being reopened, which must not overwrite what was saved. */
  restoring: boolean
}

export class BuiltinBrowser {
  /** Most recent first; agents read paths from here to use downloaded files. */
  readonly downloads: Download[] = []
  /** download() calls waiting for their file, matched by page and URL. */
  private downloadWaiters: {
    contents: WebContents
    url: string
    done: (download: Download) => void
  }[] = []

  private chats = new Map<string, ChatTabs>()
  private activeChat?: string
  /** Where the panel is, in window points; undefined while the panel is closed. */
  private panelBounds?: Electron.Rectangle
  /** The panel is open but its page is out of sight for a moment, while the user resizes it. */
  private panelHidden = false
  private waitingForPanel: (() => void)[] = []

  constructor(
    private readonly window: BrowserWindow,
    private readonly onState: (state: BrowserState) => void,
    /** Open the panel in this chat (it is the selected chat). */
    private readonly requestShow: (chatId: string) => void,
    private readonly isRunning: (chatId: string) => boolean,
    /** Where each chat's tabs are kept, so they survive restarts. */
    private readonly savedTabs: {
      get(chatId: string): SavedTabs | undefined
      set(chatId: string, tabs: SavedTabs): void
    }
  ) {
    const browserSession = session.fromPartition(PARTITION)
    // Routes alert() and confirm() to the app (see onPageDialog). Registered on
    // the session, so it also runs in windows that pages open as tabs.
    browserSession.registerPreloadScript({
      type: 'frame',
      id: 'just-harness-page',
      filePath: join(import.meta.dirname, '../preload/page.cjs')
    })
    // Save straight to ~/Downloads instead of showing a Save dialog, which an
    // agent cannot answer, and record where each file went.
    browserSession.on('will-download', (_event, item, contents) => {
      const download: Download = {
        url: item.getURL(),
        path: uniquePath(app.getPath('downloads'), item.getFilename()),
        state: 'progressing'
      }
      item.setSavePath(download.path)
      this.downloads.unshift(download)
      this.downloads.splice(50)
      // The download() call that asked for this file, if any (the first URL is
      // the one requested, before redirects).
      const requested = item.getURLChain()[0]
      const waiter = this.downloadWaiters.find(
        (w) => w.contents === contents && w.url === requested
      )
      if (waiter) this.downloadWaiters.splice(this.downloadWaiters.indexOf(waiter), 1)
      item.once('done', (_e, state) => {
        download.state = state
        waiter?.done(download)
      })
    })
    // Some sign-in pages (Google in particular) reject user agents that mention Electron.
    browserSession.setUserAgent(
      browserSession
        .getUserAgent()
        .replace(/\sElectron\/\S+/, '')
        .replace(/\sjust-harness\/\S+/, '')
    )
    ipcMain.on('page:dialog', (event, type, message) => this.onPageDialog(event, type, message))
  }

  /** A chat's browser, opened with its saved tabs if it is not open. */
  private browserFor(chatId: string): ChatTabs {
    const existing = this.chats.get(chatId)
    if (existing) return existing
    const browser: ChatTabs = { tabs: [], next: 1, restoring: true }
    this.chats.set(chatId, browser)
    const saved = this.savedTabs.get(chatId)
    for (const url of saved?.urls.length ? saved.urls : ['']) this.addTab(chatId, browser, { url })
    browser.active = browser.tabs[Math.min(saved?.active ?? 0, browser.tabs.length - 1)]
    void browser.active.load()
    browser.restoring = false
    this.layout()
    return browser
  }

  /**
   * Open a tab in a chat's browser: a new page, or a window one of its pages
   * opened (window.open, a link to a new tab), which keeps its tie to the
   * page that opened it, so sign-in popups can report back.
   */
  private addTab(
    chatId: string,
    browser: ChatTabs,
    options: {
      url?: string
      /** What Electron passes to createWindow for a window a page opened. */
      opened?: Electron.BrowserWindowConstructorOptions
      openedBy?: ChatPage
      activate?: boolean
    }
  ): ChatPage {
    const view = new WebContentsView(options.opened ?? { webPreferences: TAB_PREFERENCES })
    view.setBorderRadius(PAGE_RADIUS)
    const tab = new ChatPage(`t${browser.next++}`, view, options.openedBy)
    const contents = tab.contents
    // Tabs out of sight and tabs of background chats keep running their automation.
    contents.setBackgroundThrottling(false)
    contents.setWindowOpenHandler((details) => {
      if (browser.tabs.length >= MAX_TABS) return { action: 'deny' }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: TAB_PREFERENCES },
        createWindow: (opened) =>
          this.addTab(chatId, browser, {
            opened,
            openedBy: tab,
            // ⌘-click opens a link in the background, as in Chrome.
            activate: details.disposition !== 'background-tab'
          }).contents
      }
    })
    for (const event of [
      'did-navigate',
      'did-navigate-in-page',
      'page-title-updated',
      'did-start-loading',
      'did-stop-loading'
    ] as const) {
      contents.on(event as 'did-stop-loading', () => {
        if (chatId === this.activeChat) this.emitState()
      })
    }
    // Remember every page as it is reached, so the tab (and its agent) can pick
    // up there after the browser is closed or the app restarts.
    const remember = (): void => {
      tab.url = contents.getURL()
      this.saveTabs(chatId)
    }
    contents.on('did-navigate', remember)
    contents.on('did-navigate-in-page', remember)
    // A page with unsaved changes asks before it is left. Electron would
    // silently stay; the agent was asked to leave, the user is asked.
    contents.on('will-prevent-unload', (event) => {
      if (tab.automated) {
        event.preventDefault()
        return
      }
      const choice = dialog.showMessageBoxSync(this.window, {
        type: 'question',
        buttons: ['Leave', 'Stay'],
        defaultId: 0,
        cancelId: 1,
        message: 'Leave this page?',
        detail: 'Changes you made may not be saved.'
      })
      if (choice === 0) event.preventDefault()
    })
    contents.on('render-process-gone', () => {
      tab.driver.detach()
      tab.closeDialog()
      if (chatId === this.activeChat) this.emitState()
    })
    // Closed by the page itself (window.close()) or with the rest of the browser.
    contents.once('destroyed', () => this.removeTab(chatId, tab))
    view.setBounds(parked(this.panelBounds ?? DEFAULT_BOUNDS))
    this.window.contentView.addChildView(view)
    browser.tabs.push(tab)
    if (options.activate || !browser.active) browser.active = tab
    if (!options.opened) {
      tab.url = options.url ?? ''
      tab.unloaded = true
      // Reopened tabs wait until they are used; the active one is loaded by browserFor.
      if (!browser.restoring) void tab.load()
    }
    if (!browser.restoring) {
      this.layout()
      this.saveTabs(chatId)
      if (chatId === this.activeChat) this.emitState()
    }
    return tab
  }

  /** Take a closed tab out of its browser; the tab that opened it, or a neighbour, becomes active. */
  private removeTab(chatId: string, tab: ChatPage): void {
    tab.closeDialog()
    tab.driver.detach()
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view)
    const browser = this.chats.get(chatId)
    const index = browser?.tabs.indexOf(tab) ?? -1
    if (!browser || index === -1) return
    browser.tabs.splice(index, 1)
    if (browser.active === tab) {
      browser.active =
        tab.openedBy && browser.tabs.includes(tab.openedBy)
          ? tab.openedBy
          : browser.tabs[Math.min(index, browser.tabs.length - 1)]
      void browser.active?.load()
    }
    // A browser always has a tab.
    if (!browser.tabs.length) this.addTab(chatId, browser, { url: '' })
    this.layout()
    this.saveTabs(chatId)
    if (chatId === this.activeChat) this.emitState()
  }

  private saveTabs(chatId: string): void {
    const browser = this.chats.get(chatId)
    if (!browser || browser.restoring || !browser.active) return
    this.savedTabs.set(chatId, {
      urls: browser.tabs.map((tab) => (tab.url === 'about:blank' ? '' : tab.url)),
      active: browser.tabs.indexOf(browser.active)
    })
  }

  /** A chat's tabs, its browser opened if needed. */
  tabs(chatId: string): { tabs: ChatPage[]; active: ChatPage } {
    const browser = this.browserFor(chatId)
    return { tabs: browser.tabs, active: browser.active! }
  }

  /** Open a blank tab in a chat's browser and make it the active one. */
  newTab(chatId: string): ChatPage {
    const browser = this.browserFor(chatId)
    if (browser.tabs.length >= MAX_TABS) {
      throw new Error(
        `This browser has ${MAX_TABS} tabs open, the most it can have. Close some first.`
      )
    }
    return this.addTab(chatId, browser, { url: '', activate: true })
  }

  /** Make a tab the active one, shown in the panel when its chat is selected. */
  selectTab(chatId: string, tabId: string): ChatPage {
    const browser = this.browserFor(chatId)
    const tab = this.findTab(browser, tabId)
    browser.active = tab
    void tab.load()
    this.layout()
    this.saveTabs(chatId)
    if (chatId === this.activeChat) this.emitState()
    return tab
  }

  /** Close a tab. A page waiting on a dialog is answered Cancel first. */
  closeTab(chatId: string, tabId: string): void {
    const tab = this.findTab(this.browserFor(chatId), tabId)
    tab.dismissDialog()
    this.removeTab(chatId, tab)
    tab.contents.close()
  }

  private findTab(browser: ChatTabs, tabId: string): ChatPage {
    const tab = browser.tabs.find((t) => t.id === tabId)
    if (!tab) {
      const open = browser.tabs.map((t) => t.id).join(', ')
      throw new Error(`There is no tab ${tabId}. Open tabs: ${open}.`)
    }
    return tab
  }

  private pageOf(contents: WebContents): [string, ChatPage] | undefined {
    for (const [chatId, browser] of this.chats) {
      const tab = browser.tabs.find((t) => t.contents === contents)
      if (tab) return [chatId, tab]
    }
    return undefined
  }

  /**
   * alert() and confirm() from a page, sent by its preload. The page waits
   * until it is answered: by the user in a message box (shown while the page
   * is in the panel), or by the agent. Replying null lets the page show
   * Electron's own dialog, which Chromium blocks for cross-origin iframes.
   */
  private onPageDialog(event: IpcMainEvent, type: unknown, message: unknown): void {
    const entry = this.pageOf(event.sender)
    const frame = event.senderFrame
    if (
      !entry ||
      !frame ||
      entry[1].dialog ||
      (type !== 'alert' && type !== 'confirm') ||
      typeof message !== 'string' ||
      frame.origin !== event.sender.mainFrame.origin
    ) {
      event.returnValue = null
      return
    }
    const [, page] = entry
    const open: PageDialog = {
      type,
      message,
      site: siteOf(frame.origin),
      answer: (accept) => {
        if (page.dialog !== open) return
        page.closeDialog()
        event.returnValue = type === 'confirm' ? accept : true
      }
    }
    page.openDialog(open)
    this.showDialog()
  }

  /** Show the dialog of the page in the panel, if it has one, in a message box. */
  private showDialog(): void {
    const page = this.activePage()
    const open = page?.dialog
    if (!page?.shown || !open?.answer || page.box) return
    const box = new AbortController()
    page.box = box
    dialog
      .showMessageBox(this.window, {
        type: open.type === 'alert' ? 'info' : 'question',
        message: `${open.site} says`,
        detail: open.message,
        buttons: open.type === 'alert' ? ['OK'] : ['OK', 'Cancel'],
        defaultId: 0,
        cancelId: open.type === 'alert' ? 0 : 1,
        noLink: true,
        signal: box.signal
      })
      .then(({ response }) => {
        // Aborted when the agent answered first or the page went away.
        if (!box.signal.aborted) open.answer?.(response === 0)
      })
  }

  /** Close a chat's browser and all its tabs. */
  private closeBrowser(chatId: string): void {
    const browser = this.chats.get(chatId)
    if (!browser) return
    this.chats.delete(chatId)
    for (const tab of browser.tabs) {
      tab.dismissDialog()
      tab.closeDialog()
      tab.driver.detach()
      // A turn ending while the app quits closes its browser after the window is gone.
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view)
      tab.contents.close()
    }
  }

  /** Close browsers that nothing needs: not shown in the panel and not running. */
  prune(): void {
    for (const chatId of [...this.chats.keys()]) {
      const shown = chatId === this.activeChat && this.panelBounds
      if (!shown && !this.isRunning(chatId)) this.closeBrowser(chatId)
    }
  }

  /** Put the selected chat's active tab in the panel and park every other tab. */
  private layout(): void {
    for (const [chatId, browser] of this.chats) {
      for (const tab of browser.tabs) {
        const shown =
          chatId === this.activeChat && tab === browser.active && !this.panelHidden
            ? this.panelBounds
            : undefined
        tab.shown = Boolean(shown)
        tab.view.setBounds(shown ?? parked(this.panelBounds ?? tab.view.getBounds()))
      }
    }
    this.showDialog()
  }

  /** The chat whose browser the panel shows. */
  setActiveChat(chatId: string | undefined): void {
    this.activeChat = chatId
    if (chatId && this.panelBounds) this.browserFor(chatId)
    this.layout()
    this.prune()
    this.emitState()
  }

  /** Called by the renderer with the panel's rect, or null when the panel is closed. */
  setBounds(rect: Rect | null): void {
    if (!rect) {
      this.panelBounds = undefined
      this.panelHidden = false
      this.layout()
      this.prune()
      return
    }
    // The renderer measures in CSS pixels, which change with the app's zoom level;
    // the native view is placed in window points.
    const zoom = this.window.webContents.getZoomFactor()
    this.panelBounds = {
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.round(rect.width * zoom),
      height: Math.round(rect.height * zoom)
    }
    if (this.activeChat) this.browserFor(this.activeChat)
    this.layout()
    for (const resolve of this.waitingForPanel.splice(0)) resolve()
    this.emitState()
  }

  /**
   * Park the panel's page while the panel stays open: the native view would
   * swallow the pointer while the user drags the panel's edge. Unlike closing
   * the panel, this keeps every page as it is.
   */
  setPanelHidden(hidden: boolean): void {
    this.panelHidden = hidden
    this.layout()
  }

  /**
   * Get a tab of a chat's browser ready for an agent: the given one, or the
   * active one. For the selected chat the panel is opened so the user can
   * watch; other chats work in the background.
   */
  async ensureReady(chatId: string, tabId?: string): Promise<ChatPage> {
    if (chatId === this.activeChat && !this.panelBounds) {
      const shown = new Promise<void>((resolve) => this.waitingForPanel.push(resolve))
      this.requestShow(chatId)
      await Promise.race([shown, new Promise((resolve) => setTimeout(resolve, 3000))])
    }
    const browser = this.browserFor(chatId)
    const tab = tabId ? this.findTab(browser, tabId) : browser.active!
    // A reopened tab loads its page on first use.
    if (tab.unloaded) await loadedWithin(tab.load())
    // A page whose renderer crashed comes back by loading it again.
    if (tab.contents.isCrashed()) await reloadAndWait(tab.contents)
    return tab
  }

  /** Download a URL with the browser's logins and wait until the file is saved. */
  download(chatId: string, url: string): Promise<Download> {
    const contents = this.tabs(chatId).active.contents
    return new Promise<Download>((resolve, reject) => {
      const waiter = {
        contents,
        url: new URL(url).href,
        done: (download: Download) => {
          clearTimeout(timer)
          resolve(download)
        }
      }
      const timer = setTimeout(() => {
        this.downloadWaiters = this.downloadWaiters.filter((w) => w !== waiter)
        reject(new Error('Download did not finish within 5 minutes'))
      }, 300_000)
      this.downloadWaiters.push(waiter)
      contents.downloadURL(url)
    })
  }

  /** Open a link from a chat message in a new tab of the selected chat's browser. */
  async open(url: string): Promise<void> {
    if (!this.activeChat) return
    await this.ensureReady(this.activeChat)
    await this.newTab(this.activeChat).contents.loadURL(normalizeUrl(url))
  }

  // Toolbar actions act on the tab the panel shows. A dialog the page waits on
  // is cancelled first, as Chrome does when you leave a page.

  navigate(input: string): Promise<void> {
    if (!this.activeChat) return Promise.resolve()
    const page = this.tabs(this.activeChat).active
    page.dismissDialog()
    return page.contents.loadURL(normalizeUrl(input))
  }

  back(): void {
    const page = this.activePage()
    page?.dismissDialog()
    if (page?.contents.navigationHistory.canGoBack()) page.contents.navigationHistory.goBack()
  }

  forward(): void {
    const page = this.activePage()
    page?.dismissDialog()
    if (page?.contents.navigationHistory.canGoForward()) page.contents.navigationHistory.goForward()
  }

  reload(): void {
    const page = this.activePage()
    page?.dismissDialog()
    page?.contents.reload()
  }

  /** The tab buttons of the panel, for the selected chat. */
  selectActiveChatTab(tabId: string): void {
    if (this.activeChat) this.selectTab(this.activeChat, tabId)
  }

  closeActiveChatTab(tabId: string): void {
    if (this.activeChat) this.closeTab(this.activeChat, tabId)
  }

  newActiveChatTab(): void {
    if (this.activeChat) this.newTab(this.activeChat)
  }

  /** Minimized or hidden: macOS draws nothing for it, so pages cannot be captured. */
  get windowHidden(): boolean {
    return this.window.isMinimized() || !this.window.isVisible()
  }

  /** The tab the panel shows, if the selected chat's browser is open. */
  private activePage(): ChatPage | undefined {
    return this.activeChat ? this.chats.get(this.activeChat)?.active : undefined
  }

  async clearData(): Promise<void> {
    await session.fromPartition(PARTITION).clearStorageData()
    for (const browser of this.chats.values()) {
      for (const tab of browser.tabs) {
        tab.dismissDialog()
        // A tab that has not loaded yet will load with the cleared data anyway.
        if (!tab.unloaded) tab.contents.reload()
      }
    }
  }

  /** Make sure logins written moments ago reach disk before quitting. */
  async flush(): Promise<void> {
    const browserSession = session.fromPartition(PARTITION)
    await browserSession.cookies.flushStore()
    browserSession.flushStorageData()
  }

  /** A chat's browser (the selected chat by default), without opening it. */
  state(chatId = this.activeChat): BrowserState {
    const browser = chatId ? this.chats.get(chatId) : undefined
    const contents = browser?.active?.contents
    if (!browser || !contents) {
      const saved = chatId ? this.savedTabs.get(chatId) : undefined
      return { ...EMPTY_STATE, url: saved?.urls[saved.active] ?? '' }
    }
    const shownUrl = (url: string): string => (url === 'about:blank' ? '' : url)
    return {
      tabs: browser.tabs.map((tab) => ({
        id: tab.id,
        title: tab.contents.getTitle(),
        url: shownUrl(tab.contents.getURL() || tab.url),
        loading: tab.contents.isLoading()
      })),
      activeTab: browser.active?.id,
      // A blank page shows as an empty address bar, with its placeholder.
      url: shownUrl(contents.getURL()),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward()
    }
  }

  /** Close a deleted chat's browser. */
  closeChat(chatId: string): void {
    this.closeBrowser(chatId)
  }

  private emitState(): void {
    this.onState(this.state())
  }
}

/** How long an agent waits for a page to load before working with it as it is. */
const LOAD_WAIT_MS = 15_000

/** Wait for a page load to settle, or LOAD_WAIT_MS, whichever comes first. */
function loadedWithin(load: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    load,
    new Promise<void>((resolve) => (timer = setTimeout(resolve, LOAD_WAIT_MS)))
  ]).finally(() => clearTimeout(timer))
}

/** Reload a page and wait until it has loaded, or failed to, or LOAD_WAIT_MS passed. */
function reloadAndWait(contents: WebContents): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      contents.off('did-finish-load', done)
      contents.off('did-fail-load', done)
      resolve()
    }
    const timer = setTimeout(done, LOAD_WAIT_MS)
    contents.on('did-finish-load', done)
    contents.on('did-fail-load', done)
    contents.reload()
  })
}

export function normalizeUrl(input: string): string {
  const text = input.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text
  if (/^localhost(:\d+)?(\/|$)/.test(text) || /^[\d.]+(:\d+)?(\/|$)/.test(text))
    return `http://${text}`
  if (/^[^\s]+\.[^\s]{2,}$/.test(text)) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
}
