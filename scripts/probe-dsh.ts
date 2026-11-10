/**
 * M0 探针：DSH（平台托管 `dsh web` 侧车，走它的 Web Host API）。
 *
 * 跑完 SPEC M0 第 7 步要求的全部动作，全程用 mock-anthropic 假模型驱动：
 *   1. 新建会话（session/create）
 *   2. 一轮含读文件、执行命令、写文件的对话（session/prompt + session/follow）
 *   3. 触发一次审批（`approval/request` waterfall → `$events/result`）
 *   4. 打断一轮（session/cancel）
 *   5. 杀侧车后恢复（重启 `dsh web`，重新 follow 同一 session 再发一轮）
 *
 * 协议细节见 docs/protocol-notes.md（DSH 章节），全部按 0.2.2-rc.1 源码核实。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { startAnthropicMock } from '../packages/testing/mock-models/src/anthropic-server.js';
import type { Plan } from '../packages/testing/mock-models/src/plan.js';
import { DshHostClient, startSidecar, waitUntil, type StreamFrame } from './lib/dsh-host.js';
import {
  assertTrue,
  createFixtureRecorder,
  createTempWorkspace,
  dumpMockRecords,
  logLine,
  removeTempWorkspace,
} from './lib/fixtures.js';

const PLAN_PATH = join(process.cwd(), 'packages/testing/mock-models/plans/probe-dsh.json');
const FIXTURE_PATH = 'fixtures/dsh/sidecar-session.jsonl';
const SIDECAR_PORT = Number(process.env['WDCC_DSH_PROBE_PORT'] ?? 3191);
const verbose = process.argv.includes('--verbose');

interface SessionState {
  text: string;
  events: string[];
  approvals: { clientId?: string; eventId: string; toolName: string }[];
  running: boolean;
  streamTypes: Map<string, number>;
  toolCalls: string[];
  toolResults: string[];
}

function frameValue(frame: StreamFrame): Record<string, unknown> | undefined {
  const value = frame.value;
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

async function main(): Promise<void> {
  const plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8')) as Plan;
  const mockRecord = join(tmpdir(), `wdcc-mock-dsh-${Date.now().toString(36)}.jsonl`);
  const mock = await startAnthropicMock({ plan, port: 0, recordPath: mockRecord, log: () => undefined });
  logLine(`mock-anthropic: ${mock.url}`);

  const workspace = await createTempWorkspace('dsh');
  const dshHome = await mkdtemp(join(tmpdir(), 'wdcc-dsh-home-'));
  const recorder = createFixtureRecorder(FIXTURE_PATH);
  logLine(`工作区：${workspace}`);
  logLine(`DSH_HOME（临时）：${dshHome}`);

  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    DEEPSEEK_BASE_URL: mock.url,
    DEEPSEEK_API_KEY: 'mock-key-not-a-secret',
    NO_COLOR: '1',
  };

  const summary: string[] = [];
  let sessionId = '';
  let sidecar = await startSidecar({ port: SIDECAR_PORT, env });
  let client = new DshHostClient(sidecar.port);

  try {
    // ---------- 认证 ----------
    const cookie = await client.authenticate(sidecar.tokenUrl);
    assertTrue(cookie.startsWith('dsh-auth-'), `Cookie 名不符合预期：${cookie.slice(0, 30)}`);
    logLine(`token → Cookie：${cookie.slice(0, 24)}…`);

    // ---------- 1. 工作区 + 新建会话 ----------
    const createdWorkspace = await client.rpc<{ workspace: { workspaceId: string }; created: boolean }>('workspace/create', {
      request: { path: workspace },
    });
    const workspaceId = createdWorkspace.workspace.workspaceId;
    logLine(`workspace/create → ${workspaceId}（created=${String(createdWorkspace.created)}）`);

    const created = await client.rpc<{ sessionId: string; agentPreset?: string }>('session/create', {
      request: { workspaceId },
    });
    sessionId = created.sessionId;
    logLine(`session/create → ${sessionId}（agentPreset=${String(created.agentPreset)}）`);
    summary.push(`新建会话：workspace/create + session/create，sessionId=${sessionId}`);

    // 把访问模式调成需要审批的档位（原生枚举，见 docs/protocol-notes.md）
    try {
      await client.rpc('commands/execute', {
        agentId: sessionId,
        line: '/permission workspace-write',
        submittedAttachments: [],
      });
      logLine('已将访问模式切到 workspace-write（workspace-write / ask）');
    } catch (error) {
      logLine(`切换访问模式失败（继续跑）：${String(error)}`);
    }

    // ---------- 订阅 ----------
    const state: SessionState = {
      text: '',
      events: [],
      approvals: [],
      running: false,
      streamTypes: new Map(),
      toolCalls: [],
      toolResults: [],
    };
    let eventClientId = '';

    const attach = async (target: DshHostClient): Promise<void> => {
      await target.connect();
      target.openStream('$events', {}, (frame) => {
        recorder.record('in', frame);
        const value = frameValue(frame);
        if (value === undefined) return;
        if (value['type'] === 'ready') {
          eventClientId = String(value['clientId'] ?? '');
          return;
        }
        if (value['type'] === 'waterfall' && value['event'] === 'approval/request') {
          const request = (value['request'] ?? {}) as Record<string, unknown>;
          const approval = {
            clientId: eventClientId,
            eventId: String(value['eventId']),
            toolName: String(request['toolName'] ?? '?'),
          };
          state.approvals.push(approval);
          logLine(`  ← 审批请求：${approval.toolName}（eventId=${approval.eventId}）`);
          void target
            .rpc('$events/result', {
              clientId: eventClientId,
              eventId: approval.eventId,
              outcome: { kind: 'result', value: 'allowed-once' },
            })
            .catch((error: unknown) => logLine(`  审批回复失败：${String(error)}`));
          return;
        }
        if (value['type'] === 'emit') {
          const event = String(value['event'] ?? '');
          const args = (value['args'] ?? []) as unknown[];
          if (event === 'api-session/status') state.running = args[1] === true;
        }
      });

      target.openStream(
        'session/follow',
        { request: { address: { kind: 'session', sessionId }, activate: true, assistantStream: true } },
        (frame) => {
          recorder.record('in', frame);
          const value = frameValue(frame);
          if (value === undefined) return;
          const type = String(value['type'] ?? '?');
          state.streamTypes.set(type, (state.streamTypes.get(type) ?? 0) + 1);
          if (verbose) logLine(`    · follow frame: ${type}`);
          if (type === 'assistant-stream') {
            const inner = (value['frame'] ?? {}) as Record<string, unknown>;
            const chunk = (inner['chunk'] ?? {}) as Record<string, unknown>;
            if (chunk['type'] === 'text-delta') state.text += String(chunk['text'] ?? '');
          } else if (type === 'event') {
            const event = (value['event'] ?? {}) as Record<string, unknown>;
            const name = String(event['type'] ?? '?');
            state.events.push(name);
            if (name === 'tool/call') state.toolCalls.push(JSON.stringify(event['data']).slice(0, 400));
            if (name === 'tool/result') state.toolResults.push(JSON.stringify(event['data']).slice(0, 400));
          }
        },
      );
    };

    await attach(client);
    await new Promise((r) => setTimeout(r, 600));

    // ---------- 2. 一轮含工具调用的对话 ----------
    state.text = '';
    await client.rpc('session/prompt', {
      request: {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: '请按计划执行：列目录、读 SPEC.md、写文件、改文件，然后总结。' }],
      },
    });
    await waitUntil(() => state.text.length > 0, 120_000, '第 1 轮没有产生任何 assistant 文本');
    await waitUntil(() => !state.running, 180_000, '第 1 轮没有回到 idle');
    logLine(`  第 1 轮文本长度=${state.text.length}`);
    logLine(`  follow 帧类型：${[...state.streamTypes].map(([k, v]) => `${k}×${v}`).join(', ')}`);
    logLine(`  会话事件：${state.events.slice(0, 20).join(', ')}`);
    for (const call of state.toolCalls) logLine(`  tool/call: ${call}`);
    for (const result of state.toolResults) logLine(`  tool/result: ${result}`);
    assertTrue(state.text.length > 0, '第 1 轮没有 assistant 文本');
    summary.push(`一轮对话：assistant 文本 ${state.text.length} 字，follow 帧 ${state.streamTypes.size} 种`);

    // ---------- 3. 审批 ----------
    assertTrue(state.approvals.length > 0, '整轮没有收到 approval/request（需要访问模式触发审批）');
    logLine(`审批请求：${state.approvals.map((a) => a.toolName).join(', ')}`);
    summary.push(`审批：${state.approvals.length} 个 approval/request，已用 $events/result 回 allowed-once`);

    // ---------- 4. 打断 ----------
    state.text = '';
    await client.rpc('session/prompt', {
      request: {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: '再跑一轮，我这轮会中途 cancel。' }],
      },
    });
    await waitUntil(() => state.text.length > 0, 60_000, '打断前这一轮没有开始产生文本');
    await client.rpc('session/cancel', { request: { sessionId } });
    await waitUntil(() => !state.running, 60_000, 'cancel 之后没有回到 idle');
    logLine(`打断：session/cancel 后回到 idle，已产出文本 ${state.text.length} 字`);
    summary.push('打断：session/cancel → 会话回到 idle');

    // ---------- 5. 杀侧车后恢复 ----------
    const beforeRestart = state.text.length;
    await client.close();
    await sidecar.stop();
    logLine('已 SIGKILL 侧车进程');

    sidecar = await startSidecar({ port: SIDECAR_PORT, env });
    client = new DshHostClient(sidecar.port);
    await client.authenticate(sidecar.tokenUrl);
    state.text = '';
    state.running = false;
    await attach(client);
    await new Promise((r) => setTimeout(r, 600));

    await client.rpc('session/prompt', {
      request: {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: '侧车进程重启过了，这是恢复后的新一轮：再列一次目录确认状态还在。' }],
      },
    });
    await waitUntil(() => state.text.length > 0, 120_000, '恢复后的那一轮没有产生文本');
    await waitUntil(() => !state.running, 180_000, '恢复后的那一轮没有回到 idle');
    logLine(`恢复后一轮：文本长度=${state.text.length}（重启前 ${beforeRestart}）`);
    assertTrue(state.text.length > 0, '恢复后没有 assistant 文本');
    summary.push('杀进程恢复：重启侧车 → 重新 follow 同一 session → 新一轮有文本');

    // ---------- 产物 ----------
    await recorder.flush();
    await dumpMockRecords(mockRecord, 'fixtures/dsh/mock-model-requests.jsonl');
    logLine(`fixtures：${FIXTURE_PATH}`);
  } finally {
    await client.close().catch(() => undefined);
    await sidecar.stop().catch(() => undefined);
    await mock.close();
    await removeTempWorkspace(workspace);
    await rm(dshHome, { recursive: true, force: true }).catch(() => undefined);
  }

  logLine('\n=== DSH 探针通过 ===');
  for (const line of summary) logLine(`- ${line}`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`\nDSH 探针失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}
