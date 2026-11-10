/**
 * A1（Codex 部分）对假模型：新建会话 → 流式输出 → 工具步骤 → 审批 → 打断 → 重启平台后继续。
 * 用法：npx tsx scripts/accept-codex-a1.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { startResponsesMock } from '../packages/testing/mock-models/src/responses-server.js';
import { start } from '../packages/server/src/main.js';
import type { Plan } from '../packages/testing/mock-models/src/plan.js';

const pass: string[] = [];
const fail: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  (ok ? pass : fail).push(`${name}${detail === '' ? '' : `（${detail}）`}`);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

const plan = JSON.parse(readFileSync('packages/testing/mock-models/plans/probe.json', 'utf8')) as Plan;
const mock = await startResponsesMock({ plan, port: 0, log: () => undefined });
const dataDir = await mkdtemp(join(tmpdir(), 'wdcc-a1-'));
const workspace = await mkdtemp(join(tmpdir(), 'wdcc-a1-ws-'));
const codexHome = await mkdtemp(join(tmpdir(), 'wdcc-a1-home-'));

const configOverrides = [
  'model_provider=wdcc_mock',
  'model="gpt-5"',
  'model_providers.wdcc_mock.name="WDCC mock"',
  `model_providers.wdcc_mock.base_url="${mock.url}/v1"`,
  'model_providers.wdcc_mock.wire_api="responses"',
  'model_providers.wdcc_mock.env_key="WDCC_MOCK_KEY"',
];
const makeAdapter = (): CodexAdapter =>
  new CodexAdapter({ configOverrides, env: { ...process.env, CODEX_HOME: codexHome, WDCC_MOCK_KEY: 'k' } });

const server = await start(
  { host: '127.0.0.1', port: 0, token: 't', dataDir, dshPort: 0, idleDisposeMin: 0, version: 'a1' },
  { adapters: [makeAdapter()] },
);

/** 自动批准所有未处理的审批（untrusted 模式下每条命令都会问） */
let autoApprove = true;
const autoTimer = setInterval(() => {
  if (!autoApprove) return;
  void (async () => {
    for (const event of server.store.allEvents(session.id)) {
      if (event.kind !== 'approval.request') continue;
      const data = event.data as { approvalId: string; options: { id: string }[] };
      if (server.store.hasApprovalResolved(session.id, data.approvalId)) continue;
      await server.manager.approve(session.id, { approvalId: data.approvalId, optionId: data.options[0]?.id ?? 'accept' }).catch(() => undefined);
    }
  })();
}, 300);

async function waitFor(sessionId: string, predicate: () => boolean, timeoutMs = 60_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const workspaceRow = server.store.createWorkspace('ws', workspace);
const session = await server.manager.createSession({ workspaceId: workspaceRow.id, agent: 'codex', accessMode: 'untrusted' });
check('新建会话', session.nativeId !== undefined && session.agent === 'codex', `nativeId=${session.nativeId ?? '无'}`);

await server.manager.send(session.id, { text: '按计划执行' });
const gotApproval = await waitFor(session.id, () => server.store.allEvents(session.id).some((event) => event.kind === 'approval.request'));
check('一轮里出现审批请求', gotApproval);
const finished = await waitFor(session.id, () => server.store.allEvents(session.id).some((event) => event.kind === 'turn.completed'));
check('一轮完成', finished);

const kinds = new Set(server.store.allEvents(session.id).map((event) => event.kind));
check('有流式文本增量', kinds.has('assistant.message'));
check('有命令步骤', kinds.has('command'));
check('有工具步骤', kinds.has('tool.call'));

// 重启平台（dispose 进程）后继续同一会话
await server.manager.dispose(session.id);
await server.manager.send(session.id, { text: '重启后继续' });
const resumed = await waitFor(session.id, () =>
  server.store.allEvents(session.id).filter((event) => event.kind === 'turn.completed').length >= 2,
);
check('释放进程后 resume 并完成新一轮', resumed);

// 打断
await server.manager.send(session.id, { text: '这轮会被打断' });
await new Promise((resolve) => setTimeout(resolve, 300));
await server.manager.interrupt(session.id);
const interrupted = await waitFor(session.id, () =>
  server.store.allEvents(session.id).some((event) => event.kind === 'turn.completed' && (event.data as { status: string }).status === 'interrupted'),
);
check('打断一轮', interrupted);


const events = server.store.allEvents(session.id);
for (const event of events.filter((item) => item.kind === 'turn.completed' || item.kind === 'error')) {
  console.log('  ·', event.kind, JSON.stringify(event.data).slice(0, 160));
}
console.log(`\n事件总数 ${events.length}；kind：${[...new Set(events.map((event) => event.kind))].join(', ')}`);
clearInterval(autoTimer);
console.log(`通过 ${pass.length} 项，失败 ${fail.length} 项`);
await server.close();
await mock.close();
await rm(dataDir, { recursive: true, force: true });
await rm(workspace, { recursive: true, force: true });
await rm(codexHome, { recursive: true, force: true });
process.exit(fail.length === 0 ? 0 : 1);
