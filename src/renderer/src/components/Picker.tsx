import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useOverlay } from '../lib/overlays'
import { CheckIcon, UpDownIcon } from './icons'

export interface PickerValue {
  value: string
  name: string
  description?: string
  disabled?: boolean
  /** Values with the same group are listed together under its name. */
  group?: string
}

interface PickerProps {
  value: string
  values: PickerValue[]
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  title?: string
  /** Shown in place of the value when the composer is too narrow for it. */
  icon?: React.ReactNode
}

export function Picker({
  value,
  values,
  onChange,
  placeholder,
  disabled,
  title,
  icon
}: PickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchable = values.length > 8
  const current = values.find((v) => v.value === value)
  useOverlay(menuRef, open)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return values
    return values.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        v.value.toLowerCase().includes(q) ||
        Boolean(v.group?.toLowerCase().includes(q))
    )
  }, [values, query])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open])

  function toggle(): void {
    if (!open) {
      setQuery('')
      setActive(
        Math.max(
          0,
          values.findIndex((v) => v.value === value)
        )
      )
    }
    setOpen(!open)
  }

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  function choose(v: PickerValue | undefined): void {
    if (!v || v.disabled) return
    onChange(v.value)
    setOpen(false)
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') {
      // Handled: closing the list must not also stop the agent.
      event.preventDefault()
      setOpen(false)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => Math.min(filtered.length - 1, i + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(filtered[active])
    }
  }

  return (
    <div className="picker" ref={rootRef} onKeyDown={open ? onKeyDown : undefined}>
      <button
        type="button"
        className="picker-button"
        disabled={disabled}
        // The value stays readable when narrow widths leave only the icon.
        title={title && current ? `${title}: ${current.name}` : title}
        onClick={toggle}
      >
        {icon && <span className="picker-icon">{icon}</span>}
        {/* The group stays on the button: the same model can come from a free and a paid provider. */}
        {current?.group && <span className="picker-group-name">{current.group}</span>}
        <span className="picker-label">{current?.name ?? placeholder ?? value}</span>
        <UpDownIcon width={10} height={10} className="picker-chevron" />
      </button>
      {open && (
        <div className="picker-menu" role="listbox" ref={menuRef}>
          {searchable && (
            <input
              className="picker-search"
              autoFocus
              placeholder="Search…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
            />
          )}
          <div
            className="picker-list"
            ref={listRef}
            tabIndex={searchable ? undefined : -1}
            autoFocus={!searchable}
          >
            {filtered.length === 0 && <div className="picker-empty">No matches</div>}
            {filtered.map((v, index) => (
              <Fragment key={v.value}>
                {v.group && v.group !== filtered[index - 1]?.group && (
                  <div className="picker-group">{v.group}</div>
                )}
                <button
                  type="button"
                  data-index={index}
                  role="option"
                  aria-selected={v.value === value}
                  disabled={v.disabled}
                  className={`picker-item${index === active ? ' active' : ''}${v.value === value ? ' selected' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(v)}
                >
                  <span className="picker-text">
                    <span>{v.name}</span>
                    {v.description && <small>{v.description}</small>}
                  </span>
                  {v.value === value && <CheckIcon width={13} height={13} />}
                </button>
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
