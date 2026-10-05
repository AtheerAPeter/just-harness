import { useEffect, useRef, useState } from 'react'
import {
  AGENTS,
  modelOptions,
  type AgentId,
  type AgentModels,
  type AgentOption,
  type AgentStatus,
  type ModelSource
} from '../../../../shared/types'
import { SearchIcon, UpDownIcon } from '../icons'
import { AgentLogo } from './AgentLogo'
import { groupsOf, matches, settingOf, sourceKey, type ModelRow, type Source } from './catalog'
import { ModelColumn, type ModelSection } from './ModelColumn'
import { ProviderColumn } from './ProviderColumn'
import { SourceColumn } from './SourceColumn'

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

/**
 * Picks the agent and its model in one menu, in three columns: where the models
 * come from (an agent, or one of its providers), the providers within that, and
 * the models. A search looks through every model of every agent.
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
  /** The provider the model list is narrowed to; undefined shows them all. */
  const [shownProvider, setShownProvider] = useState<string>()
  /** Every agent's model lists, read when the picker opens. */
  const [lists, setLists] = useState<Partial<Record<AgentId, AgentModels>>>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const live = modelOptions(options ?? [])
  const label = (id: AgentId): string => AGENTS.find((a) => a.id === id)?.label ?? id
  const disabledReason = (id: AgentId): string | undefined => {
    if (statuses[id]?.available === false) return `${label(id)} is not installed`
    if (agentFixed && id !== agent) return 'The agent is fixed once a chat has started'
    return undefined
  }
  const currentKey = sourceKey(agent, live.source?.currentValue)

  function sourcesOf(id: AgentId): Source[] {
    const listed = lists[id]
    const found: ModelSource[] = listed?.sources.length
      ? listed.sources
      : id === agent && live.model
        ? [{ option: live.model, setting: settingOf(live.source) }]
        : []
    if (found.length === 0) return [{ key: sourceKey(id), agent: id, error: listed?.error }]
    return found.map((source) => {
      const key = sourceKey(id, source.setting?.value)
      // The chat's own list is the live one: it knows the current model.
      const option = key === currentKey && live.model ? live.model : source.option
      return { ...source, option, key, agent: id }
    })
  }

  const sources = AGENTS.flatMap((a) => sourcesOf(a.id))
  const shown = sources.find((s) => s.key === (shownKey ?? currentKey)) ?? sources[0]
  const groups = groupsOf(shown)
  const isCurrent = (row: ModelRow): boolean =>
    row.source.key === currentKey && row.value === live.model?.currentValue
  const currentSource = sources.find((s) => s.key === currentKey)
  const current =
    currentSource &&
    groupsOf(currentSource)
      .flatMap((g) => g.rows)
      .find(isCurrent)

  const sourceName = (source: Source): string =>
    [label(source.agent), source.setting?.name].filter(Boolean).join(' · ')

  const q = query.trim().toLowerCase()
  const sections: ModelSection[] = q
    ? sources
        .filter((s) => !disabledReason(s.agent))
        .flatMap((s) =>
          groupsOf(s).map((g) => ({
            key: `${s.key}/${g.provider}`,
            title: [sourceName(s), g.provider].filter(Boolean).join(' · '),
            rows: g.rows.filter((r) => matches(r, q))
          }))
        )
        .filter((section) => section.rows.length > 0)
    : groups
        .filter((g) => shownProvider === undefined || g.provider === shownProvider)
        .map((g) => ({
          key: g.provider,
          // One unnamed group needs no heading.
          title: g.provider || (groups.length > 1 ? 'Other' : undefined),
          rows: g.rows
        }))
  const rows = sections.flatMap((s) => s.rows)

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
  }, [shownKey, shownProvider, q])

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
    setShownProvider(undefined)
    setActive(
      Math.max(
        0,
        currentSource
          ? groupsOf(currentSource)
              .flatMap((g) => g.rows)
              .findIndex(isCurrent)
          : 0
      )
    )
    setOpen(true)
    // Agents cache their lists, so asking on every open is cheap after the first.
    for (const { id } of AGENTS) {
      if (disabledReason(id)) continue
      window.api.agentModels(id, projectId).then((models) => {
        setLists((loaded) => ({ ...loaded, [id]: models }))
      })
    }
  }

  function showSource(source: Source): void {
    setShownKey(source.key)
    setShownProvider(undefined)
    setQuery('')
    setActive(0)
    searchRef.current?.focus()
  }

  function showProvider(provider: string | undefined): void {
    setShownProvider(provider)
    setActive(0)
    searchRef.current?.focus()
  }

  function choose(row: ModelRow | undefined): void {
    if (!row) return
    const { setting } = row.source
    onChange(row.source.agent, [
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
        title={currentSource ? sourceName(currentSource) : label(agent)}
        onClick={toggle}
      >
        <AgentLogo agent={agent} />
        {/* The provider stays on the button: the same model can come from a free and a paid one. */}
        {current?.provider && <span className="picker-group-name">{current.provider}</span>}
        <span className="picker-label">{current?.name ?? label(agent)}</span>
        <UpDownIcon width={10} height={10} />
      </button>
      {open && (
        <div className="picker-menu model-menu" role="listbox">
          <label className="model-search">
            <SearchIcon width={15} height={15} />
            <input
              ref={searchRef}
              autoFocus
              placeholder="Search all models…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
            />
          </label>
          <div className="model-body">
            <SourceColumn
              sources={sources}
              shownKey={q ? undefined : shown.key}
              currentKey={currentKey}
              disabledReason={disabledReason}
              onShow={showSource}
            />
            {!q && groups.length > 1 && (
              <ProviderColumn
                title={shown.setting ? `Via ${shown.setting.name}` : 'Providers'}
                groups={groups}
                shown={shownProvider}
                current={shown.key === currentKey ? current?.provider : undefined}
                onShow={showProvider}
              />
            )}
            <ModelColumn
              sections={sections}
              active={active}
              emptyText={emptyText()}
              listRef={listRef}
              isCurrent={isCurrent}
              onHover={setActive}
              onChoose={choose}
            />
          </div>
        </div>
      )}
    </div>
  )
}
