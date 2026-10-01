import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserState } from '../../../shared/types'
import { BackIcon, CloseIcon, ForwardIcon, PlusIcon, ReloadIcon, TrashIcon } from './icons'

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

  useEffect(() => {
    window.api.browser.getState().then(setState)
    return window.api.browser.onState(setState)
  }, [])

  useLayoutEffect(() => {
    const el = viewportRef.current
    // The native view would swallow pointer events mid-drag, so hide it until the drag ends.
    if (!el || dragging) return
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
  }, [dragging])

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
        <button className="icon-btn" title="New tab" onClick={() => window.api.browser.newTab()}>
          <PlusIcon />
        </button>
        <button
          className="icon-btn"
          title="Sign out everywhere (clear cookies and site data)"
          onClick={() => {
            if (
              confirm(
                'Clear all cookies and site data in the built-in browser? You will be signed out of every site.'
              )
            ) {
              window.api.browser.clearData()
            }
          }}
        >
          <TrashIcon />
        </button>
        <button className="icon-btn" title="Close browser (⌘B)" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {state && state.tabs.length > 1 && (
        <div className="browser-tabs" role="tablist">
          {state.tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === state.activeTab}
              className={`browser-tab${tab.id === state.activeTab ? ' active' : ''}`}
              title={tab.url || 'New tab'}
              onClick={() => window.api.browser.selectTab(tab.id)}
            >
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
        </div>
      )}
      <div className="browser-viewport" ref={viewportRef} />
    </aside>
  )
}
