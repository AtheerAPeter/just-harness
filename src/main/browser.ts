import { BrowserWindow, WebContentsView, session, type WebContents } from 'electron'
import type { BrowserState, Rect } from '../shared/types'

/**
 * `persist:` partitions are stored on disk, so cookies, localStorage and
 * IndexedDB (logins) survive restarts. The agent automates this same view,
 * which is how it reuses whatever the user signed into.
 */
const PARTITION = 'persist:browser'
const HOME_URL = 'https://www.google.com'

export class BuiltinBrowser {
  private view?: WebContentsView
  private visible = false
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
    contents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520,
        height: 720,
        webPreferences: { partition: PARTITION }
      }
    }))
    for (const event of [
      'did-navigate',
      'did-navigate-in-page',
      'page-title-updated',
      'did-start-loading',
      'did-stop-loading'
    ] as const) {
      contents.on(event as 'did-stop-loading', () => this.emitState())
    }
    contents.loadURL(HOME_URL)
    this.view = view
    return view
  }

  get contents(): WebContents {
    return this.ensureView().webContents
  }

  /** Called by the renderer with the panel's rect, or null when the panel is closed. */
  setBounds(rect: Rect | null): void {
    const view = this.ensureView()
    if (!rect) {
      if (this.visible) this.window.contentView.removeChildView(view)
      this.visible = false
      return
    }
    if (!this.visible) this.window.contentView.addChildView(view)
    this.visible = true
    view.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    })
    for (const resolve of this.waitingForBounds.splice(0)) resolve()
    this.emitState()
  }

  /** Open the panel if it is closed, so the agent's actions are visible and screenshots render. */
  async ensureVisible(): Promise<void> {
    this.ensureView()
    if (this.visible) return
    const shown = new Promise<void>((resolve) => this.waitingForBounds.push(resolve))
    this.requestShow()
    await Promise.race([shown, new Promise((resolve) => setTimeout(resolve, 3000))])
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
    this.contents.reload()
  }

  /** Make sure logins written moments ago reach disk before quitting. */
  async flush(): Promise<void> {
    const browserSession = session.fromPartition(PARTITION)
    await browserSession.cookies.flushStore()
    browserSession.flushStorageData()
  }

  state(): BrowserState {
    const contents = this.contents
    return {
      url: contents.getURL(),
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
