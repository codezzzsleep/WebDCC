/**
 * A1（Claude Code 部分）对假模型：新建 → 流式 → 工具 → 审批 → 打断 → 释放后 resume 继续。
 * 用法：npx tsx scripts/accept-claude-a1.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';
import { startAnthropicMock } from '../packages/testing/mock-models/src/anthropic-server.js';
import { start } from '../packages/server/src/main.js';
import type { Plan } from '../packages/testing/mock-models/src/plan.js';

const pass: string[] = [];
const fail: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  (ok ? pass : fail).push(name);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

const plan = JSON.parse(readFileSync('packages/testing/mock-models/plans/probe.json', 'utf8')) as Plan;
const mock = await startAnthropicMock({ plan, port: 0, log: () => undefined });
const dataDir = await mkdtemp(join(tmpdir(), 'wdcc-claude-a1-'));
const workspace = await mkdtemp(join(tmpdir(), 'wdcc-claude-ws-'));
const configDir = await mkdtemp(join(tmpdir(), 'wdcc-claude-home-'));

const makeAdapter = (): ClaudeAdapter =>
  new ClaudeAdapter({
    env: {
      ANTHROPIC_BASE_URL: mock.url,
      ANTHROPIC_API_KEY: 'mock-key',
      ANTHROPIC_AUTH_TOKEN: 'mock-token',
      CLAUDE_CONFIG_DIR: configDir,
    },
  });

const server = await start(
  { host: '127.0.0.1', port: 0, token: 't', dataDir, dshPort: 0, idleDisposeMin: 0, version: 'a1' },
  { adapters: [makeAdapter()] },
);

async function waitFor(predicate: () => boolean, timeoutMs = 90_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const workspaceRow = server.store.createWorkspace('ws', workspace);
const session = await server.manager.createSession({ workspaceId: workspaceRow.id, agent: 'claude-code', accessMode: 'default' });
check('新建会话', session.agent === 'claude-code');

// 自动批准所有审批（Claude 的 Bash/Write/Edit 都会走 canUseTool）
const autoTimer = setInterval(() => {
  void (async () => {
    for (const event of server.store.allEvents(session.id)) {
      if (event.kind !== 'approval.request') continue;
      const approvalId = (event.data as { approvalId: string }).approvalId;
      if (server.store.hasApprovalResolved(session.id, approvalId)) continue;
      await server.manager.approve(session.id, { approvalId, optionId: 'allow' }).catch(() => undefined);
    }
  })();
}, 300);

server.manager.send(session.id, { text: '按计划执行' });
const gotApproval = await waitFor(() => server.store.allEvents(session.id).some((event) => event.kind === 'approval.request'));
check('出现审批请求', gotApproval);
const completed = await waitFor(() => server.store.allEvents(session.id).some((event) => event.kind === 'turn.completed'));
check('一轮完成', completed);
const kinds = new Set(server.store.allEvents(session.id).map((event) => event.kind));
check('有流式/助手消息', kinds.has('assistant.message'));
check('有工具步骤', kinds.has('tool.call') || kinds.has('command'));

server.manager.send(session.id, { text: '这轮会被打断' });
await new Promise((resolve) => setTimeout(resolve, 1500));
await server.manager.interrupt(session.id);
const interrupted = await waitFor(() =>
  server.store.allEvents(session.id).filter((event) => event.kind === 'turn.completed').length >= 2,
);
check('打断一轮', interrupted);

const nativeId = server.store.getSession(session.id)?.nativeId;
check('session_id 已落库', typeof nativeId === 'string' && nativeId.length > 10, nativeId ?? '无');

await server.manager.dispose(session.id);
server.manager.send(session.id, { text: '重启后继续' });
const resumed = await waitFor(() =>
  server.store.allEvents(session.id).filter((event) => event.kind === 'turn.completed').length >= 3,
  90_000,
);
check('释放后 resume 并完成新一轮', resumed);

const counts = new Map<string, number>();
for (const event of server.store.allEvents(session.id)) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
console.log('  事件计数：' + [...counts].map(([kind, count]) => `${kind}=${count}`).join(' '));
clearInterval(autoTimer);
console.log(`通过 ${pass.length} 项，失败 ${fail.length} 项`);
await server.close();
await mock.close();
await rm(dataDir, { recursive: true, force: true });
await rm(workspace, { recursive: true, force: true });
await rm(configDir, { recursive: true, force: true });
process.exit(fail.length === 0 ? 0 : 1);
