import { useEffect, useRef, useState } from 'react'
import {
  AGENTS,
  modelOptions,
  type AgentId,
  type AgentModels,
  type AgentOption,
  type AgentStatus,
  type ModelSource
} from '../../../shared/types'
import { CheckIcon, SearchIcon, UpDownIcon } from './icons'
import opencodeLogo from '../assets/agents/opencode.svg'
import clineLogo from '../assets/agents/cline.png'
import commandcodeLogo from '../assets/agents/commandcode.png'

const LOGOS: Record<AgentId, string> = {
  opencode: opencodeLogo,
  cline: clineLogo,
  commandcode: commandcodeLogo
}

export function AgentLogo({
  agent,
  size = 16
}: {
  agent: AgentId
  size?: number
}): React.JSX.Element {
  return <img className="agent-logo" src={LOGOS[agent]} width={size} height={size} alt="" />
}

interface ModelPickerProps {
  agent: AgentId
  projectId: string
  statuses: Partial<Record<AgentId, AgentStatus>>
  /** The chat's live session options; undefined while its session starts. */
  options?: AgentOption[]
  /** Once a chat has started, only its own agent's models can be picked. */
  agentFixed: boolean
  /** The settings that pick the model, in the order to apply them (provider first). */
  onChange: (agent: AgentId, settings: [optionId: string, value: string][]) => void
}

/** One entry on the rail: an agent, or one of its providers when it has several. */
interface RailEntry extends Partial<ModelSource> {
  key: string
  agent: AgentId
  error?: string
}

interface ModelRow {
  entry: RailEntry
  option: AgentOption
  value: string
  name: string
  /** The provider the agent reaches the model through, when the name says. */
  group?: string
  description?: string
}

/**
 * Picks the agent and its model in one list: agents on a rail (one entry per
 * provider for agents whose models depend on it), the models of the one selected
 * beside it. A search looks through every model on the rail.
 */
export function ModelPicker({
  agent,
  projectId,
  statuses,
  options,
  agentFixed,
  onChange
}: ModelPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [shownKey, setShownKey] = useState<string>()
  /** Every agent's model lists, read when the picker opens. */
  const [lists, setLists] = useState<Partial<Record<AgentId, AgentModels>>>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const live = modelOptions(options ?? [])
  const label = (id: AgentId): string => AGENTS.find((a) => a.id === id)?.label ?? id
  const pickable = (id: AgentId): boolean =>
    statuses[id]?.available !== false && (!agentFixed || id === agent)
  const keyOf = (id: AgentId, settingValue?: string): string => `${id}:${settingValue ?? ''}`
  const currentKey = keyOf(agent, live.source?.currentValue)

  function entriesOf(id: AgentId): RailEntry[] {
    const listed = lists[id]
    const sources: ModelSource[] = listed?.sources.length
      ? listed.sources
      : id === agent && live.model
        ? [{ option: live.model, setting: settingOf(live.source) }]
        : []
    if (sources.length === 0) return [{ key: keyOf(id), agent: id, error: listed?.error }]
    return sources.map((source) => {
      const key = keyOf(id, source.setting?.value)
      // The chat's own list is the live one: it knows the current model.
      const option = key === currentKey && live.model ? live.model : source.option
      return { ...source, option, key, agent: id }
    })
  }

  const rail = AGENTS.flatMap((a) => entriesOf(a.id))
  const shown = rail.find((e) => e.key === (shownKey ?? currentKey)) ?? rail[0]

  const rowsOf = (entry: RailEntry): ModelRow[] =>
    entry.option
      ? byProvider(entry.option.values).map((v) => ({ entry, option: entry.option!, ...v }))
      : []

  const q = query.trim().toLowerCase()
  const rows = q
    ? rail
        .filter((e) => pickable(e.agent))
        .flatMap(rowsOf)
        .filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.value.toLowerCase().includes(q) ||
            Boolean(r.group?.toLowerCase().includes(q)) ||
            Boolean(r.entry.setting?.name.toLowerCase().includes(q))
        )
    : rowsOf(shown)
  const isCurrent = (row: ModelRow): boolean =>
    row.entry.key === currentKey && row.value === live.model?.currentValue
  const currentEntry = rail.find((e) => e.key === currentKey)
  const current = currentEntry && rowsOf(currentEntry).find(isCurrent)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open])

  // A different list starts at its top, not where the previous one was scrolled to.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [shownKey, q])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  function toggle(): void {
    if (open) {
      setOpen(false)
      return
    }
    setQuery('')
    setShownKey(currentKey)
    setActive(Math.max(0, currentEntry ? rowsOf(currentEntry).findIndex(isCurrent) : 0))
    setOpen(true)
    // Agents cache their lists, so asking on every open is cheap after the first.
    for (const { id } of AGENTS) {
      if (!pickable(id)) continue
      window.api.agentModels(id, projectId).then((models) => {
        setLists((loaded) => ({ ...loaded, [id]: models }))
      })
    }
  }

  function showEntry(entry: RailEntry): void {
    setShownKey(entry.key)
    setQuery('')
    setActive(0)
    searchRef.current?.focus()
  }

  function choose(row: ModelRow | undefined): void {
    if (!row) return
    const { setting } = row.entry
    onChange(row.entry.agent, [
      ...(setting ? [[setting.optionId, setting.value] as [string, string]] : []),
      [row.option.id, row.value]
    ])
    setOpen(false)
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') {
      // Handled: closing the list must not also stop the agent.
      event.preventDefault()
      setOpen(false)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => Math.min(rows.length - 1, i + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(rows[active])
    }
  }

  const entryName = (entry: RailEntry): string =>
    [label(entry.agent), entry.setting?.name].filter(Boolean).join(' · ')

  function railTitle(entry: RailEntry): string {
    if (statuses[entry.agent]?.available === false) return `${label(entry.agent)}: not installed`
    if (agentFixed && entry.agent !== agent) {
      return `${label(entry.agent)}: the agent is fixed once a chat has started`
    }
    const version = statuses[entry.agent]?.version
    return version ? `${entryName(entry)} (${version})` : entryName(entry)
  }

  function emptyText(): string {
    if (q) return 'No matches'
    if (shown.error) return shown.error
    if (!shown.option && !lists[shown.agent]) {
      return shown.agent === agent && !options ? 'Starting agent…' : 'Loading models…'
    }
    return `${label(shown.agent)} offers no model choice`
  }

  return (
    <div className="picker" ref={rootRef} onKeyDown={open ? onKeyDown : undefined}>
      <button
        type="button"
        className="picker-button"
        title={currentEntry ? entryName(currentEntry) : label(agent)}
        onClick={toggle}
      >
        <AgentLogo agent={agent} />
        {/* The group stays on the button: the same model can come from a free and a paid provider. */}
        {current?.group && <span className="picker-group-name">{current.group}</span>}
        <span className="picker-label">{current?.name ?? label(agent)}</span>
        <UpDownIcon width={10} height={10} />
      </button>
      {open && (
        <div className="picker-menu model-menu" role="listbox">
          <div className="model-rail">
            {rail.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={`model-rail-item${entry.key === shown.key && !q ? ' active' : ''}`}
                disabled={!pickable(entry.agent)}
                title={railTitle(entry)}
                onClick={() => showEntry(entry)}
              >
                <AgentLogo agent={entry.agent} size={20} />
                {entry.setting && (
                  <span className="model-rail-badge">{initials(entry.setting.name)}</span>
                )}
              </button>
            ))}
          </div>
          <div className="model-main">
            <label className="model-search">
              <SearchIcon width={14} height={14} />
              <input
                ref={searchRef}
                autoFocus
                placeholder="Search models…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActive(0)
                }}
              />
            </label>
            {!q && shown.setting && <div className="model-heading">{entryName(shown)}</div>}
            <div className="picker-list" ref={listRef}>
              {rows.length === 0 && <div className="picker-empty">{emptyText()}</div>}
              {rows.map((row, index) => (
                <button
                  key={`${row.entry.key}:${row.value}`}
                  type="button"
                  data-index={index}
                  role="option"
                  aria-selected={isCurrent(row)}
                  className={`picker-item${index === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(row)}
                >
                  <span className="picker-text">
                    <span>{row.name}</span>
                    {/* Search results mix agents, so they say where each model comes from. */}
                    {(q || row.group || row.description) && (
                      <small className="model-source">
                        {q && <AgentLogo agent={row.entry.agent} size={11} />}
                        <span>
                          {[q && entryName(row.entry), row.group, row.description]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </small>
                    )}
                  </span>
                  {isCurrent(row) && <CheckIcon width={13} height={13} />}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** The source setting the chat is on, from its live source option. */
function settingOf(source: AgentOption | undefined): ModelSource['setting'] {
  if (!source) return undefined
  const value = source.values.find((v) => v.value === source.currentValue)
  return {
    optionId: source.id,
    value: source.currentValue,
    name: value?.name ?? source.currentValue
  }
}

/** A short tag telling an agent's providers apart on the rail: "ClinePass" -> "C", "OpenAI ChatGPT" -> "OC". */
function initials(name: string): string {
  return name
    .split(/[\s-]+/)
    .filter((word) => /^[A-Za-z]/.test(word))
    .map((word) => word[0].toUpperCase())
    .slice(0, 2)
    .join('')
}

/**
 * Model names arrive as "provider/model" (sometimes "provider/provider/model").
 * Each row shows the model's own name and keeps the provider as its group.
 */
function byProvider(
  values: AgentOption['values']
): Pick<ModelRow, 'value' | 'name' | 'group' | 'description'>[] {
  // Providers keep the order they first appear in; each gathers its models.
  const groups = new Map<string, Pick<ModelRow, 'value' | 'name' | 'group' | 'description'>[]>()
  for (const v of values) {
    const parts = v.name.split('/')
    const group = parts.length > 1 ? parts[0] : ''
    const item = parts.length > 1 ? { ...v, group, name: parts[parts.length - 1] } : v
    groups.set(group, [...(groups.get(group) ?? []), item])
  }
  return [...groups.values()].flat()
}
