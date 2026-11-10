/**
 * A2（DSH 部分）：平台建的会话与"直接用 Host API 建"的会话拿到同一套 preset 与工具。
 * 用法：npx tsx scripts/accept-dsh-a2.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { DshAdapter } from '../packages/adapters/dsh/src/adapter.js';
import { DshHostClient, startSidecar } from '../packages/adapters/dsh/src/host.js';
import { startAnthropicMock } from '../packages/testing/mock-models/src/anthropic-server.js';
import { start } from '../packages/server/src/main.js';
import type { Plan } from '../packages/testing/mock-models/src/plan.js';

const plan = JSON.parse(readFileSync('packages/testing/mock-models/plans/probe.json', 'utf8')) as Plan;
const mock = await startAnthropicMock({ plan, port: 0, log: () => undefined, recordPath: '/tmp/wdcc-dsh-a2-mock.jsonl' });
const dataDir = await mkdtemp(join(tmpdir(), 'wdcc-dsh-a2-'));
const workspace = await mkdtemp(join(tmpdir(), 'wdcc-dsh-a2-ws-'));
const homeA = await mkdtemp(join(tmpdir(), 'wdcc-dsh-a2-home-a-'));
const homeB = await mkdtemp(join(tmpdir(), 'wdcc-dsh-a2-home-b-'));
const mockRecord = '/tmp/wdcc-dsh-a2-mock.jsonl';
const mockTools = async (): Promise<string[]> => {
  const lines = readFileSync(mockRecord, 'utf8').trim().split('\n');
  for (const line of lines) {
    const entry = JSON.parse(line) as { direction?: string; body?: { tools?: { name?: string }[] } };
    if (entry.direction === 'request' && (entry.body?.tools ?? []).length > 0) {
      return (entry.body?.tools ?? []).map((tool) => tool.name ?? '').sort();
    }
  }
  return [];
};

// ---- 1) 直接通过 Host API 建会话 ----
const direct = await startSidecar({
  port: 3198,
  env: { ...process.env, DSH_HOME: homeB, DEEPSEEK_BASE_URL: mock.url, DEEPSEEK_API_KEY: 'k' },
});
const client = new DshHostClient(direct.port);
await client.authenticate(direct.tokenUrl);
const ws = await client.rpc<{ workspace: { workspaceId: string } }>('workspace/create', { request: { path: workspace } });
const directSession = await client.rpc<{ sessionId: string; agentPreset?: string }>('session/create', {
  request: { workspaceId: ws.workspace.workspaceId },
});
await client.rpc('session/prompt', {
  request: { requestId: 'direct-1', sessionId: directSession.sessionId, mode: 'queue', content: [{ type: 'text', text: '直接用 Host API' }] },
});
await new Promise((resolve) => setTimeout(resolve, 4000));
await client.close();
await direct.stop();
const directTools = await mockTools();

// ---- 2) 通过 adapter 建会话 ----
const adapter = new DshAdapter({
  port: 3197,
  env: { DSH_HOME: homeA, DEEPSEEK_BASE_URL: mock.url, DEEPSEEK_API_KEY: 'k' },
});
const server = await start(
  { host: '127.0.0.1', port: 0, token: 't', dataDir, dshPort: 3197, idleDisposeMin: 0, version: 'a2' },
  { adapters: [adapter] },
);
const workspaceRow = server.store.createWorkspace('ws', workspace);
const session = await server.manager.createSession({ workspaceId: workspaceRow.id, agent: 'dsh' });
server.manager.send(session.id, { text: '通过 adapter' });
await new Promise((resolve) => setTimeout(resolve, 4000));
const adapterTools = await mockTools();

const spec = adapter.buildLaunchSpec();
console.log('adapter 启动参数：', [spec.command, ...(spec.args ?? [])].join(' '));
console.log(`直接会话 preset：${directSession.agentPreset ?? '?'}；adapter 会话 preset：${'standard（默认）'}`);
console.log(`直接工具（${directTools.length}）：${directTools.slice(0, 6).join(', ')}…`);
console.log(`adapter 工具（${adapterTools.length}）：${adapterTools.slice(0, 6).join(', ')}…`);
const sameTools = JSON.stringify(directTools) === JSON.stringify(adapterTools);
const noInjection = (spec.args ?? []).every((arg) => !arg.includes('--profile') && !arg.includes('plugin'));
console.log(`工具集一致：${sameTools}；启动参数无 profile/plugin 注入：${noInjection}`);
console.log(`工具数 ≥ 20：${adapterTools.length >= 20}`);

await server.close();
await mock.close();
await rm(dataDir, { recursive: true, force: true });
await rm(workspace, { recursive: true, force: true });
await rm(homeA, { recursive: true, force: true });
await rm(homeB, { recursive: true, force: true });
process.exit(sameTools && noInjection && adapterTools.length >= 20 ? 0 : 1);
