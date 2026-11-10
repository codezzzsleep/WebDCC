import type { AgentAdapter } from '@webdcc/protocol';

/**
 * 生产环境的 adapter 组装点。
 * M1 尚未接入真实 Agent，返回空列表；M3–M5 依次在这里加入 Codex / Claude / DSH adapter。
 */
export async function adapters(): Promise<AgentAdapter[]> {
  return [];
}
