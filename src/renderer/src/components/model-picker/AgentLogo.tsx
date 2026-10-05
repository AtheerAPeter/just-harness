import type { AgentId } from '../../../../shared/types'
import opencodeLogo from '../../assets/agents/opencode.svg'
import clineLogo from '../../assets/agents/cline.png'
import commandcodeLogo from '../../assets/agents/commandcode.png'

const LOGOS: Record<AgentId, string> = {
  opencode: opencodeLogo,
  cline: clineLogo,
  commandcode: commandcodeLogo,
  'commandcode-api': commandcodeLogo
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
