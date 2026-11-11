import type {
  AdapterEvent,
  AgentAdapter,
  ApprovalDecision,
  CreateOpts,
  EventData,
  EventKind,
  LaunchSpec,
  ModelOption,
  ProbeResult,
  UserInput,
} from '@webdcc/protocol';
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { isValidEventData } from '@webdcc/protocol';

export const PINNED_SDK_VERSION = '0.3.322';
export const PINNED_CLI_VERSION = '2.1.322';

export interface ClaudeAdapterOptions {
  env?: Record<string, string>;
  model?: string;
}

const ACCESS_MODES = [
  { id: 'default', label: '默认（每次询问）' },
  { id: 'acceptEdits', label: '自动接受编辑' },
  { id: 'plan', label: '计划模式' },
  { id: 'dontAsk', label: '不询问' },
  { id: 'auto', label: '自动' },
  { id: 'bypassPermissions', label: '跳过权限' },
];

interface InputQueue {
  push: (text: string) => void;
  end: () => void;
  iterable: AsyncIterable<SDKUserMessage>;
}

function createInputQueue(): InputQueue {
  const queue: SDKUserMessage[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const iterable: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  return {
    iterable,
    push(text: string) {
      queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      wake?.();
      wake = null;
    },
    end() {
      done = true;
      wake?.();
      wake = null;
    },
  };
}

function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

interface PendingInteraction {
  kind: 'approval' | 'question';
  toolName: string;
  input: Record<string, unknown>;
  resolve: (decision: { approved: boolean; optionId: string; answers?: Record<string, unknown>; annotations?: Record<string, unknown> }) => void;
}

interface SessionRuntime {
  nativeId: string;
  input: InputQueue;
  q: Query;
  pump: Promise<void>;
  turnStartedAt: number;
  pending: Map<string, PendingInteraction>;
  toolItems: Map<string, { itemKey: string; kind: EventKind; data: EventData[EventKind] }>;
  messageSeq: number;
  /** 这一块是否已经发过 item.start（SDK 不一定给 block-start，按首个 delta 兜底） */
  liveStarted: boolean;
  ready: Promise<void>;
}

/** 工具名 → 我方 kind（SPEC 6.3） */
export function toolKind(name: string): EventKind {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return 'command';
    case 'Read':
    case 'Glob':
    case 'Grep':
      return 'file.read';
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'file.change';
    case 'TodoWrite':
      return 'plan';
    case 'AskUserQuestion':
      return 'question';
    default:
      return 'tool.call';
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude-code' as const;
  private readonly listeners: ((sessionId: string, event: AdapterEvent) => void)[] = [];
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly options: ClaudeAdapterOptions;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.options = options;
  }

  onEvent(cb: (sessionId: string, event: AdapterEvent) => void): void {
    this.listeners.push(cb);
  }

  private emit(sessionId: string, event: AdapterEvent): void {
    // 发送前校验：不合格的完成态事件降级为 unknown（F2）
    if (event.type === 'item.complete' && !isValidEventData(event.kind, event.data)) {
      const degraded: AdapterEvent = {
        type: 'item.complete',
        itemKey: event.itemKey,
        kind: 'unknown',
        data: { nativeType: event.kind },
        native: event.native ?? event.data,
      };
      for (const listener of this.listeners) listener(sessionId, degraded);
      return;
    }
    for (const listener of this.listeners) listener(sessionId, event);
  }

  async probe(): Promise<ProbeResult> {
    return {
      installed: true,
      version: PINNED_SDK_VERSION,
      pinnedVersion: PINNED_SDK_VERSION,
      auth: 'unknown',
      notes: [`Claude Agent SDK ${PINNED_SDK_VERSION} / CLI ${PINNED_CLI_VERSION}`],
    };
  }

  async listModels(): Promise<ModelOption[]> {
    return [{ id: this.options.model ?? 'claude-sonnet-4-5', label: this.options.model ?? 'claude-sonnet-4-5' }];
  }

  accessModes(): { id: string; label: string }[] {
    return ACCESS_MODES;
  }

  buildLaunchSpec(opts: CreateOpts): LaunchSpec {
    const providerEnv: Record<string, string> = {};
    const provider = opts.provider;
    if (provider !== null && provider !== undefined) {
      providerEnv['ANTHROPIC_BASE_URL'] = provider.baseUrl;
      providerEnv['ANTHROPIC_AUTH_TOKEN'] = provider.apiKey ?? '';
      providerEnv['ANTHROPIC_API_KEY'] = '';
      if (opts.model !== undefined) providerEnv['ANTHROPIC_MODEL'] = opts.model;
    }
    return {
      env: { ...(this.options.env ?? {}), ...providerEnv },
      sdkOptions: {
        cwd: opts.cwd,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.accessMode === undefined ? {} : { permissionMode: opts.accessMode }),
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
      },
    };
  }

  private buildOptions(opts: CreateOpts, canUseTool: CanUseTool, resume?: string): Options {
    const spec = this.buildLaunchSpec(opts);
    const base = spec.sdkOptions as Options;
    return {
      ...base,
      // SDK 要求：用 bypassPermissions 时必须显式声明允许跳过
      ...(base.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(resume === undefined ? {} : { resume }),
      canUseTool,
      env: { ...(process.env as Record<string, string>), ...spec.env },
    };
  }

  private startQuery(sessionId: string, opts: CreateOpts, resume?: string): SessionRuntime {
    const input = createInputQueue();
    let markReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const canUseTool: CanUseTool = (toolName, toolInput, options) => this.handleCanUseTool(sessionId, toolName, toolInput, options);

    const q = query({ prompt: input.iterable, options: this.buildOptions(opts, canUseTool, resume) });
    const runtime: SessionRuntime = {
      nativeId: resume ?? '',
      input,
      q,
      pump: Promise.resolve(),
      turnStartedAt: Date.now(),
      pending: new Map(),
      toolItems: new Map(),
      messageSeq: 0,
      liveStarted: false,
      ready,
    };
    this.sessions.set(sessionId, runtime);
    runtime.pump = (async () => {
      for await (const message of q as AsyncIterable<SDKMessage>) {
        if (message.type === 'system' && message.subtype === 'init') {
          runtime.nativeId = message.session_id;
          this.emit(sessionId, { type: 'native-id', nativeId: message.session_id });
          markReady();
        }
        this.onSdkMessage(sessionId, message);
      }
    })().catch((error: unknown) => {
      this.emit(sessionId, {
        type: 'item.complete',
        itemKey: `error-${Date.now().toString(36)}`,
        kind: 'error',
        data: { message: error instanceof Error ? error.message : String(error) },
      });
    });
    return runtime;
  }

  async create(opts: CreateOpts): Promise<{ nativeId: string }> {
    this.startQuery(opts.sessionId, opts);
    return { nativeId: '' };
  }

  async resume(opts: CreateOpts & { nativeId: string }): Promise<void> {
    const runtime = this.startQuery(opts.sessionId, opts, opts.nativeId);
    await Promise.race([runtime.ready, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }

  async send(sessionId: string, input: UserInput): Promise<void> {
    const runtime = this.require(sessionId);
    runtime.turnStartedAt = Date.now();
    runtime.input.push(input.text);
  }

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    await runtime.q.interrupt().catch(() => undefined);
  }

  async respond(sessionId: string, decision: ApprovalDecision): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    const pending = runtime?.pending.get(decision.approvalId);
    if (runtime === undefined || pending === undefined) return;
    runtime.pending.delete(decision.approvalId);
    pending.resolve({ approved: decision.optionId === 'allow', optionId: decision.optionId });
  }

  async answer(sessionId: string, questionId: string, answer: unknown): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    const pending = runtime?.pending.get(questionId.split(':')[0] ?? questionId);
    if (runtime === undefined || pending === undefined) return;
    runtime.pending.delete(questionId.split(':')[0] ?? questionId);
    const answers = (answer as { value?: string | string[]; selected?: string[] }) ?? {};
    const value = answers.value ?? answers.selected ?? '';
    pending.resolve({ approved: true, optionId: 'answer', answers: { [questionId]: value } });
  }

  debugProcesses(): { sessionId: string; pid: number; dirs: Record<string, string> }[] {
    return [...this.sessions.keys()].map((sessionId) => ({
      sessionId,
      pid: 0,
      dirs: {
        HOME: process.env['HOME'] ?? '',
        CLAUDE_CONFIG_DIR: this.options.env?.['CLAUDE_CONFIG_DIR'] ?? process.env['CLAUDE_CONFIG_DIR'] ?? '',
      },
    }));
  }

  async dispose(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    this.sessions.delete(sessionId);
    runtime.input.end();
    await runtime.q.close?.();
    await runtime.pump.catch(() => undefined);
  }

  private require(sessionId: string): SessionRuntime {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) throw new Error('claude: 会话未创建');
    return runtime;
  }

  // ---------- canUseTool：审批与提问都从这里来 ----------

  private async handleCanUseTool(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID?: string },
  ): Promise<PermissionResult> {
    const runtime = this.require(sessionId);
    if (toolName === 'AskUserQuestion') {
      const questions = (input['questions'] as Record<string, unknown>[]) ?? [];
      const questionId = `${options.toolUseID ?? `q-${Date.now()}`}`;
      const questionPromise = new Promise<{ approved: boolean; optionId: string; answers?: Record<string, unknown>; annotations?: Record<string, unknown> }>((resolve) => {
        runtime.pending.set(questionId, { kind: 'question', toolName, input, resolve });
      });
      this.emit(sessionId, {
        type: 'item.complete',
        itemKey: `question-${questionId}`,
        kind: 'question',
        data: {
          questionId: `${questionId}:0`,
          prompt: String(questions[0]?.['question'] ?? '请回答'),
          ...(questions[0]?.['header'] === undefined ? {} : { header: String(questions[0]?.['header']) }),
          options: ((questions[0]?.['options'] as Record<string, unknown>[]) ?? []).map((option) => ({
            id: String(option['label'] ?? ''),
            label: String(option['label'] ?? ''),
            ...(option['description'] === undefined ? {} : { description: String(option['description']) }),
          })),
          multiSelect: questions[0]?.['multiSelect'] === true,
          allowsFreeText: true,
          ...(options.toolUseID === undefined ? {} : { toolCallId: options.toolUseID }),
        },
      });
      this.emit(sessionId, { type: 'status', status: 'waiting' });
      const decision = await questionPromise;
      this.emit(sessionId, { type: 'status', status: 'running' });
      const answers = decision.answers ?? {};
      return { behavior: 'allow', updatedInput: { ...input, answers } } as PermissionResult;
    }

    const approvalId = `${sessionId}:${options.toolUseID ?? Date.now().toString(36)}`;
    const decisionPromise = new Promise<{ approved: boolean; optionId: string; answers?: Record<string, unknown>; annotations?: Record<string, unknown> }>((resolve) => {
      runtime.pending.set(approvalId, { kind: 'approval', toolName, input, resolve });
    });
    this.emit(sessionId, {
      type: 'item.complete',
      itemKey: `approval-${approvalId}`,
      kind: 'approval.request',
      data: {
        approvalId,
        title: `Claude Code 请求使用 ${toolName}`,
        detail: JSON.stringify(input, null, 2).slice(0, 2000),
        options: [
          { id: 'allow', label: '允许一次' },
          { id: 'deny', label: '拒绝' },
        ],
      },
    });
    this.emit(sessionId, { type: 'status', status: 'waiting' });
    const decision = await decisionPromise;
    this.emit(sessionId, { type: 'status', status: 'running' });
    if (decision.approved) return { behavior: 'allow', updatedInput: input } as PermissionResult;
    return { behavior: 'deny', message: '用户拒绝', interrupt: true } as PermissionResult;
  }

  // ---------- SDK 消息 → 我方事件 ----------

  private onSdkMessage(sessionId: string, message: SDKMessage): void {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;

    switch (message.type) {
      case 'system': {
        if (message.subtype === 'init') {
          this.emit(sessionId, {
            type: 'item.complete',
            itemKey: `internal-init`,
            kind: 'internal',
            data: { nativeType: 'system/init' },
            native: message,
          });
        }
        return;
      }
      case 'stream_event': {
        const event = message.event as {
          type?: string;
          index?: number;
          block?: { type?: string };
          content_block?: { type?: string };
          delta?: { type?: string; text?: string; thinking?: string };
        };
        if (event.type === 'content_block_start') {
          runtime.messageSeq += 1;
          runtime.liveStarted = false;
          const blockType = event.content_block?.type ?? event.block?.type ?? 'text';
          this.emit(sessionId, {
            type: 'item.start',
            itemKey: `msg-${runtime.messageSeq}`,
            kind: blockType === 'thinking' ? 'reasoning' : 'assistant.message',
            data: { text: '' },
          });
          return;
        }
        if (event.type === 'content_block_delta') {
          const delta = event.delta ?? {};
          const liveKey = `msg-${runtime.messageSeq}`;
          if (delta.type === 'text_delta' && delta.text !== undefined) {
            if (!runtime.liveStarted) {
              runtime.liveStarted = true;
              this.emit(sessionId, { type: 'item.start', itemKey: liveKey, kind: 'assistant.message', data: { text: '' } });
            }
            this.emit(sessionId, { type: 'item.delta', itemKey: liveKey, field: 'text', append: delta.text });
          }
          if (delta.type === 'thinking_delta' && delta.thinking !== undefined) {
            if (!runtime.liveStarted) {
              runtime.liveStarted = true;
              this.emit(sessionId, { type: 'item.start', itemKey: liveKey, kind: 'reasoning', data: { text: '' } });
            }
            this.emit(sessionId, { type: 'item.delta', itemKey: liveKey, field: 'text', append: delta.thinking });
          }
        }
        return;
      }
      case 'assistant': {
        const content = (message.message?.content ?? []) as unknown as Record<string, unknown>[];
        const itemKey = `msg-${runtime.messageSeq}`;
        const textParts = content.filter((block) => block['type'] === 'text').map((block) => String(block['text'] ?? ''));
        const thinking = content.filter((block) => block['type'] === 'thinking').map((block) => String(block['thinking'] ?? '')).join('');
        if (thinking !== '') {
          this.emit(sessionId, { type: 'item.complete', itemKey: `${itemKey}-thinking`, kind: 'reasoning', data: { text: thinking } });
        }
        if (textParts.length > 0) {
          this.emit(sessionId, {
            type: 'item.complete',
            itemKey,
            kind: 'assistant.message',
            data: { text: textParts.join('\n') },
          });
        }
        for (const block of content) {
          if (block['type'] !== 'tool_use') continue;
          const toolId = String(block['id'] ?? '');
          const name = String(block['name'] ?? '');
          const kind = toolKind(name);
          if (name === 'TodoWrite') {
            const todos = ((block['input'] as Record<string, unknown>)?.['todos'] as { content?: string; status?: string }[] | undefined) ?? [];
            this.emit(sessionId, {
              type: 'item.complete',
              itemKey: `plan-${toolId}`,
              kind: 'plan',
              data: {
                items: todos.map((todo) => ({
                  text: String(todo.content ?? ''),
                  status: todo.status === 'completed' ? 'completed' : todo.status === 'in_progress' ? 'in_progress' : 'pending',
                })),
              },
            });
            runtime.toolItems.set(toolId, { itemKey: `tool-${toolId}`, kind: 'tool.call', data: { name, input: block['input'], status: 'running' } });
            continue;
          }
          const data: EventData[EventKind] =
            kind === 'command'
              ? { command: String((block['input'] as Record<string, unknown>)?.['command'] ?? ''), status: 'running' }
              : kind === 'file.read'
                ? { path: String((block['input'] as Record<string, unknown>)?.['file_path'] ?? (block['input'] as Record<string, unknown>)?.['pattern'] ?? '') }
                : { name, input: block['input'], status: 'running' };
          runtime.toolItems.set(toolId, { itemKey: `tool-${toolId}`, kind, data });
          this.emit(sessionId, { type: 'item.start', itemKey: `tool-${toolId}`, kind, data });
        }
        return;
      }
      case 'user': {
        const content = (message.message?.content ?? []) as unknown as Record<string, unknown>[];
        for (const block of content) {
          if (block['type'] !== 'tool_result') continue;
          const toolId = String(block['tool_use_id'] ?? '');
          const item = runtime.toolItems.get(toolId);
          runtime.toolItems.delete(toolId);
          const output = typeof block['content'] === 'string' ? block['content'] : JSON.stringify(block['content']);
          if (item === undefined) continue;
          if (item.kind === 'command') {
            this.emit(sessionId, {
              type: 'item.complete',
              itemKey: item.itemKey,
              kind: 'command',
              data: { ...(item.data as EventData['command']), status: block['is_error'] === true ? 'failed' : 'completed', outputTail: output.slice(-4000) },
            });
          } else if (item.kind === 'file.read') {
            this.emit(sessionId, { type: 'item.complete', itemKey: item.itemKey, kind: 'file.read', data: item.data as EventData['file.read'] });
          } else if (item.kind === 'file.change') {
            this.emit(sessionId, {
              type: 'item.complete',
              itemKey: item.itemKey,
              kind: 'file.change',
              data: { changes: [], status: block['is_error'] === true ? 'failed' : 'completed' },
            });
          } else {
            this.emit(sessionId, {
              type: 'item.complete',
              itemKey: item.itemKey,
              kind: item.kind,
              data: { ...(item.data as EventData['tool.call']), status: block['is_error'] === true ? 'failed' : 'completed', output },
            });
          }
        }
        return;
      }
      case 'result': {
        const result = message as unknown as { subtype?: string; is_error?: boolean; duration_ms?: number; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number } };
        this.emit(sessionId, {
          type: 'item.complete',
          itemKey: `turn-${Date.now().toString(36)}`,
          kind: 'turn.completed',
          data: {
            status: result.is_error === true ? (result.subtype === 'error_during_execution' ? 'interrupted' : 'failed') : 'completed',
            durationMs: result.duration_ms ?? Date.now() - runtime.turnStartedAt,
            ...(result.usage === undefined
              ? {}
              : { usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } }),
          },
        });
        this.emit(sessionId, { type: 'status', status: 'idle' });
        return;
      }
      default:
        return;
    }
  }
}

export { userMessage };
