/**
 * 研究脚本（M8 F12 / Q1）：让 Codex 0.167 在 code mode 下跑一遍 mock 的 `full` 计划。
 *
 * 走 `codex app-server`（产品实际路径），打印到达的通知统计与工作区结果，
 * 并把原生通知写进 `fixtures/codex/code-mode-appserver.jsonl`，供 protocol-notes 引用。
 *
 * 用法：pnpm tsx scripts/research-codex-codemode.ts [slug]
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcStdio } from '../packages/adapters/codex/src/rpc.js';
import { startResponsesMock } from '../packages/testing/mock-models/src/responses-server.js';
import { MockControl } from '../packages/testing/mock-models/src/mock-control.js';

const SLUG = process.argv[2] ?? 'gpt-6.1-sol';
const PLANS_DIR = join(process.cwd(), 'packages/testing/mock-models/plans');

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'wdcc-codex-codemode-'));
  const codexHome = join(root, 'codex');
  const ws = join(root, 'ws');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'README.md'), '# Sample Repo\n\nWDCC-M8 sample workspace.\nline to modify: ORIGINAL\n');
  const control = new MockControl([], PLANS_DIR);
  control.setPlan('full');
  const mock = await startResponsesMock({ plan: [], port: 0, plansDir: PLANS_DIR, control, log: () => undefined });
  writeFileSync(
    join(codexHome, 'config.toml'),
    [
      `model = "${SLUG}"`,
      'model_provider = "mockr"',
      '',
      '[model_providers.mockr]',
      'name = "Mock Responses"',
      `base_url = "${mock.url}/v1"`,
      'wire_api = "responses"',
      'env_key = "WDCC_TEST_MOCKR_KEY"',
      '',
    ].join('\n'),
  );

  const frames: Record<string, unknown>[] = [];
  const rpc = JsonRpcStdio.start({
    command: 'codex',
    args: ['app-server'],
    cwd: ws,
    env: { ...process.env, CODEX_HOME: codexHome, WDCC_TEST_MOCKR_KEY: 'sk-wdcc-test-mockr-research' },
    onFrame: (_direction, frame) => {
      if (frame['method'] !== undefined) frames.push(frame);
    },
  });
  rpc.onServerRequest((frame) => {
    const method = String(frame['method'] ?? '');
    const id = Number(frame['id']);
    console.log(`审批请求：${method}`);
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      rpc.respond(id, { decision: 'accept' });
      return undefined;
    }
    return undefined;
  });
  await rpc.request('initialize', { clientInfo: { name: 'research', title: 'research', version: '0' }, capabilities: null });
  rpc.notify('initialized');
  const thread = await rpc.request<{ thread: { id: string } }>('thread/start', { cwd: ws, model: SLUG });
  await rpc.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: '跑一遍 full 计划' }] });
  const started = Date.now();
  while (Date.now() - started < 20_000 && !frames.some((frame) => frame['method'] === 'turn/completed')) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await rpc.kill();

  const counts = new Map<string, number>();
  for (const frame of frames) {
    const method = String(frame['method']);
    counts.set(method, (counts.get(method) ?? 0) + 1);
  }
  console.log('通知统计：');
  for (const [method, count] of [...counts.entries()].sort()) console.log(`  ${method} ×${count}`);
  console.log(`\n请求数：${control.requests.length}（helper=${control.requests.filter((r) => r.helper === true).length}）`);
  console.log(`notes.txt 存在：${existsSync(join(ws, 'notes.txt'))}`);
  if (existsSync(join(ws, 'notes.txt'))) console.log(`notes.txt 内容：${JSON.stringify(readFileSync(join(ws, 'notes.txt'), 'utf8'))}`);
  console.log(`README.md 内容：${JSON.stringify(readFileSync(join(ws, 'README.md'), 'utf8'))}`);
  mkdirSync(join(process.cwd(), 'fixtures/codex'), { recursive: true });
  writeFileSync(join(process.cwd(), 'fixtures/codex/code-mode-appserver.jsonl'), frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n');
  await mock.close();
  process.exit(0);
}

void main();
