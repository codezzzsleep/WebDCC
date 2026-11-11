/**
 * mock-responses：OpenAI Responses API 流式格式的脚本化假模型（SPEC 第 13 节）。
 *
 * 用途：驱动 Codex 的自定义 Provider（`wire_api = "responses"`）。
 * 回放规则与 mock-anthropic 相同：按"已收到的 function_call_output 个数"选 plan 的第 N 项。
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
import { detectVariant, resolveStep, type Plan, type PlanStep, type ToolDescriptor } from './plan.js';
import { defaultToolInput } from './anthropic-server.js';
import { HELPER_REPLY, MockControl, countResponses } from './mock-control.js';

export interface ResponsesMockOptions {
  plan: Plan;
  control?: MockControl;
  plansDir?: string;
  port?: number;
  host?: string;
  modelId?: string;
  log?: MockLogger;
  recordPath?: string;
  chunkSize?: number;
}

export interface RunningResponsesMock {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

interface ResponsesInputItem {
  type?: string;
  [key: string]: unknown;
}

/**
 * 统计"当前这一轮"已回传的工具结果个数 → 回放第几步。
 * 从 input 末尾往前扫，遇到本轮的用户消息（role=user 的 message）就停。
 * code mode 下工具结果叫 `custom_tool_call_output`（SPEC-M8 6.3）。
 */
export function countFunctionCallOutputs(input: readonly ResponsesInputItem[] | undefined): number {
  if (!input) return 0;
  let count = 0;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (item === undefined) continue;
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      count += 1;
      continue;
    }
    if (item.type === 'message' && item['role'] === 'user') break;
  }
  return count;
}

/** code mode：工具放在 input[] 的 additional_tools 里（functions 命名空间下的自定义工具 exec） */
export function extractAdditionalTools(input: readonly ResponsesInputItem[] | undefined): ToolDescriptor[] | undefined {
  for (const item of input ?? []) {
    if (item.type !== 'additional_tools') continue;
    const tools = item['tools'];
    if (Array.isArray(tools)) return tools as ToolDescriptor[];
  }
  return undefined;
}

/**
 * 把一个语义步骤翻译成 code mode 的 `exec` 脚本（SPEC-M8 6.3 的对照表）。
 * 计划里可以直接写 `code`，否则按 kind 生成。
 */
export function codeModeScript(step: PlanStep, toolName: string): string {
  const explicit = step.tool?.code;
  if (explicit !== undefined) return explicit;
  const input = step.tool?.inputByName?.[toolName] ?? step.tool?.input ?? {};
  const json = JSON.stringify(input);
  switch (step.tool?.kind) {
    case 'command':
      return `const r = await tools.exec_command(${json});\ntext(JSON.stringify(r));`;
    case 'read':
      return `const r = await tools.exec_command(${JSON.stringify({ cmd: `cat ${String(input['file_path'] ?? input['path'] ?? 'README.md')}` })});\ntext(JSON.stringify(r));`;
    case 'write':
    case 'edit':
    case 'patch':
      return `await tools.apply_patch(${JSON.stringify(String(input['patch'] ?? ''))});\ntext("patched");`;
    case 'goal':
      return `const r = await tools.${toolName}(${json});\ntext(JSON.stringify(r));`;
    case 'ask':
      return `const r = await tools.request_user_input(${json});\ntext(JSON.stringify(r));`;
    case 'todo':
      return `const r = await tools.exec_command(${JSON.stringify({ cmd: 'true' })});\ntext(JSON.stringify(r));`;
    default:
      return `text(${JSON.stringify('ok')});`;
  }
}

let seq = 0;

function newId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${String(seq).padStart(4, '0')}`;
}

function emptyResponse(id: string, model: string, status: string): Record<string, unknown> {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: [],
    parallel_tool_calls: false,
    tool_choice: 'auto',
    tools: [],
    usage: null,
  };
}

function usage(): Record<string, unknown> {
  return {
    input_tokens: 128,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 32,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 160,
  };
}

function replyHelper(res: ServerResponse, body: Record<string, unknown>, fallbackModel: string): void {
  const model = typeof body['model'] === 'string' ? body['model'] : fallbackModel;
  const responseId = newId('resp');
  const item = { id: newId('msg'), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: HELPER_REPLY, annotations: [] }] };
  if (body['stream'] === false) {
    sendJson(res, 200, { ...emptyResponse(responseId, model, 'completed'), output: [item], usage: usage() });
    return;
  }
  startSse(res);
  writeSse(res, 'response.created', { type: 'response.created', response: emptyResponse(responseId, model, 'in_progress') });
  writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: item.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
  writeSse(res, 'response.content_part.added', { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  writeSse(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: HELPER_REPLY });
  writeSse(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: HELPER_REPLY });
  writeSse(res, 'response.content_part.done', { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: HELPER_REPLY, annotations: [] } });
  writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item });
  writeSse(res, 'response.completed', { type: 'response.completed', response: { ...emptyResponse(responseId, model, 'completed'), output: [item], usage: usage() } });
  res.end();
}

export function createResponsesMock(options: ResponsesMockOptions): RunningResponsesMock {
  const log = options.log ?? defaultLogger;
  const modelId = options.modelId ?? 'mock-responses-1';
  const recorder = options.recordPath ? new JsonlRecorder(options.recordPath) : null;
  const chunkSize = options.chunkSize ?? 12;
  const control =
    options.control ?? new MockControl(options.plan, options.plansDir ?? 'packages/testing/mock-models/plans');

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      log('handler error', String(error));
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(error), type: 'mock_error' } });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    log(`${method} ${url.pathname}`);

    // SPEC-M8 6.2：同时接受 /v1 与 /v2 前缀
    if (method === 'POST' && /^\/v\d+\/responses$/.test(url.pathname)) {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      recorder?.record({ ts: new Date().toISOString(), direction: 'request', path: url.pathname, body });
      await replyToResponse(res, body, url.pathname, Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : (value ?? '')])));
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

    if (method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      sendJson(res, 200, { object: 'list', data: [{ id: modelId, object: 'model', created: 1767225600, owned_by: 'mock' }] });
      return;
    }

    log('UNKNOWN endpoint', `${method} ${url.pathname}`);
    recorder?.record({ ts: new Date().toISOString(), direction: 'unknown-request', method, path: url.pathname });
    sendJson(res, 404, { error: { message: `mock-responses has no ${method} ${url.pathname}`, type: 'not_found' } });
  }

  async function replyToResponse(res: ServerResponse, body: Record<string, unknown>, urlPath: string, headers: Record<string, string>): Promise<void> {
    const input = Array.isArray(body['input']) ? (body['input'] as ResponsesInputItem[]) : undefined;
    const tools = Array.isArray(body['tools']) ? (body['tools'] as ToolDescriptor[]) : undefined;
    const additionalTools = extractAdditionalTools(input);
    const codeMode = (tools === undefined || tools.length === 0) && additionalTools !== undefined;
    const vars = countResponses(body);
    const stepIndex = countFunctionCallOutputs(input);
    const helper = !codeMode && (tools === undefined || tools.length === 0);
    control.record({
      at: new Date().toISOString(),
      path: urlPath,
      headers,
      body,
      ...(helper ? { helper: true } : {}),
    });
    if (helper) {
      replyHelper(res, body, modelId);
      return;
    }
    const variant = detectVariant('responses', tools ?? additionalTools, codeMode);
    const plan = control.planForVariant(variant);
    const resolvedStep = codeMode
      ? resolveStep(plan, stepIndex, additionalTools)
      : resolveStep(plan, stepIndex, tools);
    const step: PlanStep = resolvedStep.step;
    const requestModel = typeof body['model'] === 'string' ? body['model'] : modelId;
    if (step.tool !== undefined && resolvedStep.toolName === undefined) {
      const last = control.requests.at(-1);
      if (last !== undefined) last.failed = true;
      log('工具不匹配：计划需要', step.tool.kind);
      sendJson(res, 500, { error: { type: 'mock_tool_mismatch', message: `plan wants tool kind ${step.tool.kind} but request has none` } });
      return;
    }
    const toolName = resolvedStep.toolName;
    const toolInput = { ...defaultToolInput(resolvedStep.kind ?? step.tool?.kind ?? 'other'), ...(resolvedStep.toolInput ?? {}) };

    const responseId = newId('resp');
    const callId = newId('call');
    const stepDelay = step.chunkDelayMs ?? 0;

    recorder?.record({
      ts: new Date().toISOString(),
      direction: 'reply',
      stepIndex,
      toolName,
      stream: body['stream'] !== false,
    });

    const outputItems: Record<string, unknown>[] = [];

    if (body['stream'] === false) {
      if (step.thinking) {
        outputItems.push({
          id: newId('rs'),
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: control.render(step.thinking, vars) }],
        });
      }
      if (step.text) {
        outputItems.push({
          id: newId('msg'),
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: control.render(step.text, vars), annotations: [] }],
        });
      }
      if (toolName) {
        outputItems.push({
          id: newId('fc'),
          type: 'function_call',
          status: 'completed',
          call_id: callId,
          name: toolName,
          arguments: JSON.stringify(toolInput),
        });
      }
      sendJson(res, 200, { ...emptyResponse(responseId, requestModel, 'completed'), output: outputItems, usage: usage() });
      return;
    }

    startSse(res);
    writeSse(res, 'response.created', {
      type: 'response.created',
      response: emptyResponse(responseId, requestModel, 'in_progress'),
    });
    writeSse(res, 'response.in_progress', {
      type: 'response.in_progress',
      response: emptyResponse(responseId, requestModel, 'in_progress'),
    });

    let outputIndex = 0;

    if (step.thinking) {
      const itemId = newId('rs');
      const index = outputIndex++;
      writeSse(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: index,
        item: { id: itemId, type: 'reasoning', summary: [] },
      });
      writeSse(res, 'response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added',
        item_id: itemId,
        output_index: index,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
      for (const chunk of chunkText(control.render(step.thinking, vars), chunkSize)) {
        await delay(stepDelay);
        writeSse(res, 'response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta',
          item_id: itemId,
          output_index: index,
          summary_index: 0,
          delta: chunk,
        });
      }
      writeSse(res, 'response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done',
        item_id: itemId,
        output_index: index,
        summary_index: 0,
        text: step.thinking,
      });
      writeSse(res, 'response.reasoning_summary_part.done', {
        type: 'response.reasoning_summary_part.done',
        item_id: itemId,
        output_index: index,
        summary_index: 0,
        part: { type: 'summary_text', text: step.thinking },
      });
      const item = { id: itemId, type: 'reasoning', summary: [{ type: 'summary_text', text: control.render(step.thinking, vars) }] };
      outputItems.push(item);
      writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: index, item });
    }

    if (step.text) {
      const itemId = newId('msg');
      const index = outputIndex++;
      writeSse(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: index,
        item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      });
      writeSse(res, 'response.content_part.added', {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      for (const chunk of chunkText(control.render(step.text, vars), chunkSize)) {
        await delay(stepDelay);
        writeSse(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: itemId,
          output_index: index,
          content_index: 0,
          delta: chunk,
        });
      }
      writeSse(res, 'response.output_text.done', {
        type: 'response.output_text.done',
        item_id: itemId,
        output_index: index,
        content_index: 0,
        text: step.text,
      });
      const part = { type: 'output_text', text: control.render(step.text, vars), annotations: [] };
      writeSse(res, 'response.content_part.done', {
        type: 'response.content_part.done',
        item_id: itemId,
        output_index: index,
        content_index: 0,
        part,
      });
      const item = { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [part] };
      outputItems.push(item);
      writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: index, item });
    }

    if (codeMode && step.tool !== undefined) {
      // code mode：一个 exec 自定义工具，input 是 JavaScript 源码
      const itemId = newId('ctc');
      const index = outputIndex;
      const execCallId = newId('exec');
      const source = codeModeScript(step, resolvedStep.toolName ?? 'exec_command');
      writeSse(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: index,
        item: { id: itemId, type: 'custom_tool_call', status: 'in_progress', call_id: execCallId, name: 'exec', input: '' },
      });
      for (const chunk of chunkText(source, 40)) {
        await delay(stepDelay);
        writeSse(res, 'response.custom_tool_call_input.delta', {
          type: 'response.custom_tool_call_input.delta',
          item_id: itemId,
          output_index: index,
          delta: chunk,
        });
      }
      writeSse(res, 'response.custom_tool_call_input.done', {
        type: 'response.custom_tool_call_input.done',
        item_id: itemId,
        output_index: index,
        input: source,
      });
      const item = { id: itemId, type: 'custom_tool_call', status: 'completed', call_id: execCallId, name: 'exec', input: source };
      outputItems.push(item);
      writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: index, item });
    }

    if (!codeMode && toolName) {
      const itemId = newId('fc');
      const index = outputIndex;
      writeSse(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: index,
        item: { id: itemId, type: 'function_call', status: 'in_progress', call_id: callId, name: toolName, arguments: '' },
      });
      const json = JSON.stringify(toolInput);
      for (const chunk of chunkText(json, 24)) {
        await delay(stepDelay);
        writeSse(res, 'response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: itemId,
          output_index: index,
          delta: chunk,
        });
      }
      writeSse(res, 'response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: itemId,
        output_index: index,
        arguments: json,
      });
      const item = { id: itemId, type: 'function_call', status: 'completed', call_id: callId, name: toolName, arguments: json };
      outputItems.push(item);
      writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: index, item });
    }

    writeSse(res, 'response.completed', {
      type: 'response.completed',
      response: { ...emptyResponse(responseId, requestModel, 'completed'), output: outputItems, usage: usage() },
    });
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

export async function startResponsesMock(options: ResponsesMockOptions): Promise<RunningResponsesMock> {
  const mock = createResponsesMock(options);
  await new Promise<void>((resolve, reject) => {
    mock.server.once('error', reject);
    mock.server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });
  const address = mock.server.address();
  if (address === null || typeof address === 'string') throw new Error('mock-responses: 无法确定监听端口');
  mock.port = address.port;
  mock.url = `http://${options.host ?? '127.0.0.1'}:${address.port}`;
  return mock;
}
