import type { ProviderGroup } from './catalog'

interface ProviderColumnProps {
  /**
   * What the groups sit under. For opencode a group is the provider that serves and
   * bills the model; within one of cline's providers every group is billed by it.
   */
  title: string
  groups: ProviderGroup[]
  /** The provider shown; undefined shows them all. */
  shown?: string
  /** The provider of the chat's model, when it is in this source. */
  current?: string
  onShow: (provider: string | undefined) => void
}

/** The providers within a source, to narrow its models to one. */
export function ProviderColumn({
  title,
  groups,
  shown,
  current,
  onShow
}: ProviderColumnProps): React.JSX.Element {
  const total = groups.reduce((n, g) => n + g.rows.length, 0)
  const item = (provider: string | undefined, text: string, count: number): React.JSX.Element => (
    <button
      key={provider ?? ''}
      type="button"
      className={`model-source-item${provider === shown ? ' active' : ''}`}
      title={text}
      onClick={() => onShow(provider)}
    >
      <span className="model-source-name">{text}</span>
      {provider !== undefined && provider === current && <span className="model-current-dot" />}
      <span className="model-count">{count}</span>
    </button>
  )
  return (
    <div className="model-column model-providers">
      <div className="model-column-title" title={title}>
        {title}
      </div>
      {item(undefined, 'All models', total)}
      {groups.map((g) => item(g.provider, g.provider || 'Other', g.rows.length))}
    </div>
  )
}
