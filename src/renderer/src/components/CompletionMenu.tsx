import { useEffect, useRef } from 'react'

export interface CompletionItem {
  name: string
  description: string
  /** Commands and skills are typed as /name, tags as @name. */
  kind: 'command' | 'skill' | 'tag'
}

interface CompletionMenuProps {
  items: CompletionItem[]
  active: number
  onHover: (index: number) => void
  onChoose: (item: CompletionItem) => void
}

export function CompletionMenu({
  items,
  active,
  onHover,
  onChoose
}: CompletionMenuProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div className="slash-menu" ref={listRef} role="listbox">
      {items.length === 0 && <div className="picker-empty">No matches</div>}
      {items.map((item, index) => (
        <button
          type="button"
          key={`${item.kind}:${item.name}`}
          data-index={index}
          role="option"
          aria-selected={index === active}
          className={`slash-item${index === active ? ' active' : ''}`}
          onMouseEnter={() => onHover(index)}
          // Keep focus in the textarea.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChoose(item)}
        >
          <span className="slash-name">
            {item.kind === 'tag' ? '@' : '/'}
            {item.name}
          </span>
          <span className="slash-kind">{item.kind}</span>
          <span className="slash-desc">{item.description}</span>
        </button>
      ))}
    </div>
  )
}
