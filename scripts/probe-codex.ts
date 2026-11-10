/**
 * M0 探针：Codex（`codex app-server`，stdio JSON-RPC）。
 *
 * 跑完 SPEC M0 第 7 步要求的全部动作，全程用 mock-responses 假模型：
 *   1. 新建会话（thread/start）
 *   2. 一轮含读文件、执行命令、写文件的对话
 *   3. 触发一次审批（服务端反向请求）
 *   4. 打断一轮（turn/interrupt）
 *   5. 杀进程后恢复（新进程 + thread/resume）再发一轮
 *
 * 用法：pnpm probe:codex   （--keep 保留临时工作区，--verbose 打印收到的通知类型统计）
 * 退出码 0 = 全部动作跑通；非 0 = 有断言失败，错误信息里指出失败点。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { JsonRpcStdio, type Frame } from './lib/rpc.js';
import {
  assertTrue,
  createFixtureRecorder,
  createTempWorkspace,
  dumpMockRecords,
  logLine,
  removeTempWorkspace,
} from './lib/fixtures.js';
import { startResponsesMock } from '../packages/testing/mock-models/src/responses-server.js';
import type { Plan } from '../packages/testing/mock-models/src/plan.js';

const REPO_ROOT = process.cwd();
const PLAN_PATH = join(REPO_ROOT, 'packages/testing/mock-models/plans/probe.json');
const FIXTURE_PATH = 'fixtures/codex/app-server-basic.jsonl';
const MODEL_ID = 'mock-responses-1';

const ctxRef: { current: Ctx | null } = { current: null };
const keep = process.argv.includes('--keep');
const verbose = process.argv.includes('--verbose');

function loadPlan(): Plan {
  const parsed: unknown = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
  return parsed as Plan;
}

interface Ctx {
  rpc: JsonRpcStdio;
  stderr: string[];
  notifications: Map<string, number>;
  approvals: Frame[];
}

function buildArgs(mockBaseUrl: string): string[] {
  return [
    'app-server',
    '-c',
    'model_provider=wdcc_mock',
    '-c',
    `model="${MODEL_ID}"`,
    '-c',
    'model_providers.wdcc_mock.name="WDCC mock"',
    '-c',
    `model_providers.wdcc_mock.base_url="${mockBaseUrl}/v1"`,
    '-c',
    'model_providers.wdcc_mock.wire_api="responses"',
    '-c',
    'model_providers.wdcc_mock.env_key="WDCC_MOCK_KEY"',
  ];
}

function startApp(mockBaseUrl: string, workspace: string, codexHome: string, recorder: ReturnType<typeof createFixtureRecorder>): Ctx {
  const stderr: string[] = [];
  const notifications = new Map<string, number>();
  const approvals: Frame[] = [];

  const rpc = JsonRpcStdio.start({
    command: 'codex',
    args: buildArgs(mockBaseUrl),
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: codexHome, WDCC_MOCK_KEY: 'mock-key-not-a-secret' },
    onFrame: (direction, frame) => recorder.record(direction, frame),
    onStderr: (line) => {
      stderr.push(line);
      if (stderr.length > 200) stderr.shift();
    },
  });

  const ctx: Ctx = { rpc, stderr, notifications, approvals };

  rpc.onNotification((frame) => {
    const method = String(frame['method']);
    notifications.set(method, (notifications.get(method) ?? 0) + 1);
    if (verbose) logLine(`  ← ${method}`);
  });

  rpc.onServerRequest(async (frame) => {
    const method = String(frame['method']);
    approvals.push(frame);
    logLine(`  ← 审批请求：${method}`);
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return { decision: 'accept' };
      case 'execCommandApproval':
      case 'applyPatchApproval':
        return { decision: 'approved' };
      case 'item/tool/requestUserInput':
        return { answers: {} };
      case 'item/permissions/requestApproval':
        return { permissions: {}, scope: 'turn' };
      default:
        return undefined;
    }
  });

  return ctx;
}

async function handshake(ctx: Ctx): Promise<Record<string, unknown>> {
  const init = await ctx.rpc.request<Record<string, unknown>>('initialize', {
    clientInfo: { name: 'webdcc', title: 'WebDCC M0 probe', version: '0.0.0' },
    capabilities: null,
  });
  ctx.rpc.notify('initialized');
  return init;
}

function userInput(text: string): unknown[] {
  return [{ type: 'text', text, text_elements: [] }];
}

async function main(): Promise<void> {
  const plan = loadPlan();
  const mockRecord = join(tmpdir(), `wdcc-mock-responses-${Date.now().toString(36)}.jsonl`);
  const mock = await startResponsesMock({
    plan,
    port: 0,
    log: verbose ? undefined : () => undefined,
    recordPath: mockRecord,
  });
  logLine(`mock-responses: ${mock.url}`);

  const workspace = await createTempWorkspace('codex');
  const codexHome = await mkdtemp(join(tmpdir(), 'wdcc-codex-home-'));
  const recorder = createFixtureRecorder(FIXTURE_PATH);
  logLine(`工作区：${workspace}`);
  logLine(`CODEX_HOME（临时，不碰用户 ~/.codex）：${codexHome}`);

  const summary: string[] = [];
  let ctx = startApp(mock.url, workspace, codexHome, recorder);
  ctxRef.current = ctx;

  try {
    // ---------- 1. 握手 + 新建会话 ----------
    const init = await handshake(ctx);
    logLine(`initialize → userAgent=${String(init['userAgent'] ?? '?')} codexHome=${String(init['codexHome'] ?? '?')}`);

    const started = await ctx.rpc.request<{ thread: { id: string } }>('thread/start', {
      cwd: workspace,
      model: MODEL_ID,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    });
    const threadId = started.thread.id;
    assertTrue(typeof threadId === 'string' && threadId.length > 0, 'thread/start 没返回 thread.id');
    logLine(`thread/start → ${threadId}`);
    summary.push(`新建会话：thread/start，threadId=${threadId}`);

    // ---------- 2. 一轮含读文件 / 执行命令 / 写文件的对话 ----------
    const done1 = ctx.rpc.waitForNotification((f) => f['method'] === 'turn/completed', 180_000);
    await ctx.rpc.request('turn/start', {
      threadId,
      input: userInput('请按计划执行：列目录、读 SPEC.md、写文件、改文件、更新任务清单，然后总结。'),
    });
    const completed1 = await done1;
    const turn1 = completed1['params'] as { turn?: { status?: string; items?: unknown[]; error?: unknown } } | undefined;
    const status1 = turn1?.turn?.status;
    logLine(`第 1 轮结束：status=${String(status1)}，item 数=${String(turn1?.turn?.items?.length ?? '?')}`);
    if (turn1?.turn?.error) logLine(`turn.error=${JSON.stringify(turn1.turn.error)}`);
    assertTrue(status1 === 'completed', `第 1 轮没有正常完成（status=${String(status1)}）`);
    summary.push(`一轮对话：turn/completed status=${String(status1)}`);

    const n = ctx.notifications;
    const count = (name: string): number => n.get(name) ?? 0;
    logLine(
      `通知统计：item/started=${count('item/started')} item/completed=${count('item/completed')} ` +
        `agentMessage/delta=${count('item/agentMessage/delta')} turn/plan/updated=${count('turn/plan/updated')} ` +
        `tokenUsage=${count('thread/tokenUsage/updated')}`,
    );
    assertTrue(count('item/completed') > 0, '整轮没有收到任何 item/completed');
    assertTrue(count('item/agentMessage/delta') > 0, '整轮没有收到任何 item/agentMessage/delta（没有流式文本）');
    summary.push(`事件流：item/started=${count('item/started')}、item/completed=${count('item/completed')}、agentMessage/delta=${count('item/agentMessage/delta')}`);

    // ---------- 3. 审批 ----------
    assertTrue(ctx.approvals.length > 0, '整轮没有收到任何审批请求（approvalPolicy=untrusted 下应有）');
    logLine(`审批请求：${ctx.approvals.length} 个（${ctx.approvals.map((a) => String(a['method'])).join(', ')}）`);
    summary.push(`审批：收到 ${ctx.approvals.length} 个反向请求，已按原生枚举 accept/approved 回复`);

    // ---------- 4. 打断一轮 ----------
    // 先挂上 turn/completed 的监听再发，避免竞态漏掉通知
    const done2 = ctx.rpc.waitForNotification((f) => f['method'] === 'turn/completed', 60_000);
    const turn2 = await ctx.rpc.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: userInput('再跑一轮，我这轮会中途打断你。'),
    });
    await new Promise((r) => setTimeout(r, 250));
    await ctx.rpc.request('turn/interrupt', { threadId, turnId: turn2.turn.id }).catch((error: unknown) => {
      logLine(`turn/interrupt 返回错误（按原生行为记录）：${String(error)}`);
    });
    const completed2 = await done2;
    const status2 = ((completed2['params'] as { turn?: { status?: string } } | undefined)?.turn ?? {}).status;
    logLine(`打断：turn/interrupt → turn/completed status=${String(status2)}`);
    assertTrue(status2 === 'interrupted', `打断后 status 应为 interrupted，实际 ${String(status2)}`);
    summary.push('打断：turn/interrupt → turn/completed(status=interrupted)');

    // ---------- 5. 杀进程后恢复 ----------
    await ctx.rpc.kill('SIGKILL');
    logLine('已 SIGKILL app-server 进程');
    ctx = startApp(mock.url, workspace, codexHome, recorder);
    ctxRef.current = ctx;
    await handshake(ctx);
    const resumed = await ctx.rpc.request<{ thread: { id: string } }>('thread/resume', {
      threadId,
      model: MODEL_ID,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    });
    logLine(`thread/resume → ${resumed.thread.id}`);
    const done3 = ctx.rpc.waitForNotification((f) => f['method'] === 'turn/completed', 180_000);
    await ctx.rpc.request('turn/start', {
      threadId,
      input: userInput('进程被杀过又重新恢复，这是恢复后的新一轮：再列一次目录确认状态还在。'),
    });
    const completed3 = await done3;
    const status3 = ((completed3['params'] as { turn?: { status?: string } } | undefined)?.turn ?? {}).status;
    logLine(`恢复后一轮：status=${String(status3)}`);
    assertTrue(status3 === 'completed', `恢复后的那一轮没有完成（status=${String(status3)}）`);
    summary.push('杀进程恢复：SIGKILL → 新进程 → thread/resume → 新一轮 status=completed');

    // ---------- 产物 ----------
    const outputPath = join(workspace, 'mock-model-output.txt');
    const written = await readFile(outputPath, 'utf8').catch(() => '<文件不存在>');
    logLine(`工作区产物 mock-model-output.txt：${written.trim()}`);
    summary.push(`写文件：${written === '<文件不存在>' ? '工作区里没有生成文件' : 'mock-model-output.txt 已生成'}`);

    await recorder.flush();
    await dumpMockRecords(mockRecord, 'fixtures/codex/mock-model-requests.jsonl');
    logLine(`fixtures：${FIXTURE_PATH}`);
  } finally {
    await ctx.rpc.kill().catch(() => undefined);
    await mock.close();
    if (!keep) await removeTempWorkspace(workspace);
    else logLine(`保留工作区：${workspace}`);
    await rm(codexHome, { recursive: true, force: true }).catch(() => undefined);
  }

  logLine('\n=== Codex 探针通过 ===');
  for (const line of summary) logLine(`- ${line}`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`\nCodex 探针失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  const stderrTail = ctxRef.current?.stderr.slice(-40) ?? [];
  if (process.env['WDCC_PROBE_KEEP_RECORDS']) process.stderr.write(`mock records: ${process.env['WDCC_PROBE_KEEP_RECORDS']}\n`);
  if (stderrTail.length > 0) process.stderr.write(`\n--- app-server stderr（末 ${stderrTail.length} 行）---\n${stderrTail.join('\n')}\n`);
  process.exit(1);
}
