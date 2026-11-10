/**
 * M3 冒烟：用真实 CodexAdapter + mock-responses 跑一轮。
 * 用法：npx tsx scripts/test-codex-adapter.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { startResponsesMock } from '../packages/testing/mock-models/src/responses-server.js';
import { start } from '../packages/server/src/main.js';
import type { Plan } from '../packages/testing/mock-models/src/plan.js';

const plan = JSON.parse(readFileSync('packages/testing/mock-models/plans/probe.json', 'utf8')) as Plan;
const mockRecord = '/tmp/wdcc-codex-tools.jsonl';
const mock = await startResponsesMock({ plan, port: 0, log: () => undefined, recordPath: mockRecord });
const dataDir = await mkdtemp(join(tmpdir(), 'wdcc-codex-e2e-'));
const workspace = await mkdtemp(join(tmpdir(), 'wdcc-codex-ws-'));
const codexHome = await mkdtemp(join(tmpdir(), 'wdcc-codex-home-'));

const configOverrides = [
  'model_provider=wdcc_mock',
  'model="gpt-5"',
  'model_providers.wdcc_mock.name="WDCC mock"',
  `model_providers.wdcc_mock.base_url="${mock.url}/v1"`,
  'model_providers.wdcc_mock.wire_api="responses"',
  'model_providers.wdcc_mock.env_key="WDCC_MOCK_KEY"',
];
const adapter = new CodexAdapter({ configOverrides, env: { ...process.env, CODEX_HOME: codexHome, WDCC_MOCK_KEY: 'k' } });
const server = await start({ host: '127.0.0.1', port: 0, token: 't', dataDir, dshPort: 0, idleDisposeMin: 0, version: 'test' }, { adapters: [adapter] });

const workspaceRow = server.store.createWorkspace('ws', workspace);
const session = await server.manager.createSession({ workspaceId: workspaceRow.id, agent: 'codex' });
await server.manager.send(session.id, { text: '按计划执行' });
for (let i = 0; i < 120; i += 1) {
  const events = server.store.allEvents(session.id);
  const done = events.some((event) => event.kind === 'turn.completed');
  if (done) {
    const kinds = [...new Set(events.map((event) => event.kind))];
    console.log('事件数', events.length, 'kind:', kinds.join(', '));
    const { readFileSync: readTools } = await import('node:fs');
    try {
      const lines = readTools(mockRecord, 'utf8').trim().split('\n');
      const first = JSON.parse(lines[0]) as { body?: { tools?: { name?: string; type?: string }[] } };
      console.log('模型拿到的工具:', (first.body?.tools ?? []).map((tool) => tool.name ?? tool.type).join(', '));
    } catch (error) {
      console.log('读取工具列表失败', String(error));
    }
    console.log('审批', events.filter((event) => event.kind === 'approval.request').length, '条');
    await server.close();
    await mock.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
console.error('超时：没有收到 turn.completed');
await server.close();
await mock.close();
process.exit(1);
