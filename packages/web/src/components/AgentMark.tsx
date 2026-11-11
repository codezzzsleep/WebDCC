import { agentText } from '../lib/agents.js';

/** Agent 的小标记：单色，靠字母区分，不靠颜色 */
export function AgentMark({ agent, strong = false, size = 'sm' }: { agent: string; strong?: boolean; size?: 'sm' | 'md' }): React.ReactElement {
  const info = agentText(agent);
  return (
    <span className={`agent-mark ${strong ? 'strong' : ''} ${size}`} title={info.name} aria-hidden="true">
      {info.mark}
    </span>
  );
}
