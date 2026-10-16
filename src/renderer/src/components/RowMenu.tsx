import { useEffect, useRef, useState } from 'react'
import { useOverlay } from '../lib/overlays'
import { MoreIcon } from './icons'

export interface RowMenuItem {
  name: string
  danger?: boolean
  onSelect: () => void
}

/**
 * A row's ⋮ button and its menu. The menu is fixed to the window, so the
 * scrolling sidebar cannot clip it; near the bottom it opens upward.
 */
export function RowMenu({
  label,
  items
}: {
  label: string
  items: RowMenuItem[]
}): React.JSX.Element {
  const [at, setAt] = useState<React.CSSProperties>()
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useOverlay(menuRef, Boolean(at))

  useEffect(() => {
    if (!at) return
    const onPointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setAt(undefined)
    }
    // Capture phase, and handled: closing the menu must not also stop the agent.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setAt(undefined)
    }
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [at])

  function toggle(button: HTMLElement): void {
    if (at) return setAt(undefined)
    const rect = button.getBoundingClientRect()
    const right = window.innerWidth - rect.right
    const roomBelow = window.innerHeight - rect.bottom
    setAt(
      roomBelow > MENU_ROOM
        ? { top: rect.bottom + 4, right }
        : { bottom: window.innerHeight - rect.top + 4, right }
    )
  }

  return (
    <div
      className={`row-menu${at ? ' open' : ''}`}
      ref={rootRef}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="icon-btn small"
        title={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        onClick={(e) => toggle(e.currentTarget)}
      >
        <MoreIcon width={14} height={14} />
      </button>
      {at && (
        <div className="menu" role="menu" style={at} ref={menuRef}>
          {items.map((item) => (
            <button
              key={item.name}
              role="menuitem"
              className={item.danger ? 'danger' : undefined}
              autoFocus={item === items[0]}
              onClick={() => {
                setAt(undefined)
                item.onSelect()
              }}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Space a row menu needs below its button to open downward. */
const MENU_ROOM = 120
