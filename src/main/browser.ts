import { BrowserWindow, WebContentsView, session, type WebContents } from 'electron'
import type { BrowserState, Rect } from '../shared/types'

/**
 * `persist:` partitions are stored on disk, so cookies, localStorage and
 * IndexedDB (logins) survive restarts. The agent automates this same view,
 * which is how it reuses whatever the user signed into.
 *
 * The page only exists while the panel is open: closing the panel destroys it
 * so it stops using memory and CPU. Logins stay on disk and the last URL is
 * reopened next time.
 */
const PARTITION = 'persist:browser'
const EMPTY_STATE: BrowserState = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false
}

export class BuiltinBrowser {
  private view?: WebContentsView
  private lastUrl = 'about:blank'
  private waitingForBounds: (() => void)[] = []

  constructor(
    private readonly window: BrowserWindow,
    private readonly onState: (state: BrowserState) => void,
    private readonly requestShow: () => void
  ) {
    const browserSession = session.fromPartition(PARTITION)
    // Some sign-in pages (Google in particular) reject user agents that mention Electron.
    browserSession.setUserAgent(
      browserSession
        .getUserAgent()
        .replace(/\sElectron\/\S+/, '')
        .replace(/\sjust-harness\/\S+/, '')
    )
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true }
    })
    const contents = view.webContents
    // OAuth flows open popups and expect window.opener to work, so allow them in the same session.
    contents.setWindowOpenHandler((details) => {
      // Sign-in flows open real popups and rely on window.opener; allow those in
      // the same session. Anything that would open a tab loads here instead, so
      // the page never leaves the panel.
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
      contents.on(event as 'did-stop-loading', () => this.emitState())
    }
    contents.loadURL(this.lastUrl)
    this.view = view
    return view
  }

  get contents(): WebContents {
    return this.ensureView().webContents
  }

  /** Called by the renderer with the panel's rect, or null when the panel is closed. */
  setBounds(rect: Rect | null): void {
    if (!rect) {
      this.destroyView()
      return
    }
    const isNew = !this.view
    const view = this.ensureView()
    if (isNew) this.window.contentView.addChildView(view)
    view.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    })
    for (const resolve of this.waitingForBounds.splice(0)) resolve()
    this.emitState()
  }

  private destroyView(): void {
    const view = this.view
    if (!view) return
    this.view = undefined
    const url = view.webContents.getURL()
    if (url) this.lastUrl = url
    this.window.contentView.removeChildView(view)
    view.webContents.close()
  }

  /** Open the panel if it is closed, so the agent's actions are visible and screenshots render. */
  async ensureVisible(): Promise<void> {
    if (this.view) return
    const shown = new Promise<void>((resolve) => this.waitingForBounds.push(resolve))
    this.requestShow()
    await Promise.race([shown, new Promise((resolve) => setTimeout(resolve, 3000))])
    // If the window could not show the panel (e.g. it is minimized), work off-screen.
    this.ensureView()
  }

  /** Show the panel and open a URL in it. */
  async open(url: string): Promise<void> {
    await this.ensureVisible()
    await this.navigate(url)
  }

  navigate(input: string): Promise<void> {
    return this.contents.loadURL(normalizeUrl(input))
  }

  back(): void {
    if (this.contents.navigationHistory.canGoBack()) this.contents.navigationHistory.goBack()
  }

  forward(): void {
    if (this.contents.navigationHistory.canGoForward()) this.contents.navigationHistory.goForward()
  }

  reload(): void {
    this.contents.reload()
  }

  async clearData(): Promise<void> {
    await session.fromPartition(PARTITION).clearStorageData()
    this.view?.webContents.reload()
  }

  /** Make sure logins written moments ago reach disk before quitting. */
  async flush(): Promise<void> {
    const browserSession = session.fromPartition(PARTITION)
    await browserSession.cookies.flushStore()
    browserSession.flushStorageData()
  }

  /** The current page, without creating one when the panel is closed. */
  state(): BrowserState {
    if (!this.view)
      return { ...EMPTY_STATE, url: this.lastUrl === 'about:blank' ? '' : this.lastUrl }
    const contents = this.view.webContents
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

  private emitState(): void {
    this.onState(this.state())
  }
}

function normalizeUrl(input: string): string {
  const text = input.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text
  if (/^localhost(:\d+)?(\/|$)/.test(text) || /^[\d.]+(:\d+)?(\/|$)/.test(text))
    return `http://${text}`
  if (/^[^\s]+\.[^\s]{2,}$/.test(text)) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
}
