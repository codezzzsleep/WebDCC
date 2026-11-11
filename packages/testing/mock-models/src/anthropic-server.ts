/**
 * mock-anthropic：Anthropic Messages 流式格式的脚本化假模型（SPEC 第 13 节）。
 *
 * 用途：驱动 DSH（`DEEPSEEK_BASE_URL` 指向本服务）与 Claude Code（`ANTHROPIC_BASE_URL`）。
 * 回放规则见 plan.ts：按"已收到的工具结果个数"选 plan 的第 N 项。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  JsonlRecorder,
  chunkText,
  delay,
  defaultLogger,
  readJsonBody,
  sendJson,
  startSse,
  writeSse,
  type MockLogger,
} from './http-util.js';
import { resolveStep, stepAt, type Plan, type PlanStep, type ToolDescriptor } from './plan.js';
import { HELPER_REPLY, MockControl, countAnthropic } from './mock-control.js';

export interface AnthropicMockOptions {
  plan: Plan;
  /** 控制面（请求记录、切换计划）；测试套件用 */
  control?: MockControl;
  plansDir?: string;
  port?: number;
  host?: string;
  /** 返回给客户端的模型 id */
  modelId?: string;
  log?: MockLogger;
  /** 请求/响应帧录制路径（JSONL） */
  recordPath?: string;
  /** 覆盖默认的增量大小 */
  chunkSize?: number;
}

export interface RunningMock {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

interface AnthropicToolResult {
  type: 'tool_result';
}

interface AnthropicMessage {
  role?: string;
  content?: unknown;
}

/**
 * 统计"当前这一轮"已回传的工具结果个数 → 决定回放第几步。
 *
 * 不能直接数全历史：Anthropic 格式每次请求都带上完整历史，跨轮会把上一轮的工具结果也算进来。
 * 做法是从最后一条消息往前扫，累计 tool_result，遇到一条不含 tool_result 的 user 消息
 * （即本轮的用户提示）就停。
 */
export function countToolResults(messages: readonly AnthropicMessage[] | undefined): number {
  if (!messages) return 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined || message.role !== 'user' || !Array.isArray(message.content)) continue;
    let toolResults = 0;
    for (const block of message.content) {
      if (typeof block === 'object' && block !== null && (block as AnthropicToolResult).type === 'tool_result') {
        toolResults += 1;
      }
    }
    count += toolResults;
    if (toolResults === 0) break;
  }
  return count;
}

/** 每种语义 kind 的默认入参，保证对 DSH / Claude Code 的原生工具都合法 */
export function defaultToolInput(kind: string): Record<string, unknown> {
  switch (kind) {
    case 'command':
      return { command: 'ls -la', description: '假模型：列目录' };
    case 'read':
      return { file_path: './SPEC.md' };
    case 'write':
      return { file_path: './mock-model-output.txt', content: 'written by mock model\n' };
    case 'edit':
      return {
        file_path: './mock-model-output.txt',
        old_string: 'written by mock model',
        new_string: 'edited by mock model',
      };
    case 'glob':
      return { pattern: '**/*.md' };
    case 'grep':
      return { pattern: 'WebDCC' };
    case 'todo':
      return {
        todos: [
          { content: '读 SPEC', status: 'completed', activeForm: '读 SPEC' },
          { content: '跑假模型探针', status: 'in_progress', activeForm: '跑假模型探针' },
        ],
      };
    case 'patch':
      return {
        patch: '*** Begin Patch\n*** Add File: mock-model-output.txt\n+written by mock model\n*** End Patch',
      };
    case 'ask':
      return {
        questions: [
          {
            id: 'q1',
            question: '假模型在问：是否继续？',
            header: '确认',
            options: [
              { label: '继续', description: '继续执行' },
              { label: '停止', description: '停下来' },
            ],
            multi_select: false,
          },
        ],
      };
    default:
      return {};
  }
}

let toolUseSeq = 0;

function nextToolUseId(prefix: string): string {
  toolUseSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${toolUseSeq}`;
}

async function replyHelper(res: ServerResponse, body: Record<string, unknown>, seq: number): Promise<void> {
  const model = typeof body['model'] === 'string' ? body['model'] : 'mock-anthropic-1';
  const messageId = `msg_helper_${seq}`;
  if (body['stream'] === false) {
    sendJson(res, 200, {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: HELPER_REPLY }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 4 },
    });
    return;
  }
  startSse(res);
  writeSse(res, 'message_start', {
    type: 'message_start',
    message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 1 } },
  });
  writeSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: HELPER_REPLY } });
  writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 8, output_tokens: 4 } });
  writeSse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

export function createAnthropicMock(options: AnthropicMockOptions): RunningMock {
  const log = options.log ?? defaultLogger;
  const modelId = options.modelId ?? 'mock-anthropic-1';
  const recorder = options.recordPath ? new JsonlRecorder(options.recordPath) : null;
  const chunkSize = options.chunkSize ?? 12;
  const control =
    options.control ?? new MockControl(options.plan, options.plansDir ?? 'packages/testing/mock-models/plans');
  let messageSeq = 0;

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      log('handler error', String(error));
      if (!res.headersSent) sendJson(res, 500, { type: 'error', error: { type: 'mock_error', message: String(error) } });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    log(`${method} ${url.pathname}`);

    if (method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/messages')) {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      recorder?.record({ ts: new Date().toISOString(), direction: 'request', path: url.pathname, body });
      await replyToMessages(res, body);
      return;
    }

    if (method === 'POST' && url.pathname.endsWith('/count_tokens')) {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const messages = Array.isArray(body['messages']) ? (body['messages'] as AnthropicMessage[]) : [];
      sendJson(res, 200, { input_tokens: 1024 + countToolResults(messages) });
      return;
    }

    if (url.pathname === '/__requests' && method === 'GET') {
      sendJson(res, 200, { requests: control.requests });
      return;
    }
    if (url.pathname === '/__reset' && method === 'POST') {
      control.reset();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/__plan' && method === 'POST') {
      const body = (await readJsonBody(req)) as { name?: string };
      if (typeof body.name !== 'string') {
        sendJson(res, 400, { error: 'name required' });
        return;
      }
      try {
        control.setPlan(body.name);
        sendJson(res, 200, { ok: true, name: body.name });
      } catch (error) {
        sendJson(res, 404, { error: String(error) });
      }
      return;
    }

    if (method === 'GET' && (url.pathname === '/models' || url.pathname === '/v1/models')) {
      sendJson(res, 200, {
        data: [{ id: modelId, display_name: modelId, type: 'model', created_at: '2026-01-01T00:00:00Z' }],
        has_more: false,
        first_id: modelId,
        last_id: modelId,
      });
      return;
    }

    // 未知端点：记日志并 404（SPEC 13：Claude Code 还会请求哪些端点由这里暴露）
    log('UNKNOWN endpoint', `${method} ${url.pathname}`);
    recorder?.record({ ts: new Date().toISOString(), direction: 'unknown-request', method, path: url.pathname });
    sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: `mock-anthropic has no ${method} ${url.pathname}` } });
  }

  async function replyToMessages(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const messages = Array.isArray(body['messages']) ? (body['messages'] as AnthropicMessage[]) : [];
    const tools = Array.isArray(body['tools']) ? (body['tools'] as ToolDescriptor[]) : undefined;
    const vars = countAnthropic(body);
    const toolResultCount = countToolResults(messages);
    const helper = tools === undefined || tools.length === 0;
    control.record({
      at: new Date().toISOString(),
      path: '/v1/messages',
      headers: {},
      body,
      ...(helper ? { helper: true } : {}),
    });
    if (helper) {
      await replyHelper(res, body, messageSeq);
      return;
    }
    const resolvedStep = resolveStep(control.currentPlan as Plan, toolResultCount, tools);
    const step: PlanStep = resolvedStep.step;
    const toolName = resolvedStep.toolName;
    if (step.tool !== undefined && toolName === undefined) {
      const last = control.requests.at(-1);
      if (last !== undefined) last.failed = true;
      log('工具不匹配：计划需要', step.tool.kind);
      sendJson(res, 500, {
        type: 'error',
        error: { type: 'mock_tool_mismatch', message: `plan wants tool kind ${step.tool.kind} but request has none` },
      });
      return;
    }
    const requestModel = typeof body['model'] === 'string' ? body['model'] : modelId;

    messageSeq += 1;
    const messageId = `msg_mock_${String(messageSeq).padStart(4, '0')}`;
    const stopReason = step.stopReason ?? (toolName ? 'tool_use' : 'end_turn');
    const toolUseId = nextToolUseId('toolu_mock');
    const toolInput = { ...defaultToolInput(resolvedStep.kind ?? step.tool?.kind ?? 'other'), ...(resolvedStep.toolInput ?? {}) };

    if (!toolName && step.tool) {
      log('plan wants a tool but request has no matching tool', step.tool.kind);
    }

    const stream = body['stream'] !== false;
    recorder?.record({
      ts: new Date().toISOString(),
      direction: 'reply',
      stepIndex: toolResultCount,
      toolResultCount,
      toolName,
      stopReason,
      stream,
    });

    if (!stream) {
      const content: unknown[] = [];
      if (step.thinking) content.push({ type: 'thinking', thinking: control.render(step.thinking, vars), signature: 'mock-signature' });
      if (step.text) content.push({ type: 'text', text: control.render(step.text, vars) });
      if (toolName) content.push({ type: 'tool_use', id: toolUseId, name: toolName, input: toolInput });
      sendJson(res, 200, {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: requestModel,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 128, output_tokens: 32 },
      });
      return;
    }

    startSse(res);
    writeSse(res, 'message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: requestModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 128, output_tokens: 1 },
      },
    });

    const stepDelay = step.chunkDelayMs ?? 0;
    let index = 0;

    if (step.thinking) {
      const blockIndex = index++;
      writeSse(res, 'content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'thinking', thinking: '' },
      });
      for (const chunk of chunkText(control.render(step.thinking, vars), chunkSize)) {
        await delay(stepDelay);
        writeSse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'thinking_delta', thinking: chunk },
        });
      }
      writeSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'signature_delta', signature: 'bW9jay1zaWduYXR1cmU=' },
      });
      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
    }

    if (step.text) {
      const blockIndex = index++;
      writeSse(res, 'content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' },
      });
      for (const chunk of chunkText(control.render(step.text, vars), chunkSize)) {
        await delay(stepDelay);
        writeSse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: chunk },
        });
      }
      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
    }

    if (toolName) {
      const blockIndex = index;
      writeSse(res, 'content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'tool_use', id: toolUseId, name: toolName, input: {} },
      });
      const json = JSON.stringify(toolInput);
      for (const chunk of chunkText(json, 24)) {
        await delay(stepDelay);
        writeSse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: chunk },
        });
      }
      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
    }

    writeSse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: 128, output_tokens: 32 },
    });
    writeSse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  }

  return {
    server,
    port: options.port ?? 0,
    url: '',
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

/** 启动服务并返回真实端口 */
export async function startAnthropicMock(options: AnthropicMockOptions): Promise<RunningMock> {
  const mock = createAnthropicMock(options);
  await new Promise<void>((resolve, reject) => {
    mock.server.once('error', reject);
    mock.server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });
  const address = mock.server.address();
  if (address === null || typeof address === 'string') throw new Error('mock-anthropic: 无法确定监听端口');
  mock.port = address.port;
  mock.url = `http://${options.host ?? '127.0.0.1'}:${address.port}`;
  return mock;
}
