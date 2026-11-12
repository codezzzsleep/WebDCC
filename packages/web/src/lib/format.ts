export function relativeTime(iso: string | undefined): string {
  if (iso === undefined) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 30) return `${days}天`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}分${seconds % 60}秒`;
}

export function shortNumber(value: number | undefined): string {
  if (value === undefined) return '0';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export const AGENT_LABEL: Record<string, { mark: string; name: string; className: string }> = {
  dsh: { mark: 'DS', name: 'DeepSeek Harness', className: 'agent-dsh' },
  codex: { mark: 'CX', name: 'Codex', className: 'agent-codex' },
  'claude-code': { mark: 'CC', name: 'Claude Code', className: 'agent-claude' },
};

export function agentInfo(agent: string): { mark: string; name: string; className: string } {
  return AGENT_LABEL[agent] ?? { mark: '??', name: agent, className: 'agent-codex' };
}
