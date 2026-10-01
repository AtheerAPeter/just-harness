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
import type { BrowserState, Rect } from '../shared/types'
import { PageDriver } from './page-driver'

/**
 * `persist:` partitions are stored on disk, so cookies, localStorage and
 * IndexedDB (logins) survive restarts. Every chat's page uses the same
 * partition, so they all share the user's logins.
 *
 * Each chat has its own page, so several chats can automate the browser at
 * once. The panel shows the selected chat's page; pages of other chats that are
 * running stay alive, parked out of sight. A page is closed when its chat is
 * neither selected nor running, and its last URL is reopened next time.
 */
const PARTITION = 'persist:browser'
const EMPTY_STATE: BrowserState = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false
}
/** Page size for chats working in the background before the panel was ever shown. */
const DEFAULT_BOUNDS = { x: 0, y: 0, width: 1024, height: 768 }

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
 * A chat's page: its view, the driver agents use, and the dialog it waits on.
 * Emits 'dialog' when a dialog opens.
 */
export class ChatPage extends EventEmitter {
  readonly driver: PageDriver
  dialog?: PageDialog
  /** The message box showing the dialog to the user, while it is on screen. */
  box?: AbortController
  /** In the panel, as opposed to parked out of sight. */
  shown = false
  /** Agent tool calls in progress on this page. */
  private automating = 0

  constructor(readonly view: WebContentsView) {
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

export class BuiltinBrowser {
  /** Most recent first; agents read paths from here to use downloaded files. */
  readonly downloads: Download[] = []
  /** download() calls waiting for their file, matched by page and URL. */
  private downloadWaiters: {
    contents: WebContents
    url: string
    done: (download: Download) => void
  }[] = []

  private pages = new Map<string, ChatPage>()
  private activeChat?: string
  /** Where the panel is, in window points; undefined while the panel is closed. */
  private panelBounds?: Electron.Rectangle
  private waitingForPanel: (() => void)[] = []

  constructor(
    private readonly window: BrowserWindow,
    private readonly onState: (state: BrowserState) => void,
    /** Open the panel in this chat (it is the selected chat). */
    private readonly requestShow: (chatId: string) => void,
    private readonly isRunning: (chatId: string) => boolean,
    /** Where each chat's last page is kept, so it survives restarts. */
    private readonly lastPage: {
      get(chatId: string): string | undefined
      set(chatId: string, url: string): void
    }
  ) {
    const browserSession = session.fromPartition(PARTITION)
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

  private viewFor(chatId: string): ChatPage {
    const existing = this.pages.get(chatId)
    if (existing) return existing
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        // Hidden pages of background chats must keep running their automation.
        backgroundThrottling: false,
        // Routes alert() and confirm() to the app (see onPageDialog). Run in
        // iframes too; with the sandbox on, frames get no Node.js either way.
        preload: join(import.meta.dirname, '../preload/page.cjs'),
        nodeIntegrationInSubFrames: true
      }
    })
    const page = new ChatPage(view)
    const contents = view.webContents
    contents.setWindowOpenHandler((details) => {
      // Sign-in flows open real popups and rely on window.opener; allow those in
      // the same session. Anything that would open a tab loads here instead, so
      // the page never leaves the chat's browser.
      if (details.disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 720,
            webPreferences: { partition: PARTITION }
          }
        }
      }
      contents.loadURL(details.url)
      return { action: 'deny' }
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
    // Remember every page as it is reached, so the chat (and its agent) can pick
    // up there after the page is closed or the app restarts.
    const remember = (): void => {
      const url = contents.getURL()
      if (url && url !== 'about:blank') this.lastPage.set(chatId, url)
    }
    contents.on('did-navigate', remember)
    contents.on('did-navigate-in-page', remember)
    // A page with unsaved changes asks before it is left. Electron would
    // silently stay; the agent was asked to leave, the user is asked.
    contents.on('will-prevent-unload', (event) => {
      if (page.automated) {
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
      page.driver.detach()
      page.closeDialog()
      if (chatId === this.activeChat) this.emitState()
    })
    view.setBounds(parked(this.panelBounds ?? DEFAULT_BOUNDS))
    this.window.contentView.addChildView(view)
    contents.loadURL(this.lastPage.get(chatId) ?? 'about:blank').catch(() => undefined)
    this.pages.set(chatId, page)
    return page
  }

  /** The page of a chat, created if needed. */
  page(chatId: string): ChatPage {
    return this.viewFor(chatId)
  }

  private pageOf(contents: WebContents): [string, ChatPage] | undefined {
    for (const entry of this.pages) if (entry[1].contents === contents) return entry
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
    const [chatId, page] = entry
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
    if (chatId === this.activeChat) this.showDialog()
  }

  /** Show the dialog of the page in the panel, if it has one, in a message box. */
  private showDialog(): void {
    const page = this.activeChat ? this.pages.get(this.activeChat) : undefined
    const open = page?.dialog
    if (!page || !open?.answer || page.box || !this.panelBounds) return
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

  private closeView(chatId: string): void {
    const page = this.pages.get(chatId)
    if (!page) return
    this.pages.delete(chatId)
    page.dismissDialog()
    page.closeDialog()
    page.driver.detach()
    this.window.contentView.removeChildView(page.view)
    page.contents.close()
  }

  /** Close pages that nothing needs: not shown in the panel and not running. */
  prune(): void {
    for (const chatId of [...this.pages.keys()]) {
      const shown = chatId === this.activeChat && this.panelBounds
      if (!shown && !this.isRunning(chatId)) this.closeView(chatId)
    }
  }

  /** Put the selected chat's page in the panel and park the others. */
  private layout(): void {
    for (const [chatId, page] of this.pages) {
      const shown = chatId === this.activeChat && this.panelBounds
      page.shown = Boolean(shown)
      page.view.setBounds(shown || parked(this.panelBounds ?? page.view.getBounds()))
    }
    this.showDialog()
  }

  /** The chat whose page the panel shows. */
  setActiveChat(chatId: string | undefined): void {
    this.activeChat = chatId
    if (chatId && this.panelBounds) this.viewFor(chatId)
    this.layout()
    this.prune()
    this.emitState()
  }

  /** Called by the renderer with the panel's rect, or null when the panel is closed. */
  setBounds(rect: Rect | null): void {
    if (!rect) {
      this.panelBounds = undefined
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
    if (this.activeChat) this.viewFor(this.activeChat)
    this.layout()
    for (const resolve of this.waitingForPanel.splice(0)) resolve()
    this.emitState()
  }

  /**
   * Get a chat's page ready for an agent. For the selected chat the panel is
   * opened so the user can watch; other chats work hidden in the background.
   */
  async ensureReady(chatId: string): Promise<ChatPage> {
    if (chatId === this.activeChat && !this.panelBounds) {
      const shown = new Promise<void>((resolve) => this.waitingForPanel.push(resolve))
      this.requestShow(chatId)
      await Promise.race([shown, new Promise((resolve) => setTimeout(resolve, 3000))])
    }
    const page = this.viewFor(chatId)
    // A page whose renderer crashed comes back by loading it again.
    if (page.contents.isCrashed()) await reloadAndWait(page.contents)
    return page
  }

  /** Download a URL with the browser's logins and wait until the file is saved. */
  download(chatId: string, url: string): Promise<Download> {
    const contents = this.page(chatId).contents
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

  /** Open a URL in the selected chat's page and show the panel (links in chat messages). */
  async open(url: string): Promise<void> {
    if (!this.activeChat) return
    const page = await this.ensureReady(this.activeChat)
    page.dismissDialog()
    await page.contents.loadURL(normalizeUrl(url))
  }

  // Toolbar actions act on the page the panel shows. A dialog the page waits on
  // is cancelled first, as Chrome does when you leave a page.

  navigate(input: string): Promise<void> {
    if (!this.activeChat) return Promise.resolve()
    const page = this.page(this.activeChat)
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

  private activePage(): ChatPage | undefined {
    return this.activeChat ? this.pages.get(this.activeChat) : undefined
  }

  async clearData(): Promise<void> {
    await session.fromPartition(PARTITION).clearStorageData()
    for (const page of this.pages.values()) {
      page.dismissDialog()
      page.contents.reload()
    }
  }

  /** Make sure logins written moments ago reach disk before quitting. */
  async flush(): Promise<void> {
    const browserSession = session.fromPartition(PARTITION)
    await browserSession.cookies.flushStore()
    browserSession.flushStorageData()
  }

  /** A chat's current page (the selected chat by default), without creating one. */
  state(chatId = this.activeChat): BrowserState {
    const contents = chatId ? this.pages.get(chatId)?.contents : undefined
    if (!contents) {
      return { ...EMPTY_STATE, url: (chatId && this.lastPage.get(chatId)) || '' }
    }
    const url = contents.getURL()
    return {
      // A blank page shows as an empty address bar, with its placeholder.
      url: url === 'about:blank' ? '' : url,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward()
    }
  }

  /** Close a deleted chat's page. */
  closeChat(chatId: string): void {
    this.closeView(chatId)
  }

  private emitState(): void {
    this.onState(this.state())
  }
}

/** Reload a page and wait until it has loaded, or failed to, or 15 seconds passed. */
function reloadAndWait(contents: WebContents): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      contents.off('did-finish-load', done)
      contents.off('did-fail-load', done)
      resolve()
    }
    const timer = setTimeout(done, 15_000)
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
