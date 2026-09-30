import { app, BrowserWindow, WebContentsView, session, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { extname, basename, join } from 'node:path'
import type { BrowserState, Rect } from '../shared/types'

/**
 * `persist:` partitions are stored on disk, so cookies, localStorage and
 * IndexedDB (logins) survive restarts. Every chat's page uses the same
 * partition, so they all share the user's logins.
 *
 * Each chat has its own page, so several chats can automate the browser at
 * once. The panel shows the selected chat's page; pages of other chats that are
 * running stay alive hidden. A page is closed when its chat is neither selected
 * nor running, and its last URL is reopened next time.
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

/** A free file name in the folder: "name.ext", then "name (1).ext", ... */
function uniquePath(folder: string, fileName: string): string {
  const ext = extname(fileName)
  const stem = basename(fileName, ext) || 'download'
  let path = join(folder, `${stem}${ext}`)
  for (let n = 1; existsSync(path); n++) path = join(folder, `${stem} (${n})${ext}`)
  return path
}

export class BuiltinBrowser {
  /** Most recent first; agents read paths from here to use downloaded files. */
  readonly downloads: Download[] = []
  private downloadWaiters: ((download: Download) => void)[] = []

  private views = new Map<string, WebContentsView>()
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
    browserSession.on('will-download', (_event, item) => {
      const download: Download = {
        url: item.getURL(),
        path: uniquePath(app.getPath('downloads'), item.getFilename()),
        state: 'progressing'
      }
      item.setSavePath(download.path)
      this.downloads.unshift(download)
      this.downloads.splice(50)
      item.once('done', (_e, state) => {
        download.state = state
        for (const notify of this.downloadWaiters.splice(0)) notify(download)
      })
    })
    // Some sign-in pages (Google in particular) reject user agents that mention Electron.
    browserSession.setUserAgent(
      browserSession
        .getUserAgent()
        .replace(/\sElectron\/\S+/, '')
        .replace(/\sjust-harness\/\S+/, '')
    )
  }

  private viewFor(chatId: string): WebContentsView {
    const existing = this.views.get(chatId)
    if (existing) return existing
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        // Hidden pages of background chats must keep running their automation.
        backgroundThrottling: false
      }
    })
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
    // Attached (so it lays out and renders at a real size) but hidden until shown.
    view.setBounds(this.panelBounds ?? DEFAULT_BOUNDS)
    view.setVisible(false)
    this.window.contentView.addChildView(view)
    contents.loadURL(this.lastPage.get(chatId) ?? 'about:blank')
    this.views.set(chatId, view)
    return view
  }

  /** The page of a chat, created if needed. */
  contents(chatId: string): WebContents {
    return this.viewFor(chatId).webContents
  }

  private closeView(chatId: string): void {
    const view = this.views.get(chatId)
    if (!view) return
    this.views.delete(chatId)
    this.window.contentView.removeChildView(view)
    view.webContents.close()
  }

  /** Close pages that nothing needs: not shown in the panel and not running. */
  prune(): void {
    for (const chatId of [...this.views.keys()]) {
      const shown = chatId === this.activeChat && this.panelBounds
      if (!shown && !this.isRunning(chatId)) this.closeView(chatId)
    }
  }

  /** Show only the selected chat's page, at the panel's position. */
  private layout(): void {
    for (const [chatId, view] of this.views) {
      const shown = chatId === this.activeChat && this.panelBounds !== undefined
      if (this.panelBounds) view.setBounds(this.panelBounds)
      view.setVisible(shown)
    }
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
  async ensureReady(chatId: string): Promise<WebContents> {
    if (chatId === this.activeChat && !this.panelBounds) {
      const shown = new Promise<void>((resolve) => this.waitingForPanel.push(resolve))
      this.requestShow(chatId)
      await Promise.race([shown, new Promise((resolve) => setTimeout(resolve, 3000))])
    }
    return this.contents(chatId)
  }

  /** Download a URL with the browser's logins and wait until the file is saved. */
  download(chatId: string, url: string): Promise<Download> {
    const finished = new Promise<Download>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error('Download did not finish within 5 minutes')),
        300_000
      )
      this.downloadWaiters.push((download) => {
        clearTimeout(timer)
        done(download)
      })
    })
    this.contents(chatId).downloadURL(url)
    return finished
  }

  /** Open a URL in the selected chat's page and show the panel (links in chat messages). */
  async open(url: string): Promise<void> {
    if (!this.activeChat) return
    const contents = await this.ensureReady(this.activeChat)
    await contents.loadURL(normalizeUrl(url))
  }

  // Toolbar actions act on the page the panel shows.

  navigate(input: string): Promise<void> {
    if (!this.activeChat) return Promise.resolve()
    return this.contents(this.activeChat).loadURL(normalizeUrl(input))
  }

  back(): void {
    const history = this.activePage()?.navigationHistory
    if (history?.canGoBack()) history.goBack()
  }

  forward(): void {
    const history = this.activePage()?.navigationHistory
    if (history?.canGoForward()) history.goForward()
  }

  reload(): void {
    this.activePage()?.reload()
  }

  private activePage(): WebContents | undefined {
    return this.activeChat ? this.views.get(this.activeChat)?.webContents : undefined
  }

  async clearData(): Promise<void> {
    await session.fromPartition(PARTITION).clearStorageData()
    for (const view of this.views.values()) view.webContents.reload()
  }

  /** Make sure logins written moments ago reach disk before quitting. */
  async flush(): Promise<void> {
    const browserSession = session.fromPartition(PARTITION)
    await browserSession.cookies.flushStore()
    browserSession.flushStorageData()
  }

  /** A chat's current page (the selected chat by default), without creating one. */
  state(chatId = this.activeChat): BrowserState {
    const contents = chatId ? this.views.get(chatId)?.webContents : undefined
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

export function normalizeUrl(input: string): string {
  const text = input.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text
  if (/^localhost(:\d+)?(\/|$)/.test(text) || /^[\d.]+(:\d+)?(\/|$)/.test(text))
    return `http://${text}`
  if (/^[^\s]+\.[^\s]{2,}$/.test(text)) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
}
