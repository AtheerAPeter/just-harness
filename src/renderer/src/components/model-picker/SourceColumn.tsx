import { AGENTS, type AgentId } from '../../../../shared/types'
import { AgentLogo } from './AgentLogo'
import type { Source } from './catalog'

interface SourceColumnProps {
  sources: Source[]
  /** The source whose models are shown; none while searching. */
  shownKey?: string
  /** The source the chat's model comes from. */
  currentKey: string
  disabledReason: (agent: AgentId) => string | undefined
  onShow: (source: Source) => void
}

/**
 * Agents, each with its sources beneath it when it has several (cline's
 * ClinePass, Usage-Billing, ChatGPT Subscription).
 */
export function SourceColumn({
  sources,
  shownKey,
  currentKey,
  disabledReason,
  onShow
}: SourceColumnProps): React.JSX.Element {
  return (
    <div className="model-column model-sources">
      {AGENTS.map(({ id, label }) => {
        const own = sources.filter((s) => s.agent === id)
        const reason = disabledReason(id)
        const item = (source: Source, text: string, nested: boolean): React.JSX.Element => (
          <button
            key={source.key}
            type="button"
            className={`model-source-item${nested ? ' nested' : ''}${source.key === shownKey ? ' active' : ''}`}
            disabled={Boolean(reason)}
            title={reason ?? text}
            onClick={() => onShow(source)}
          >
            {!nested && <AgentLogo agent={id} size={18} />}
            <span className="model-source-name">{text}</span>
            {source.key === currentKey && <span className="model-current-dot" />}
            {source.option && <span className="model-count">{source.option.values.length}</span>}
          </button>
        )
        if (own.length === 1 && !own[0].setting) return item(own[0], label, false)
        return (
          <div key={id} className="model-agent-group">
            <div className={`model-agent-name${reason ? ' disabled' : ''}`} title={reason}>
              <AgentLogo agent={id} size={18} />
              <span>{label}</span>
            </div>
            {own.map((source) => item(source, source.setting?.name ?? label, true))}
          </div>
        )
      })}
    </div>
  )
}
