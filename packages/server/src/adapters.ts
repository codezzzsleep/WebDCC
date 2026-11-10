import type { AgentAdapter } from '@webdcc/protocol';

/**
 * 生产环境的 adapter 组装点。
 * M1 尚未接入真实 Agent，返回空列表；M3–M5 依次在这里加入 Codex / Claude / DSH adapter。
 */
export async function adapters(): Promise<AgentAdapter[]> {
  const list: AgentAdapter[] = [];
  if (process.env['WDCC_ENABLE_CODEX'] !== '0') {
    const { CodexAdapter } = await import('@webdcc/adapter-codex');
    list.push(new CodexAdapter());
  }
  if (process.env['WDCC_ENABLE_CLAUDE'] !== '0') {
    const { ClaudeAdapter } = await import('@webdcc/adapter-claude');
    list.push(new ClaudeAdapter());
  }
  return list;
}
