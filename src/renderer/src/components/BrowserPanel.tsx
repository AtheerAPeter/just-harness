import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BrowserState, BrowserTab } from '../../../shared/types'
import { onOverlays, overlaysCover } from '../lib/overlays'
import {
  BackIcon,
  CloseIcon,
  ForwardIcon,
  GlobeIcon,
  MoreIcon,
  PlusIcon,
  ReloadIcon
} from './icons'

interface BrowserPanelProps {
  width: number
  onResize: (width: number) => void
  onClose: () => void
}

/**
 * The page itself is a native WebContentsView owned by the main process. This
 * component draws the toolbar and reports where the view should sit.
 */
export function BrowserPanel({ width, onResize, onClose }: BrowserPanelProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<BrowserState>()
  /** The text being typed in the address bar; null shows the current page URL. */
  const [draft, setDraft] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  /** A picture of the page, shown in its place while a popup reaches into the panel. */
  const [still, setStill] = useState<string>()
  /** The picture is on screen, so the page can be parked without a gap. */
  const [stillShown, setStillShown] = useState(false)
  const covered = useSyncExternalStore(onOverlays, () =>
    viewportRef.current ? overlaysCover(viewportRef.current) : false
  )

  useEffect(() => {
    window.api.browser.getState().then(setState)
    return window.api.browser.onState(setState)
  }, [])

  // Where the page sits, for as long as the panel is open.
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const report = (): void => {
      const r = el.getBoundingClientRect()
      window.api.browser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      window.api.browser.setBounds(null)
    }
  }, [])

  // The native page is drawn over all HTML, popups included. While one reaches
  // into the panel, a picture of the page takes its place and the page is parked.
  useEffect(() => {
    if (!covered) return
    let current = true
    window.api.browser.capture().then((image) => {
      if (!current) return
      if (image) setStill(image)
      // No page in the panel: nothing to picture, but one that opens meanwhile stays parked.
      else setStillShown(true)
    })
    return () => {
      current = false
      setStill(undefined)
      setStillShown(false)
    }
  }, [covered])

  // Park the page for a popup, and mid-drag, where the native view would swallow
  // pointer events. Parking is not closing: the page stays loaded.
  const parked = dragging || stillShown
  useLayoutEffect(() => {
    if (!parked) return
    window.api.browser.setHidden(true)
    return () => window.api.browser.setHidden(false)
  }, [parked])

  function startDrag(event: React.PointerEvent): void {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    setDragging(true)
    const onMove = (e: PointerEvent): void => {
      const next = startWidth + (startX - e.clientX)
      onResize(Math.min(Math.max(next, 320), window.innerWidth - 480))
    }
    const onUp = (): void => {
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <aside className="browser" style={{ width }}>
      <div className="browser-resize" onPointerDown={startDrag} />
      {/* Tabs on top, as in Chrome, in the panels' shared top row. */}
      <div className="browser-tabs" role="tablist">
        {state?.tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === state.activeTab}
            className={`browser-tab${tab.id === state.activeTab ? ' active' : ''}${tab.controlled ? ' controlled' : ''}`}
            title={
              tab.controlled ? `The agent is working in this tab\n${tab.url}` : tab.url || 'New tab'
            }
            onClick={() => window.api.browser.selectTab(tab.id)}
          >
            <TabIcon tab={tab} />
            <span className="browser-tab-title">{tab.title || tab.url || 'New tab'}</span>
            <button
              className="browser-tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                window.api.browser.closeTab(tab.id)
              }}
            >
              <CloseIcon width={10} height={10} />
            </button>
          </div>
        ))}
        <button
          className="icon-btn small browser-new-tab"
          title="New tab"
          onClick={() => window.api.browser.newTab()}
        >
          <PlusIcon width={14} height={14} />
        </button>
      </div>
      <div className="browser-toolbar">
        <button
          className="icon-btn"
          title="Back"
          disabled={!state?.canGoBack}
          onClick={() => window.api.browser.back()}
        >
          <BackIcon />
        </button>
        <button
          className="icon-btn"
          title="Forward"
          disabled={!state?.canGoForward}
          onClick={() => window.api.browser.forward()}
        >
          <ForwardIcon />
        </button>
        <button className="icon-btn" title="Reload" onClick={() => window.api.browser.reload()}>
          <ReloadIcon className={state?.loading ? 'spin' : undefined} />
        </button>
        <form
          className="address"
          onSubmit={(e) => {
            e.preventDefault()
            if (draft) window.api.browser.navigate(draft)
            e.currentTarget.querySelector('input')?.blur()
          }}
        >
          <input
            value={draft ?? state?.url ?? ''}
            spellCheck={false}
            onFocus={(e) => {
              setDraft(e.currentTarget.value)
              e.currentTarget.select()
            }}
            onBlur={() => setDraft(null)}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search or enter address"
          />
        </form>
        <button
          className="icon-btn"
          title="More"
          aria-haspopup="menu"
          onClick={(e) => {
            // A native menu, opened under the button.
            const r = e.currentTarget.getBoundingClientRect()
            window.api.browser.showMenu(r.left, r.bottom + 4)
          }}
        >
          <MoreIcon />
        </button>
        <button className="icon-btn" title="Close browser (⌘B)" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="browser-viewport" ref={viewportRef}>
        {still && (
          <img
            // A new element per picture, so a load always belongs to the current one.
            key={still}
            className="browser-still"
            src={still}
            alt=""
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget
              // Park the page once the picture has been painted under it.
              requestAnimationFrame(() => {
                if (img.isConnected) setStillShown(true)
              })
            }}
          />
        )}
      </div>
    </aside>
  )
}

/**
 * A tab's icon: a spinner while it loads, then the page's own icon, or a globe
 * for a page without one. The tab the agent works in has a pulsing dot on it.
 */
function TabIcon({ tab }: { tab: BrowserTab }): React.JSX.Element {
  /** The icon address that failed to load, so the globe shows instead. */
  const [failed, setFailed] = useState<string>()
  return (
    <span className="browser-tab-icon">
      {tab.loading ? (
        <span className="spinner" />
      ) : tab.favicon && tab.favicon !== failed ? (
        <img src={tab.favicon} alt="" draggable={false} onError={() => setFailed(tab.favicon)} />
      ) : (
        <GlobeIcon width={14} height={14} />
      )}
      {tab.controlled && <span className="browser-tab-agent" />}
    </span>
  )
}
