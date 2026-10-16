import { Fragment, useRef, useState } from 'react'
import type { Project } from '../../../shared/types'
import { useOverlay } from '../lib/overlays'
import { ProjectStyle, ProjectTile } from './ProjectIcon'
import { FolderPlusIcon, PencilIcon, SearchIcon, TrashIcon } from './icons'

/**
 * Where a new chat starts: pick its project, by search, arrows and Enter, or
 * ⌘1–9. The last entry opens a folder as a new project and starts the chat there.
 * Each project's row also sets its icon and color, or removes it.
 */
export function ProjectPicker({
  projects,
  onPick,
  onClose
}: {
  projects: Project[]
  onPick: (projectId: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  /** The project whose icon and color are being chosen. */
  const [styling, setStyling] = useState<string>()
  const ref = useRef<HTMLDivElement>(null)
  useOverlay(ref, true)

  const q = query.trim().toLowerCase()
  const shown = projects.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
  )
  // One more entry after the projects: opening a folder.
  const index = Math.min(active, shown.length)

  async function choose(i: number): Promise<void> {
    if (i < shown.length) return onPick(shown[i].id)
    const added = await window.api.addProject()
    if (added) onPick(added.id)
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.defaultPrevented) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : shown.length
      setActive((index + step) % (shown.length + 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(index)
    } else if (e.key === 'Escape') {
      // Handled: closing the picker must not also stop the agent.
      e.preventDefault()
      onClose()
    } else if (e.metaKey && /^[1-9]$/.test(e.key) && Number(e.key) <= shown.length) {
      e.preventDefault()
      choose(Number(e.key) - 1)
    }
  }

  return (
    <div
      className="palette-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="palette" role="dialog" aria-label="New chat in" ref={ref}>
        <label className="palette-search">
          <SearchIcon width={15} height={15} />
          <input
            autoFocus
            placeholder="New chat in…"
            value={query}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
          />
        </label>
        <div className="palette-list">
          <div className="palette-label">Projects</div>
          {shown.map((project, i) => (
            <Fragment key={project.id}>
              <div
                className={`palette-row${i === index ? ' active' : ''}`}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(i)}
              >
                <ProjectTile project={project} size={15} />
                <div className="palette-text">
                  <span className="palette-name">{project.name}</span>
                  <span className="palette-path">{project.path}</span>
                </div>
                <span className="palette-actions">
                  <button
                    className="label-btn"
                    title="Icon and color"
                    onClick={(e) => {
                      e.stopPropagation()
                      setStyling(styling === project.id ? undefined : project.id)
                    }}
                  >
                    <PencilIcon width={12} height={12} />
                    Edit
                  </button>
                  <button
                    className="label-btn danger"
                    title="Remove project"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (
                        confirm(
                          `Remove "${project.name}" and its chats from Just Harness? Files on disk are not touched.`
                        )
                      ) {
                        window.api.removeProject(project.id)
                      }
                    }}
                  >
                    <TrashIcon width={12} height={12} />
                    Remove
                  </button>
                </span>
                {i < 9 && <kbd>⌘{i + 1}</kbd>}
              </div>
              {styling === project.id && (
                <ProjectStyle project={project} onClose={() => setStyling(undefined)} />
              )}
            </Fragment>
          ))}
          <div
            className={`palette-row${index === shown.length ? ' active' : ''}`}
            onMouseMove={() => setActive(shown.length)}
            onClick={() => choose(shown.length)}
          >
            <span className="project-tile">
              <FolderPlusIcon width={15} height={15} />
            </span>
            <div className="palette-text">
              <span className="palette-name">Open a folder…</span>
            </div>
          </div>
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>Enter</kbd> Select
          </span>
          <span>
            <kbd>⌘1–9</kbd> Jump
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </div>
      </div>
    </div>
  )
}
