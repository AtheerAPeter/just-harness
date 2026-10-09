import { CheckIcon } from '../icons'
import type { ModelRow } from './catalog'

/** Models under one heading; a section without a title shows its rows alone. */
export interface ModelSection {
  key: string
  title?: string
  rows: ModelRow[]
}

interface ModelListProps {
  sections: ModelSection[]
  /** Index of the highlighted row, counted across every section. */
  active: number
  emptyText: string
  listRef: React.RefObject<HTMLDivElement | null>
  isCurrent: (row: ModelRow) => boolean
  onHover: (index: number) => void
  onChoose: (row: ModelRow) => void
}

export function ModelList({
  sections,
  active,
  emptyText,
  listRef,
  isCurrent,
  onHover,
  onChoose
}: ModelListProps): React.JSX.Element {
  let index = 0
  return (
    <div className="model-list" ref={listRef}>
      {sections.length === 0 && <div className="picker-empty">{emptyText}</div>}
      {sections.map((section) => (
        <div key={section.key} role="group" aria-label={section.title}>
          {section.title && (
            <div className="model-section-title">
              <span>{section.title}</span>
              <span className="model-count">{section.rows.length}</span>
            </div>
          )}
          {section.rows.map((row) => {
            const i = index++
            return (
              <button
                key={`${row.source.key}:${row.value}`}
                type="button"
                data-index={i}
                role="option"
                aria-selected={isCurrent(row)}
                className={`model-row${i === active ? ' active' : ''}`}
                onMouseEnter={() => onHover(i)}
                onClick={() => onChoose(row)}
              >
                <span className="model-row-text">
                  <span className="model-row-name">{row.name}</span>
                  {row.description && <small>{row.description}</small>}
                </span>
                {isCurrent(row) && <CheckIcon width={14} height={14} />}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
