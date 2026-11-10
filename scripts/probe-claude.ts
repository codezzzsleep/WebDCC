/**
 * M0 探针：Claude Code（`@anthropic-ai/claude-agent-sdk` 的 query()）。
 *
 * 跑完 SPEC M0 第 7 步要求的全部动作，全程用 mock-anthropic 假模型：
 *   1. 新建会话（首条 system/init 的 session_id）
 *   2. 一轮含读文件、执行命令、写文件的对话
 *   3. 触发一次审批（canUseTool 回调）
 *   4. 打断一轮（query.interrupt()）
 *   5. 杀进程后恢复（关掉 query，重新 query + resume 同一个 session_id）再发一轮
 *
 * 用法：pnpm probe:claude
 * 退出码 0 = 全部动作跑通。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  query,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { startAnthropicMock } from '../packages/testing/mock-models/src/anthropic-server.js';
import type { Plan } from '../packages/testing/mock-models/src/plan.js';
import {
  assertTrue,
  createFixtureRecorder,
  createTempWorkspace,
  dumpMockRecords,
  logLine,
  removeTempWorkspace,
} from './lib/fixtures.js';

const PLAN_PATH = join(process.cwd(), 'packages/testing/mock-models/plans/probe.json');
const FIXTURE_PATH = 'fixtures/claude-code/sdk-session.jsonl';
const MODEL_ID = 'mock-anthropic-1';

interface InputQueue {
  push: (text: string) => void;
  end: () => void;
  iterable: AsyncIterable<SDKUserMessage>;
}

function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

function createInputQueue(): InputQueue {
  const queue: SDKUserMessage[] = [];
  let done = false;
  let notify: (() => void) | null = null;

  const iterable: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift() as SDKUserMessage;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
  };

  return {
    iterable,
    push(text: string) {
      queue.push(userMessage(text));
      notify?.();
      notify = null;
    },
    end() {
      done = true;
      notify?.();
      notify = null;
    },
  };
}

interface TurnLog {
  messages: SDKMessage[];
  result?: SDKMessage;
}

/**
 * 后台消费一个 query 的消息流。
 * 注意：不能对 Query 用 for-await 再 break —— break 会触发异步生成器的 return()，
 * 把 SDK 子进程直接关掉；所以这里让消费循环一直跑到 query 自己结束，按"当前轮"归集消息。
 */
interface Pump {
  startTurn: () => { turn: TurnLog; done: Promise<SDKMessage> };
  finished: Promise<void>;
}

async function main(): Promise<void> {
  const plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8')) as Plan;
  const unknownEndpoints: string[] = [];
  const mockRecord = join(tmpdir(), `wdcc-mock-anthropic-${Date.now().toString(36)}.jsonl`);
  const mock = await startAnthropicMock({
    plan,
    port: 0,
    modelId: MODEL_ID,
    log: (line, extra) => {
      if (line === 'UNKNOWN endpoint') unknownEndpoints.push(String(extra));
    },
    recordPath: mockRecord,
  });
  logLine(`mock-anthropic: ${mock.url}`);

  const workspace = await createTempWorkspace('claude');
  const configDir = await mkdtemp(join(tmpdir(), 'wdcc-claude-config-'));
  const recorder = createFixtureRecorder(FIXTURE_PATH);
  logLine(`工作区：${workspace}`);
  logLine(`CLAUDE_CONFIG_DIR（临时）：${configDir}`);

  const baseEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_API_KEY: 'mock-key-not-a-secret',
    ANTHROPIC_AUTH_TOKEN: 'mock-token-not-a-secret',
    CLAUDE_CONFIG_DIR: configDir,
  };

  const approvals: string[] = [];
  const canUseTool = async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    approvals.push(`${toolName} ${JSON.stringify(input).slice(0, 120)}`);
    logLine(`  ← 审批请求：${toolName}`);
    return { behavior: 'allow', updatedInput: input };
  };

  const options: Options = {
    cwd: workspace,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    includePartialMessages: true,
    permissionMode: 'default',
    canUseTool,
    model: MODEL_ID,
    env: baseEnv,
  };

  const summary: string[] = [];
  let sessionId: string | undefined;
  let initInfo: Record<string, unknown> | undefined;

  const makePump = (stream: AsyncIterable<SDKMessage>): Pump => {
    // 用对象承载可变状态：闭包里的赋值不会被 TS 的控制流分析窄化成 null
    const state: {
      current: TurnLog | null;
      resolveResult: ((message: SDKMessage) => void) | null;
    } = { current: null, resolveResult: null };

    const finished = (async () => {
      for await (const message of stream) {
        recorder.record('in', message);
        state.current?.messages.push(message);
        if (message.type === 'system' && message.subtype === 'init') {
          initInfo = message as unknown as Record<string, unknown>;
          sessionId = message.session_id;
          logLine(`  ← system/init session_id=${message.session_id}`);
        }
        if (message.type === 'result') {
          if (state.current) state.current.result = message;
          const resolve = state.resolveResult;
          state.resolveResult = null;
          resolve?.(message);
        }
      }
    })();

    return {
      finished,
      startTurn() {
        const turn: TurnLog = { messages: [] };
        state.current = turn;
        state.resolveResult = null;
        const done = new Promise<SDKMessage>((resolve) => {
          state.resolveResult = resolve;
        });
        return { turn, done };
      },
    };
  };

  const input = createInputQueue();
  const q = query({ prompt: input.iterable, options });
  const pump = makePump(q);

  try {
    // ---------- 1 & 2. 新建会话 + 一轮含工具调用的对话 ----------
    const t1 = pump.startTurn();
    input.push('请按计划执行：列目录、读 SPEC.md、写文件、改文件，然后总结。');
    await t1.done;
    const turn1 = t1.turn;
    assertTrue(sessionId !== undefined, '没有收到 system/init，拿不到 session_id');
    assertTrue(initInfo !== undefined, '没有 init 信息');
    const tools = (initInfo['tools'] as string[] | undefined) ?? [];
    const mcpServers = initInfo['mcp_servers'] as unknown[] | undefined;
    const slashCommands = initInfo['slash_commands'] as unknown[] | undefined;
    logLine(`  init: tools=${tools.length} 个（${tools.slice(0, 8).join(', ')}…） mcp=${mcpServers?.length ?? 0} slash=${slashCommands?.length ?? 0}`);
    summary.push(`新建会话：system/init session_id=${sessionId}，tools=${tools.length} 个`);

    const assistantText = turn1.messages
      .filter((m) => m.type === 'assistant')
      .map((m) => (m as { message?: { content?: unknown[] } }).message?.content ?? [])
      .flat()
      .filter((block): block is { type: 'text'; text: string } => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
      .map((block) => block.text)
      .join('');
    logLine(`  第 1 轮 assistant 文本长度=${assistantText.length}`);
    assertTrue(assistantText.length > 0, '第 1 轮没有任何 assistant 文本');
    assertTrue(turn1.result !== undefined, '第 1 轮没有 result 消息');
    const result1 = turn1.result as unknown as { subtype?: string; is_error?: boolean };
    logLine(`  第 1 轮 result: subtype=${String(result1.subtype)} is_error=${String(result1.is_error)}`);
    assertTrue(result1.is_error !== true, '第 1 轮 result 带 is_error');

    // ---------- 3. 审批 ----------
    assertTrue(approvals.length > 0, '没有任何 canUseTool 审批回调（permissionMode=default 下 Bash/Write 应触发）');
    summary.push(`审批：canUseTool 被调用 ${approvals.length} 次（${approvals.map((a) => a.split(' ')[0]).join(', ')}）`);

    // ---------- 4. 打断一轮 ----------
    const t2 = pump.startTurn();
    input.push('再跑一轮，我这轮会中途打断你。');
    // 等到这一轮的第一个消息再打断，确保真的跑起来了
    const started = Date.now();
    while ((t2.turn.messages.length === 0) && Date.now() - started < 30_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await q.interrupt().catch((error: unknown) => logLine(`  interrupt() 抛错（按原生行为记录）：${String(error)}`));
    await t2.done;
    const turn2 = t2.turn;
    const result2 = turn2.result as unknown as { subtype?: string; is_error?: boolean } | undefined;
    logLine(`  第 2 轮 result: subtype=${String(result2?.subtype)} is_error=${String(result2?.is_error)}`);
    assertTrue(result2 !== undefined, '打断后没有收到 result 消息');
    assertTrue(result2.is_error === true || result2.subtype === 'error_during_execution', '打断后 result 应标记为错误/中断');
    summary.push(`打断：query.interrupt() → result subtype=${String(result2.subtype)} is_error=${String(result2.is_error)}`);

    // ---------- 5. 杀进程后恢复 ----------
    input.end();
    await q.close?.();
    await pump.finished.catch(() => undefined);
    logLine('已关闭第 1 个 query（相当于杀掉 SDK 子进程）');

    const resumedOptions: Options = { ...options, resume: sessionId };
    const input2 = createInputQueue();
    const q2 = query({ prompt: input2.iterable, options: resumedOptions });
    const pump2 = makePump(q2);
    const t3 = pump2.startTurn();
    input2.push('进程重启过了，这是 resume 之后的新一轮：再列一次目录确认状态还在。');
    await t3.done;
    const turn3 = t3.turn;
    const result3 = turn3.result as unknown as { subtype?: string; is_error?: boolean; session_id?: string } | undefined;
    logLine(`  第 3 轮 result: subtype=${String(result3?.subtype)} session_id=${String(result3?.session_id)}`);
    assertTrue(result3 !== undefined, 'resume 之后没有收到 result 消息');
    assertTrue(result3.is_error !== true, 'resume 之后的那一轮是错误');
    summary.push(`杀进程恢复：close() → query(resume=${sessionId}) → 新一轮 subtype=${String(result3.subtype)}`);
    input2.end();
    await q2.close?.();
    await pump2.finished.catch(() => undefined);

    // ---------- 产物 ----------
    await recorder.flush();
    await dumpMockRecords(mockRecord, 'fixtures/claude-code/mock-model-requests.jsonl');
    const unknownFile = 'fixtures/claude-code/unknown-endpoints.txt';
    const unique = [...new Set(unknownEndpoints)].sort();
    await (await import('node:fs/promises')).mkdir('fixtures/claude-code', { recursive: true });
    await (await import('node:fs/promises')).writeFile(unknownFile, `${unique.join('\n')}\n`, 'utf8');
    logLine(`Claude Code 请求过的未知端点（${unique.length} 个）：${unique.join(' | ') || '无'}`);
    summary.push(`端点探测：未知端点 ${unique.length} 个，已写入 ${unknownFile}`);
  } finally {
    await mock.close();
    await removeTempWorkspace(workspace);
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
  }

  logLine('\n=== Claude 探针通过 ===');
  for (const line of summary) logLine(`- ${line}`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`\nClaude 探针失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}
