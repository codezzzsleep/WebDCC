/**
 * 调研脚本：Claude Code 的 "向你提问" 机制（AskUserQuestion）。
 *
 * 目的：核实 SDK 0.3.322 / CLI 2.1.322 下，模型调用 AskUserQuestion 时
 *   1) 是否走 canUseTool 审批通道？入参长什么样？
 *   2) 是否走 onUserDialog / request_user_dialog？需要声明 supportedDialogKinds 吗？
 *   3) 用户答案怎么回给模型？tool_result 的 content / tool_use_result 是什么？
 *   4) permissionMode = dontAsk / auto 下行为差异。
 *
 * 全流程用 mock-anthropic 假模型，临时 CLAUDE_CONFIG_DIR 与临时工作区。
 *
 * 用法：npx tsx scripts/research-claude-question.ts
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  query,
  type CanUseTool,
  type OnUserDialog,
  type Options,
  type PermissionMode,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { startAnthropicMock } from '../packages/testing/mock-models/src/anthropic-server.js';
import type { Plan } from '../packages/testing/mock-models/src/plan.js';
import { createTempWorkspace, logLine, removeTempWorkspace } from './lib/fixtures.js';

const MODEL_ID = 'mock-anthropic-1';

// ---------------------------------------------------------------------------
// 假模型计划里要问的两个问题（一个单选、一个多选），用 Claude 原生字段名。
// ---------------------------------------------------------------------------
const Q1 = '要用哪个库做日期格式化？';
const Q2 = '要启用哪些能力？';

const QUESTIONS = [
  {
    question: Q1,
    header: 'Library',
    options: [
      { label: 'date-fns', description: '函数式，按需引入' },
      { label: 'dayjs', description: '体积小，API 接近 moment' },
    ],
    multiSelect: false,
  },
  {
    question: Q2,
    header: 'Features',
    options: [
      { label: 'i18n', description: '多语言' },
      { label: 'timezone', description: '时区' },
      { label: 'iso', description: 'ISO 周' },
    ],
    multiSelect: true,
  },
];

/** 用户的选择：单选给字符串，多选给字符串数组（看 CLI 怎么处理） */
const ANSWERS: Record<string, string | string[]> = {
  [Q1]: 'dayjs',
  [Q2]: ['i18n', 'timezone'],
};

// ---------------------------------------------------------------------------
// 输入队列 / pump：抄自 scripts/probe-claude.ts 的写法（不能对 Query 用 for-await break）
// ---------------------------------------------------------------------------
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

interface RunSpec {
  id: string;
  port: number;
  permissionMode: PermissionMode;
  /** 是否提供 canUseTool */
  canUseTool: boolean;
  /** 用户决策策略 */
  decision: Decision;
  /** 是否挂 onUserDialog 并声明 dialog kinds */
  userDialog: boolean;
}

type Decision =
  | 'answer'
  | 'deny'
  /** 允许但没有 answers（模拟"用户直接关掉卡片"） */
  | 'allow-no-answers'
  /** 部分回答 + annotations.unanswered（新能力 ask_user_question_unanswered_v1） */
  | 'answer-with-unanswered'
  /** 答案里带一个不存在的题（测严格校验） */
  | 'answer-unknown-key'
  /** 自由文本答案（不是 options 里的 label） */
  | 'answer-custom-text'
  /** 拒绝并中断本轮 */
  | 'deny-interrupt'
  /** updatedInput 里不带 questions（只回 answers） */
  | 'answer-without-questions'
  /** updatedInput 里改动了 questions（测"答案不得改动调用入参"） */
  | 'answer-altered-question';

interface RunResult {
  id: string;
  permissionMode: string;
  decision: string;
  canUseToolCalls: { toolName: string; input: unknown; optionKeys?: string[]; options: unknown }[];
  userDialogCalls: { dialogKind: string; payload: unknown; toolUseID?: string }[];
  /** 第一次 /v1/messages 请求的顶层键与工具名 */
  firstRequestKeys: string[];
  requestTools: string[];
  firstToolsDebug?: unknown;
  /** 每个 /v1/messages 请求的摘要（工具数、消息数、system 前缀） */
  requestSummaries?: { index: number; tools: number; messages: number; systemPrefix: string; toolNames: string[] }[];
  /** init.tools / capabilities */
  initTools: string[];
  capabilities: string[];
  /** 模型发起的工具调用 */
  toolUses: { name: string; id: string; input: unknown }[];
  /** 模型侧看到的 tool_result（来自 mock 录到的下一次请求） */
  toolResults: { tool_use_id: string; is_error?: boolean; content: unknown }[];
  /** SDK 回给宿主的 user 消息里的 tool_use_result（结构化输出） */
  toolUseResults: { tool_use_id: string | null; value: unknown }[];
  /** 一轮的最终 result 消息要点 */
  result?: { subtype?: string; is_error?: boolean; num_turns?: number; result?: string };
  /** system 消息：subtype + 有用字段 */
  systemEvents: { subtype: string; detail?: unknown }[];
  /** 全流程消息类型序列 */
  messageSequence: string[];
  /** 面向前台的要点 */
  notes: string[];
  error?: string;
}

function makePlan(): Plan {
  return [
    {
      thinking: '模型决定先问用户，再回答。',
      tool: { kind: 'ask', name: 'AskUserQuestion', input: { questions: QUESTIONS } },
    },
    { text: '收到用户回答，继续。', stopReason: 'end_turn' },
  ];
}

function summarizeMessages(messages: SDKMessage[]): {
  toolUses: RunResult['toolUses'];
  toolUseResults: RunResult['toolUseResults'];
  result: RunResult['result'];
  systemEvents: RunResult['systemEvents'];
  messageSequence: string[];
  initTools: string[];
  capabilities: string[];
} {
  const toolUses: RunResult['toolUses'] = [];
  const toolUseResults: RunResult['toolUseResults'] = [];
  const systemEvents: RunResult['systemEvents'] = [];
  const messageSequence: string[] = [];
  let initTools: string[] = [];
  let capabilities: string[] = [];
  let result: RunResult['result'];

  for (const message of messages) {
    const kind = `${message.type}${'subtype' in message && message.subtype ? `/${String(message.subtype)}` : ''}`;
    messageSequence.push(kind);
    if (message.type === 'system') {
      const sys = message as unknown as Record<string, unknown>;
      const detail: Record<string, unknown> = {};
      for (const key of ['subtype', 'tool_name', 'decision', 'message', 'reason', 'tool_use_id', 'level', 'text', 'content']) {
        if (sys[key] !== undefined) detail[key] = sys[key];
      }
      if (sys['subtype'] !== 'init' && sys['subtype'] !== 'thinking_tokens') {
        // 非 init 的事件全量留一份，方便看 informational/permission_denied 的字段
        detail['__all'] = sys;
      }
      if (sys['subtype'] === 'init') {
        initTools = (sys['tools'] as string[] | undefined) ?? [];
        capabilities = (sys['capabilities'] as string[] | undefined) ?? [];
      }
      systemEvents.push({ subtype: String(sys['subtype']), detail });
    }
    if (message.type === 'assistant') {
      const content = (message as unknown as { message?: { content?: unknown[] } }).message?.content ?? [];
      for (const block of content) {
        const b = block as { type?: string; name?: string; id?: string; input?: unknown };
        if (b.type === 'tool_use' && typeof b.name === 'string') {
          toolUses.push({ name: b.name, id: String(b.id), input: b.input });
        }
      }
    }
    if (message.type === 'user') {
      const user = message as unknown as { tool_use_result?: unknown; message?: { content?: unknown[] } };
      if (user.tool_use_result !== undefined) {
        // 找到这条 user 消息里 tool_result 的 tool_use_id，便于和 toolResults 对上
        const content = user.message?.content ?? [];
        let id: string | null = null;
        for (const block of content) {
          const b = block as { type?: string; tool_use_id?: string };
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') id = b.tool_use_id;
        }
        toolUseResults.push({ tool_use_id: id, value: user.tool_use_result });
      }
    }
    if (message.type === 'result') {
      const r = message as unknown as RunResult['result'];
      result = { subtype: r?.subtype, is_error: r?.is_error, num_turns: r?.num_turns, result: r?.result };
    }
  }
  return { toolUses, toolUseResults, result, systemEvents, messageSequence, initTools, capabilities };
}

interface Records {
  firstRequestKeys: string[];
  requestTools: string[];
  firstToolsDebug: unknown;
  requestSummaries: NonNullable<RunResult['requestSummaries']>;
  toolResults: RunResult['toolResults'];
}

/** 从 mock 录制的请求里取第一次请求的顶层键 / tools，以及后续请求里的 tool_result */
function extractFromRecords(raw: string): Records {
  const records = raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { direction?: string; body?: Record<string, unknown> });
  const requests = records.filter((r) => r.direction === 'request' && r.body);

  let requestTools: string[] = [];
  let firstRequestKeys: string[] = [];
  let firstToolsDebug: unknown = undefined;
  const first = requests[0]?.body;
  if (first) {
    firstRequestKeys = Object.keys(first);
    const tools = first['tools'];
    firstToolsDebug = {
      type: Array.isArray(tools) ? 'array' : typeof tools,
      length: Array.isArray(tools) ? tools.length : undefined,
      sample: Array.isArray(tools) ? tools.slice(0, 2) : tools,
    };
    if (Array.isArray(tools)) {
      requestTools = tools
        .map((t) => (t as { name?: string }).name)
        .filter((n): n is string => typeof n === 'string');
    }
  }

  const requestSummaries: NonNullable<RunResult['requestSummaries']> = requests.map((request, index) => {
    const body = request.body ?? {};
    const tools = Array.isArray(body['tools']) ? (body['tools'] as { name?: string }[]) : [];
    const messages = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : [];
    const system = body['system'];
    const systemText = typeof system === 'string'
      ? system
      : Array.isArray(system)
        ? system.map((b) => (b as { text?: string }).text ?? '').join(' ')
        : '';
    return {
      index,
      tools: tools.length,
      messages: messages.length,
      systemPrefix: systemText.slice(0, 80),
      toolNames: tools.map((t) => t.name).filter((n): n is string => typeof n === 'string'),
    };
  });

  const toolResults: RunResult['toolResults'] = [];
  for (const request of requests) {
    const messages = Array.isArray(request.body?.['messages']) ? (request.body?.['messages'] as unknown[]) : [];
    for (const m of messages) {
      const content = (m as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          if (!toolResults.some((t) => t.tool_use_id === b.tool_use_id)) {
            toolResults.push({ tool_use_id: b.tool_use_id, is_error: b.is_error, content: b.content });
          }
        }
      }
    }
  }
  return { firstRequestKeys, requestTools, firstToolsDebug, requestSummaries, toolResults };
}

async function runOne(spec: RunSpec): Promise<RunResult> {
  const recordPath = join(tmpdir(), `wdcc-q-${spec.id}-${Date.now().toString(36)}.jsonl`);
  const unknownEndpoints: string[] = [];
  const mock = await startAnthropicMock({
    plan: makePlan(),
    port: spec.port,
    modelId: MODEL_ID,
    recordPath,
    log: (line, extra) => {
      if (line === 'UNKNOWN endpoint') unknownEndpoints.push(String(extra));
    },
  });
  const workspace = await createTempWorkspace(`claude-q-${spec.id}`);
  const configDir = await mkdtemp(join(tmpdir(), 'wdcc-claude-q-config-'));

  const canUseToolCalls: RunResult['canUseToolCalls'] = [];
  const userDialogCalls: RunResult['userDialogCalls'] = [];
  const notes: string[] = [];
  const messages: SDKMessage[] = [];

  try {
    const baseEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ANTHROPIC_BASE_URL: mock.url,
      ANTHROPIC_API_KEY: 'mock-key-not-a-secret',
      ANTHROPIC_AUTH_TOKEN: 'mock-token-not-a-secret',
      CLAUDE_CONFIG_DIR: configDir,
    };

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      canUseToolCalls.push({
        toolName,
        input,
        optionKeys: Object.keys(options ?? {}),
        options: {
          decisionReason: options.decisionReason,
          title: options.title,
          displayName: options.displayName,
          description: options.description,
          toolUseID: (options as unknown as { toolUseID?: string }).toolUseID,
          requestId: (options as unknown as { requestId?: string }).requestId,
          requiresUserInteraction: (options as unknown as { requiresUserInteraction?: boolean }).requiresUserInteraction,
          agentID: (options as unknown as { agentID?: string }).agentID,
          defaultToNo: options.defaultToNo,
          suggestions: options.suggestions?.length ?? 0,
        },
      });
      notes.push(`canUseTool(${toolName}) 被调用`);
      if (toolName !== 'AskUserQuestion') {
        return { behavior: 'allow', updatedInput: input };
      }
      switch (spec.decision) {
        case 'deny':
          return { behavior: 'deny', message: '用户取消了这次提问（WebDCC 调研脚本）' };
        case 'allow-no-answers':
          return { behavior: 'allow', updatedInput: input };
        case 'answer-with-unanswered':
          return {
            behavior: 'allow',
            updatedInput: {
              ...input,
              answers: { [Q1]: 'dayjs' },
              annotations: { [Q2]: { unanswered: 'skipped' } },
            },
          };
        case 'answer-unknown-key':
          return {
            behavior: 'allow',
            updatedInput: {
              ...input,
              answers: { ...ANSWERS, 这道题不存在: 'x' },
            },
          };
        case 'deny-interrupt':
          return { behavior: 'deny', message: '用户关闭了提问卡片', interrupt: true };
        case 'answer-without-questions':
          return { behavior: 'allow', updatedInput: { answers: ANSWERS } };
        case 'answer-altered-question':
          return {
            behavior: 'allow',
            updatedInput: {
              ...input,
              questions: [
                { ...QUESTIONS[0], question: '被改写的问题？' },
                QUESTIONS[1],
              ],
              answers: ANSWERS,
            },
          };
        case 'answer-custom-text':
          return {
            behavior: 'allow',
            updatedInput: {
              ...input,
              answers: { [Q1]: '用 Temporal，别用这两个库', [Q2]: ['i18n'] },
            },
          };
        case 'answer':
        default:
          return {
            behavior: 'allow',
            updatedInput: {
              ...input,
              answers: ANSWERS,
              annotations: { [Q1]: { notes: '选 dayjs 因为体积小' } },
            },
          };
      }
    };

    const onUserDialog: OnUserDialog = async (request, options) => {
      userDialogCalls.push({ dialogKind: request.dialogKind, payload: request.payload, toolUseID: request.toolUseID });
      notes.push(`onUserDialog(${request.dialogKind}) 被调用 requestId=${options.requestId}`);
      if (spec.decision === 'deny') return { behavior: 'cancelled' };
      const payload = request.payload as { questions?: unknown };
      return {
        behavior: 'completed',
        result: {
          behavior: 'allow',
          updatedInput: { questions: payload.questions ?? QUESTIONS, answers: ANSWERS },
        },
      };
    };

    const options: Options = {
      cwd: workspace,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: false,
      permissionMode: spec.permissionMode,
      model: MODEL_ID,
      env: baseEnv,
      ...(spec.canUseTool ? { canUseTool } : {}),
      ...(spec.userDialog
        ? { onUserDialog, supportedDialogKinds: ['permission_ask_user_question', 'refusal_fallback_prompt'] }
        : {}),
    };

    const input = createInputQueue();
    const q = query({ prompt: input.iterable, options });

    const finished = (async () => {
      for await (const message of q) messages.push(message);
    })();

    const done = (async () => {
      const started = Date.now();
      while (Date.now() - started < 90_000) {
        if (messages.some((m) => m.type === 'result')) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      notes.push('超时：90s 内没有收到 result（可能卡在问题/审批上）');
    })();

    input.push('帮我确认两个选择，然后继续。');
    await done;
    input.end();
    // 注意：close() 在本版本可能不存在，按 probe-claude 的写法直接 await（不要接 .catch）
    await q.close?.();
    await finished.catch(() => undefined);

    const summary = summarizeMessages(messages);
    const raw = await readFile(recordPath, 'utf8').catch(() => '');
    const extracted: Records = raw
      ? extractFromRecords(raw)
      : { firstRequestKeys: [], requestTools: [], firstToolsDebug: undefined, requestSummaries: [], toolResults: [] };

    if (unknownEndpoints.length > 0) notes.push(`未知端点：${unknownEndpoints.join(' | ')}`);
    notes.push(`请求里的工具数=${extracted.requestTools.length}，含 AskUserQuestion=${extracted.requestTools.includes('AskUserQuestion')}`);
    if (extracted.toolResults.length === 0) notes.push('没有录到 tool_result：模型可能没跑完一轮');

    return {
      id: spec.id,
      permissionMode: spec.permissionMode,
      decision: spec.decision,
      canUseToolCalls,
      userDialogCalls,
      requestTools: extracted.requestTools,
      firstRequestKeys: extracted.firstRequestKeys,
      firstToolsDebug: extracted.firstToolsDebug,
      requestSummaries: extracted.requestSummaries,
      toolResults: extracted.toolResults,
      notes,
      ...summary,
    };
  } catch (error) {
    return {
      id: spec.id,
      permissionMode: spec.permissionMode,
      decision: spec.decision,
      canUseToolCalls,
      userDialogCalls,
      firstRequestKeys: [],
      requestTools: [],
      initTools: [],
      capabilities: [],
      toolUses: [],
      toolResults: [],
      toolUseResults: [],
      systemEvents: [],
      messageSequence: [],
      notes,
      error: String(error),
    };
  } finally {
    await mock.close();
    await removeTempWorkspace(workspace);
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(recordPath, { force: true }).catch(() => undefined);
  }
}


/**
 * 边界：提问挂起（canUseTool 不 resolve）时调用 interrupt()。
 * 关注 options.signal 是否 abort、是否收到 result、模型看到什么。
 */
async function runInterruptCase(): Promise<Record<string, unknown>> {
  const recordPath = join(tmpdir(), `wdcc-q-interrupt-${Date.now().toString(36)}.jsonl`);
  const mock = await startAnthropicMock({
    plan: makePlan(),
    port: 4130,
    modelId: MODEL_ID,
    recordPath,
  });
  const workspace = await createTempWorkspace('claude-q-interrupt');
  const configDir = await mkdtemp(join(tmpdir(), 'wdcc-claude-q-config-'));
  const messages: SDKMessage[] = [];
  const observed: Record<string, unknown> = { called: false };

  try {
    const options: Options = {
      cwd: workspace,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      permissionMode: 'default',
      model: MODEL_ID,
      env: {
        ...(process.env as Record<string, string>),
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: 'mock-key-not-a-secret',
        ANTHROPIC_AUTH_TOKEN: 'mock-token-not-a-secret',
        CLAUDE_CONFIG_DIR: configDir,
      },
      canUseTool: async (toolName, input, canOpts) => {
        observed['called'] = true;
        observed['toolName'] = toolName;
        observed['toolUseID'] = (canOpts as unknown as { toolUseID?: string }).toolUseID;
        if (toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
        // 故意不 resolve：模拟"用户把提问卡片晾在那里"
        return new Promise<never>(() => {
          canOpts.signal.addEventListener('abort', () => {
            observed['signalAborted'] = true;
            observed['abortReason'] = String((canOpts.signal as unknown as { reason?: unknown }).reason);
          });
        });
      },
    };

    const input = createInputQueue();
    const q = query({ prompt: input.iterable, options });
    const finished = (async () => {
      for await (const m of q) messages.push(m);
    })();

    input.push('先问我一个问题。');

    // 等 canUseTool 被调用（最多 30s）
    const t0 = Date.now();
    while (observed['called'] !== true && Date.now() - t0 < 30_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    observed['canUseToolCalled'] = observed['called'] === true;
    await new Promise((r) => setTimeout(r, 500));
    const interruptStarted = Date.now();
    await q.interrupt().catch((error: unknown) => {
      observed['interruptError'] = String(error);
    });
    observed['interruptTookMs'] = Date.now() - interruptStarted;

    // 等 result（最多 30s）
    const t1 = Date.now();
    while (!messages.some((m) => m.type === 'result') && Date.now() - t1 < 30_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const result = messages.find((m) => m.type === 'result') as unknown as Record<string, unknown> | undefined;
    observed['result'] = result
      ? { subtype: result['subtype'], is_error: result['is_error'], result: result['result'] }
      : '（30s 内没有 result）';
    observed['signalAborted'] = observed['signalAborted'] === true;

    input.end();
    await q.close?.();
    await finished.catch(() => undefined);

    const raw = await readFile(recordPath, 'utf8').catch(() => '');
    observed['toolResults'] = raw ? extractFromRecords(raw).toolResults : [];
    return observed;
  } catch (error) {
    observed['error'] = String(error);
    return observed;
  } finally {
    await mock.close();
    await removeTempWorkspace(workspace);
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(recordPath, { force: true }).catch(() => undefined);
  }
}

const RUNS: RunSpec[] = [
  { id: 'default-answer', port: 4121, permissionMode: 'default', canUseTool: true, decision: 'answer', userDialog: true },
  { id: 'default-deny', port: 4122, permissionMode: 'default', canUseTool: true, decision: 'deny', userDialog: false },
  { id: 'no-canusetool', port: 4123, permissionMode: 'default', canUseTool: false, decision: 'answer', userDialog: false },
  { id: 'dontAsk', port: 4124, permissionMode: 'dontAsk', canUseTool: true, decision: 'answer', userDialog: false },
  { id: 'auto', port: 4125, permissionMode: 'auto', canUseTool: true, decision: 'answer', userDialog: false },
  { id: 'allow-no-answers', port: 4126, permissionMode: 'default', canUseTool: true, decision: 'allow-no-answers', userDialog: false },
  { id: 'answer-unanswered', port: 4127, permissionMode: 'default', canUseTool: true, decision: 'answer-with-unanswered', userDialog: false },
  { id: 'answer-unknown-key', port: 4128, permissionMode: 'default', canUseTool: true, decision: 'answer-unknown-key', userDialog: false },
  { id: 'answer-custom-text', port: 4129, permissionMode: 'default', canUseTool: true, decision: 'answer-custom-text', userDialog: false },
  { id: 'answer-without-questions', port: 4131, permissionMode: 'default', canUseTool: true, decision: 'answer-without-questions', userDialog: false },
  { id: 'answer-altered-question', port: 4132, permissionMode: 'default', canUseTool: true, decision: 'answer-altered-question', userDialog: false },
  { id: 'plan-mode', port: 4133, permissionMode: 'plan', canUseTool: true, decision: 'answer', userDialog: false },
  { id: 'acceptEdits-mode', port: 4134, permissionMode: 'acceptEdits', canUseTool: true, decision: 'answer', userDialog: false },
  { id: 'deny-interrupt', port: 4135, permissionMode: 'default', canUseTool: true, decision: 'deny-interrupt', userDialog: false },
];

async function main(): Promise<void> {
  const only = process.argv[2];
  const results: RunResult[] = [];
  for (const spec of RUNS.filter((r) => only === undefined || r.id === only)) {
    logLine(`\n===== 运行 ${spec.id}（permissionMode=${spec.permissionMode}，decision=${spec.decision}）=====`);
    const result = await runOne(spec);
    results.push(result);
    logLine(`消息序列：${result.messageSequence.join(' → ') || '（空）'}`);
    logLine(`canUseTool 调用：${result.canUseToolCalls.map((c) => c.toolName).join(', ') || '（无）'}`);
    logLine(`onUserDialog 调用：${result.userDialogCalls.map((c) => c.dialogKind).join(', ') || '（无）'}`);
    logLine(`tool_result（模型看到的内容）：${JSON.stringify(result.toolResults)}`);
    logLine(`tool_use_result（SDK 给宿主的结构化输出）：${JSON.stringify(result.toolUseResults)}`);
    logLine(`system 事件：${result.systemEvents.filter((e) => e.subtype !== 'thinking_tokens').map((e) => e.subtype).join(', ') || '（无）'}`);
    if (result.error) logLine(`错误：${result.error}`);
  }

  let interruptCase: Record<string, unknown> = {};
  if (only === undefined) {
    logLine('\n===== 运行 interrupt-pending（提问挂起时打断）=====');
    interruptCase = await runInterruptCase();
    logLine(`interrupt 结果：${JSON.stringify(interruptCase)}`);
  }

  const out = join(process.cwd(), 'fixtures/claude-code/question-research.json');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(process.cwd(), 'fixtures/claude-code'), { recursive: true });
  if (only !== undefined) {
    const prev = JSON.parse(await readFile(out, 'utf8').catch(() => '{"runs":[],"interrupt":{}}')) as {
      runs?: RunResult[];
      interrupt?: Record<string, unknown>;
    };
    const merged = (prev.runs ?? []).filter((r) => !results.some((n) => n.id === r.id));
    await writeFile(out, JSON.stringify({ runs: [...merged, ...results], interrupt: prev.interrupt ?? {} }, null, 2), 'utf8');
  } else {
    await writeFile(out, JSON.stringify({ runs: results, interrupt: interruptCase }, null, 2), 'utf8');
  }
  logLine(`\n完整结果已写入 ${out}`);
}

try {
  await main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`调研脚本失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
}
