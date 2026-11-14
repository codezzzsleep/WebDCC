import type { AgentAdapter, TraceSink } from '@webdcc/protocol';

/**
 * 生产环境的 adapter 组装点。
 * M1 尚未接入真实 Agent，返回空列表；M3–M5 依次在这里加入 Codex / Claude / DSH adapter。
 */
export interface AdapterSettings {
  dsh?: { mode: 'attach' | 'spawn'; url?: string; cookie?: string; browserCookie?: string };
  traceSink?: (sessionId: string) => TraceSink;
  nativeRecorder?: { directory: string; module: string; env?: Record<string, string> };
}

export async function adapters(settings: AdapterSettings = {}): Promise<AgentAdapter[]> {
  const list: AgentAdapter[] = [];
  if (process.env['WDCC_ENABLE_CODEX'] !== '0') {
    const { CodexAdapter } = await import('@webdcc/adapter-codex');
    list.push(new CodexAdapter());
  }
  if (process.env['WDCC_ENABLE_CLAUDE'] !== '0') {
    const { ClaudeAdapter } = await import('@webdcc/adapter-claude');
    list.push(new ClaudeAdapter());
  }
  if (process.env['WDCC_ENABLE_DSH'] !== '0') {
    const { DshAdapter } = await import('@webdcc/adapter-dsh');
    const mode = settings.dsh?.mode ?? (process.env['WDCC_DSH_MODE'] === 'attach' ? 'attach' : 'spawn');
    list.push(
      new DshAdapter({
        traceSinkFactory: settings.traceSink,
        nativeRecorder: settings.nativeRecorder,
        mode,
        ...(settings.dsh?.url === undefined ? {} : { attachUrl: settings.dsh.url }),
        ...(settings.dsh?.cookie === undefined ? {} : { attachCookie: settings.dsh.cookie }),
        ...(settings.dsh?.browserCookie === undefined ? {} : { attachBrowserCookie: settings.dsh.browserCookie }),
        ...(process.env['WDCC_DSH_PORT'] === undefined ? {} : { port: Number(process.env['WDCC_DSH_PORT']) }),
      }),
    );
  }
  return list;
}
