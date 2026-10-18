import { useEffect, useRef, useState } from 'react'
import type { AgentOption } from '../../../shared/types'
import { useOverlay } from '../lib/overlays'
import { menuPlacement, placementProps, type MenuPlacement } from '../lib/menuPlacement'
import { ChevronDownIcon, GaugeIcon } from './icons'

/** The value agents use for the model's own effort; opencode lists it last, the harness first. */
const DEFAULT = 'default'

/** Keys that move the slider, and where each takes it from stop `i` of `last`. */
const STEP_KEYS: Record<string, (i: number, last: number) => number> = {
  ArrowRight: (i) => i + 1,
  ArrowUp: (i) => i + 1,
  PageUp: (i) => i + 1,
  ArrowLeft: (i) => i - 1,
  ArrowDown: (i) => i - 1,
  PageDown: (i) => i - 1,
  Home: () => 0,
  End: (_, last) => last
}

/**
 * The thinking effort as ChatGPT's slider: the level's name over a track with
 * a stop per level. Default (the model's own effort) is the first stop, then
 * the levels in the agent's order, which is lowest first.
 *
 * An invisible range input on top takes the pointer, keys and screen readers;
 * the track, fill and thumb under it are drawn, so they can glide between stops.
 */
export function EffortPicker({
  option,
  onChange
}: {
  option: AgentOption
  onChange: (value: string) => void
}): React.JSX.Element {
  const stops = [
    ...option.values.filter((v) => v.value === DEFAULT),
    ...option.values.filter((v) => v.value !== DEFAULT)
  ]
  const last = stops.length - 1
  const currentIndex = Math.max(
    0,
    stops.findIndex((v) => v.value === option.currentValue)
  )
  const [placement, setPlacement] = useState<MenuPlacement>()
  /** The stop shown while the menu is open; the agent's answer to a change comes later. */
  const [index, setIndex] = useState(currentIndex)
  /** Where the thumb is while it is dragged, between stops; it settles on the nearest at release. */
  const [drag, setDrag] = useState<number | null>(null)
  /** Whether the pointer is pressed on the slider: only then do its changes count as a drag. */
  const pressed = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const open = placement !== undefined
  useOverlay(menuRef, open)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setPlacement(undefined)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open])

  function toggle(): void {
    if (open || !rootRef.current) return setPlacement(undefined)
    setIndex(currentIndex)
    setDrag(null)
    setPlacement(menuPlacement(rootRef.current))
  }

  function choose(next: number): void {
    const clamped = Math.min(last, Math.max(0, next))
    if (clamped === index) return
    setIndex(clamped)
    onChange(stops[clamped].value)
  }

  function press(): void {
    pressed.current = true
    // A drag can end anywhere in the window, not only over the slider.
    const release = (): void => {
      pressed.current = false
      setDrag(null)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key !== 'Escape' && event.key !== 'Enter') return
    // Handled: closing the menu must not also stop the agent.
    event.preventDefault()
    setPlacement(undefined)
  }

  const position = drag ?? index

  return (
    <div className="picker" ref={rootRef} onKeyDown={open ? onKeyDown : undefined}>
      <button
        type="button"
        className="picker-button"
        title={`Thinking effort: ${stops[currentIndex]?.name ?? option.currentValue}`}
        onClick={toggle}
      >
        <span className="picker-icon">
          <GaugeIcon width={15} height={15} />
        </span>
        <span className="picker-label">Thinking effort</span>
        <ChevronDownIcon width={12} height={12} className="picker-chevron" />
      </button>
      {placement && (
        <div className="picker-menu effort-menu" ref={menuRef} {...placementProps(placement)}>
          <div className="effort-name">{stops[index]?.name}</div>
          <div
            className={`effort-slider${drag !== null ? ' dragging' : ''}`}
            style={{ '--effort': last > 0 ? position / last : 0 } as React.CSSProperties}
          >
            <span className="effort-fill" />
            {stops.map((stop, i) => (
              <span
                key={stop.value}
                className={`effort-stop${i <= position ? ' passed' : ''}`}
                style={{ '--at': last > 0 ? i / last : 0 } as React.CSSProperties}
              />
            ))}
            <span className="effort-thumb" />
            <input
              type="range"
              aria-label="Thinking effort"
              aria-valuetext={stops[index]?.name}
              autoFocus
              min={0}
              max={last}
              step="any"
              value={position}
              onPointerDown={press}
              onChange={(e) => {
                const at = Number(e.target.value)
                if (pressed.current) setDrag(at)
                choose(Math.round(at))
              }}
              onKeyDown={(e) => {
                const step = STEP_KEYS[e.key]
                if (!step) return
                // One stop per key: a free range would move a hundredth of the track.
                e.preventDefault()
                choose(step(index, last))
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
