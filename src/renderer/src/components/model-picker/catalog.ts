import type { AgentId, AgentOption, ModelSource } from '../../../../shared/types'

/** Where a list of models comes from: an agent, or one of its providers when it has several (cline). */
export interface Source extends Partial<ModelSource> {
  key: string
  agent: AgentId
  error?: string
}

export interface ModelRow {
  source: Source
  option: AgentOption
  value: string
  name: string
  /** Who serves or makes the model, from its name or id; empty when neither says. */
  provider: string
  description?: string
}

/** The models of one provider within a source. */
export interface ProviderGroup {
  provider: string
  rows: ModelRow[]
}

export const sourceKey = (agent: AgentId, settingValue?: string): string =>
  `${agent}:${settingValue ?? ''}`

/** The source setting a chat is on, from its live source option. */
export function settingOf(option: AgentOption | undefined): ModelSource['setting'] {
  if (!option) return undefined
  const value = option.values.find((v) => v.value === option.currentValue)
  return {
    optionId: option.id,
    value: option.currentValue,
    name: value?.name ?? option.currentValue
  }
}

/**
 * Opencode names its models "provider/model" (sometimes "provider/provider/model");
 * cline keeps the name plain and puts the provider in the id ("openai/gpt-6.1-sol").
 * Each row shows the model's own name and keeps the provider apart.
 */
function rowOf(source: Source, option: AgentOption, v: AgentOption['values'][number]): ModelRow {
  const named = v.name.split('/')
  const provider = named.length > 1 ? named[0] : v.value.includes('/') ? v.value.split('/')[0] : ''
  return {
    source,
    option,
    value: v.value,
    name: named[named.length - 1],
    provider,
    description: v.description
  }
}

/** A source's models by provider, providers in alphabetical order. */
export function groupsOf(source: Source): ProviderGroup[] {
  const { option } = source
  if (!option) return []
  const groups = new Map<string, ModelRow[]>()
  for (const v of option.values) {
    const row = rowOf(source, option, v)
    groups.set(row.provider, [...(groups.get(row.provider) ?? []), row])
  }
  return [...groups]
    .map(([provider, rows]) => ({ provider, rows }))
    .sort((a, b) => a.provider.localeCompare(b.provider))
}

/** Whether a model of the shown source matches the search. */
export function matches(row: ModelRow, query: string): boolean {
  return [row.name, row.value, row.provider].some((text) => text.toLowerCase().includes(query))
}

/** Whether a source in the list of agents and providers matches the search, by its agent or its own name. */
export function sourceMatches(source: Source, agentLabel: string, query: string): boolean {
  return [agentLabel, source.setting?.name].some((text) => text?.toLowerCase().includes(query))
}
