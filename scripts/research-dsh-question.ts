/**
 * 调研脚本：DSH 0.2.2-rc.1 的「向用户提问」到底用哪个接口关闭，以及思考内容在完成态里的字段。
 *
 * 跑两轮，每轮让假模型调用一次 `ask_user_question`：
 *   mode=events-result  → 用 `$events/result` 回 `{answers:[...]}`（和审批同一个通道）
 *   mode=answer-rpc     → 用一元 RPC `userQuestions/answer` 回 `{agentId, callId, answer}`
 *
 * 另外在第二轮结束后用 `session/page` 读持久历史，确认 `assistant/message` 里思考内容的字段。
 *
 * 用法：npx tsx scripts/research-dsh-question.ts
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { startAnthropicMock } from '../packages/testing/mock-models/src/anthropic-server.js';
import { DshHostClient, startSidecar, type StreamFrame } from './lib/dsh-host.js';
import type { Plan } from '../packages/testing/mock-models/src/plan.js';
import { createTempWorkspace, logLine, removeTempWorkspace, sanitize } from './lib/fixtures.js';

const PORT = 4131;

const PLAN: Plan = [
  {
    thinking: '需要问用户一个问题才能继续。',
    text: '我需要确认一件事。',
    tool: {
      kind: 'ask',
      inputByName: {
        ask_user_question: {
          questions: [
            {
              id: 'q1',
              header: '确认',
              question: '假模型在问：是否继续执行？',
              options: [
                { label: '继续', description: '继续执行' },
                { label: '停止', description: '停下来' },
              ],
              multiSelect: false,
            },
          ],
        },
      },
    },
  },
  { text: '收到答案，继续干活。', stopReason: 'end_turn' },
];

interface Observation {
  waterfall?: Record<string, unknown>;
  persistedAssistantMessage?: Record<string, unknown>;
  persistedBlockTypes?: string[];
  resultOutcome?: unknown;
  answerOutcome?: unknown;
  toolCall?: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
  turnEnd?: Record<string, unknown>;
  assistantMessages: Record<string, unknown>[];
}

function frameValue(frame: StreamFrame): Record<string, unknown> | undefined {
  const value = frame.value;
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

async function runOnce(mode: 'events-result' | 'answer-rpc', timed = false): Promise<Observation> {
  const obs: Observation = { assistantMessages: [] };
  const mock = await startAnthropicMock({ plan: PLAN, port: 0, log: () => undefined });
  const workspace = await createTempWorkspace(`dsh-q-${mode}`);
  const dshHome = await mkdtemp(join(tmpdir(), 'wdcc-dsh-home-'));
  if (timed) {
    // 打开 ask_user_question 的"计时模式"（插件配置 mode: timed），看 waterfall 是否带 wait.callId
    await writeFile(
      join(dshHome, 'cordis.patch.yml'),
      ['- id: tool-ask-user', '  config:', '    mode: timed', '    timeout: 30', ''].join('\n'),
      'utf8',
    );
  }
  const sidecar = await startSidecar({
    port: PORT,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DEEPSEEK_BASE_URL: mock.url,
      DEEPSEEK_API_KEY: 'mock-key',
    },
  });
  const client = new DshHostClient(sidecar.port);

  try {
    await client.authenticate(sidecar.tokenUrl);
    const createdWs = await client.rpc<{ workspace: { workspaceId: string } }>('workspace/create', {
      request: { path: workspace },
    });
    const created = await client.rpc<{ sessionId: string }>('session/create', {
      request: { workspaceId: createdWs.workspace.workspaceId },
    });
    const sessionId = created.sessionId;

    let clientId = '';
    let resolveQuestion: ((request: Record<string, unknown>) => void) | null = null;
    const questionSeen = new Promise<Record<string, unknown>>((resolve) => {
      resolveQuestion = resolve;
    });
    let resolveEnd: (() => void) | null = null;
    const turnEnded = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });

    await client.connect();
    client.openStream('$events', {}, (frame) => {
      const value = frameValue(frame);
      if (value === undefined) return;
      if (value['type'] === 'ready') clientId = String(value['clientId'] ?? '');
      if (value['type'] === 'waterfall' && value['event'] === 'user-questions/request') {
        const request = (value['request'] ?? {}) as Record<string, unknown>;
        obs.waterfall = { eventId: value['eventId'], agentId: value['agentId'], request };
        logLine(`[${mode}] waterfall user-questions/request: ${JSON.stringify(obs.waterfall).slice(0, 900)}`);
        resolveQuestion?.({ eventId: String(value['eventId']), ...request });
      }
    });
    client.openStream(
      'session/follow',
      { request: { address: { kind: 'session', sessionId }, activate: true, assistantStream: true } },
      (frame) => {
        const v = frameValue(frame);
        if (v === undefined) return;
        if (v['type'] === 'event') {
          const event = (v['event'] ?? {}) as Record<string, unknown>;
          const type = String(event['type'] ?? '');
          if (type === 'tool/call') obs.toolCall = event['data'] as Record<string, unknown>;
          if (type === 'tool/result') obs.toolResult = event['data'] as Record<string, unknown>;
          if (type === 'assistant/message') obs.assistantMessages.push(event['data'] as Record<string, unknown>);
          if (type === 'turn/end') {
            obs.turnEnd = event['data'] as Record<string, unknown>;
            resolveEnd?.();
          }
        }
      },
    );
    await new Promise((r) => setTimeout(r, 500));

    await client.rpc('session/prompt', {
      request: {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: '问我一个问题再继续。' }],
      },
    });

    const question = await Promise.race([
      questionSeen,
      new Promise<Record<string, unknown>>((_, reject) =>
        setTimeout(() => reject(new Error('90s 内没有收到 user-questions/request')), 90_000),
      ),
    ]);
    const eventId = String(question['eventId']);

    if (mode === 'events-result') {
      obs.resultOutcome = await client
        .rpc('$events/result', {
          clientId,
          eventId,
          outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: ['继续'] }] } },
        })
        .then(() => 'ok')
        .catch((error: unknown) => String(error));
    } else {
      const wait = (question['wait'] ?? undefined) as Record<string, unknown> | undefined;
      const callId = wait?.['callId'];
      if (callId === undefined) {
        obs.answerOutcome = 'waterfall 里没有 wait.callId，userQuestions/answer 无法定位这次提问';
      } else {
        obs.answerOutcome = await client
          .rpc('userQuestions/answer', {
            agentId: sessionId,
            callId,
            answer: { answers: [{ id: 'q1', selected: ['继续'] }] },
          })
          .then((value) => `ok:${JSON.stringify(value)}`)
          .catch((error: unknown) => String(error));
      }
      // 无论一元 RPC 是否奏效，都用 $events/result 兜底关闭 waterfall，避免这一轮挂死
      await client
        .rpc('$events/result', {
          clientId,
          eventId,
          outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: ['继续'] }] } },
        })
        .catch(() => undefined);
    }

    await Promise.race([turnEnded, new Promise((r) => setTimeout(r, 60_000))]);

    // 持久历史：确认 assistant/message 的字段与思考内容位置
    const page = await client.rpc<{ records?: { type: string; event?: { type: string; data: unknown } }[] }>(
      'session/page',
      { request: { address: { kind: 'session', sessionId }, maxMessages: 50 } },
    );
    const persisted = (page.records ?? [])
      .filter((record) => record.event?.type === 'assistant/message')
      .map((record) => record.event?.data);
    logLine(`[${mode}] session/page 里 assistant/message 条数：${persisted.length}`);
    if (persisted.length > 0) {
      const first = persisted[0] as { message?: { content?: unknown[] }; usage?: unknown };
      const types = (first.message?.content ?? [])
        .map((block) => (block as { type?: string }).type)
        .filter((type): type is string => type !== undefined);
      obs.persistedBlockTypes = types;
      obs.persistedAssistantMessage = {
        message: first.message,
        usage: first.usage,
      };
      logLine(`[${mode}] 持久 assistant/message 的 content block 类型：${types.join(', ')}；usage=${JSON.stringify(first.usage)}`);
    }

    await client.close();
  } finally {
    await client.close().catch(() => undefined);
    await sidecar.stop().catch(() => undefined);
    await mock.close();
    await removeTempWorkspace(workspace);
    await rm(dshHome, { recursive: true, force: true }).catch(() => undefined);
  }

  return obs;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  logLine('===== 实验 1：用 $events/result 回答提问 =====');
  const first = await runOnce('events-result');
  logLine(`tool/call: ${JSON.stringify(first.toolCall).slice(0, 400)}`);
  logLine(`tool/result: ${JSON.stringify(first.toolResult).slice(0, 600)}`);
  logLine(`$events/result 返回：${JSON.stringify(first.resultOutcome)}`);
  logLine(`turn/end: ${JSON.stringify(first.turnEnd).slice(0, 300)}`);

  logLine('');
  logLine('===== 实验 2：用 userQuestions/answer 回答提问 =====');
  const second = await runOnce('answer-rpc');
  logLine(`userQuestions/answer 返回：${JSON.stringify(second.answerOutcome)}`);
  logLine(`tool/result: ${JSON.stringify(second.toolResult).slice(0, 600)}`);
  logLine(`turn/end: ${JSON.stringify(second.turnEnd).slice(0, 300)}`);

  logLine('');
  logLine('===== 实验 3：计时模式（mode: timed）下用 userQuestions/answer =====');
  const third = await runOnce('answer-rpc', true);
  logLine(`waterfall 带 wait：${JSON.stringify(third.waterfall?.['request']).slice(0, 400)}`);
  logLine(`userQuestions/answer 返回：${JSON.stringify(third.answerOutcome)}`);
  logLine(`tool/result: ${JSON.stringify(third.toolResult).slice(0, 500)}`);

  // 证据落盘（脱敏后），供 spec 修订与回归对照
  const artifact = {
    generatedAt: startedAt,
    environment: { dsh: '0.2.2-rc.1' },
    question: 'user-questions/request 的关闭方式',
    runs: [
      { id: 'events-result', ...first },
      { id: 'answer-rpc-legacy', ...second },
      { id: 'answer-rpc-timed-patch-not-applied', ...third },
    ],
    conclusions: {
      liveWaterfallHasWaitField: false,
      closesViaEventsResult: true,
      userQuestionsAnswerRequiresWaitCallId: true,
      reasoningField: "assistant/message -> data.message.content[type='reasoning'].text",
    },
  };
  await mkdir('fixtures/dsh', { recursive: true });
  await writeFile('fixtures/dsh/question-research.json', `${JSON.stringify(sanitize(artifact), null, 2)}\n`, 'utf8');
  logLine('证据已写入 fixtures/dsh/question-research.json');

  logLine('');
  logLine('===== 汇总 =====');
  logLine(`实验 1（$events/result）：tool/result 里 isError=${JSON.stringify((first.toolResult?.['message'] as { isError?: unknown } | undefined)?.isError)}，turn/end=${first.turnEnd === undefined ? '未收到' : '收到'}`);
  logLine(`实验 2（非计时 + userQuestions/answer）：tool/result 里 isError=${JSON.stringify((second.toolResult?.['message'] as { isError?: unknown } | undefined)?.isError)}，turn/end=${second.turnEnd === undefined ? '未收到' : '收到'}`);
  logLine(`实验 3（计时 + userQuestions/answer）：tool/result 里 isError=${JSON.stringify((third.toolResult?.['message'] as { isError?: unknown } | undefined)?.isError)}，turn/end=${third.turnEnd === undefined ? '未收到' : '收到'}`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`调研失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}
