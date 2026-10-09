import { AGENTS, type AgentId } from '../../../../shared/types'
import { ForwardIcon } from '../icons'
import { AgentLogo } from './AgentLogo'
import type { Source } from './catalog'

interface SourceListProps {
  sources: Source[]
  /** Index of the highlighted source, counted across the ones that can be picked. */
  active: number
  /** The source the chat's model comes from. */
  currentKey: string
  disabledReason: (agent: AgentId) => string | undefined
  listRef: React.RefObject<HTMLDivElement | null>
  onHover: (index: number) => void
  onShow: (source: Source) => void
}

/**
 * Agents, each with its sources beneath it when it has several (cline's
 * ClinePass, Usage-Billing, ChatGPT Subscription). Picking one shows its models.
 */
export function SourceList({
  sources,
  active,
  currentKey,
  disabledReason,
  listRef,
  onHover,
  onShow
}: SourceListProps): React.JSX.Element {
  let index = 0
  return (
    <div className="model-list" ref={listRef}>
      {AGENTS.map(({ id, label }) => {
        const own = sources.filter((s) => s.agent === id)
        const reason = disabledReason(id)
        const item = (source: Source, text: string, nested: boolean): React.JSX.Element => {
          const i = reason ? undefined : index++
          return (
            <button
              key={source.key}
              type="button"
              data-index={i}
              className={`model-source-item${nested ? ' nested' : ''}${i === active ? ' active' : ''}`}
              disabled={Boolean(reason)}
              title={reason ?? text}
              onMouseEnter={i === undefined ? undefined : () => onHover(i)}
              onClick={() => onShow(source)}
            >
              {!nested && <AgentLogo agent={id} size={18} />}
              <span className="model-source-name">{text}</span>
              {source.key === currentKey && <span className="model-current-dot" />}
              {source.option && <span className="model-count">{source.option.values.length}</span>}
              <ForwardIcon width={14} height={14} className="model-source-chevron" />
            </button>
          )
        }
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
