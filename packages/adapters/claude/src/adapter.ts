import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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
  TraceSink,
  TraceFrame,
  AnswerSubmission,
} from '@webdcc/protocol';
import {
  query,
  type CanUseTool,
  type EffortLevel,
  type Options,
  type PermissionResult,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { buildFileChanges, isValidEventData, traceFrame, normalizeQuestionAnswer, nativeAccessMode } from '@webdcc/protocol';

import { ClaudeContentReducer } from './content.js';
import { claudeSystemEvent } from './system.js';

export const PINNED_SDK_VERSION = '0.3.322';
export const PINNED_CLI_VERSION = '2.1.322';

export interface ClaudeAdapterOptions {
  env?: Record<string, string>;
  model?: string;
  traceSink?: TraceSink;
}

const requireFromAdapter = createRequire(import.meta.url);

/**
 * Resolve Claude Code's platform package explicitly. The Agent SDK normally
 * does this itself through an optional dependency, but a production release
 * is copied out of pnpm's virtual store and can lose the package lookup path
 * even when the native binary is present. Passing the concrete executable
 * path keeps startup independent of that package-manager layout.
 */
function resolveNativeCli(): string | undefined {
  const platform = process.platform;
  const arch = process.arch;
  const executable = platform === 'win32' ? 'claude.exe' : 'claude';
  let packageNames: string[];
  if (platform === 'linux') {
    let musl = false;
    try {
      const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
      musl = report?.header?.glibcVersionRuntime === undefined;
    } catch {
      // If runtime detection is unavailable, prefer the glibc package.
    }
    const glibc = `@anthropic-ai/claude-agent-sdk-linux-${arch}`;
    const alpine = `${glibc}-musl`;
    packageNames = musl ? [alpine, glibc] : [glibc, alpine];
  } else {
    packageNames = [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`];
  }

  let sdkRoot: string | undefined;
  try {
    sdkRoot = dirname(requireFromAdapter.resolve('@anthropic-ai/claude-agent-sdk'));
  } catch {
    return undefined;
  }
  for (const packageName of packageNames) {
    try {
      const resolved = requireFromAdapter.resolve(`${packageName}/${executable}`, { paths: [sdkRoot] });
      if (existsSync(resolved)) return resolved;
    } catch {
      // Try the materialized sibling path below. This also handles releases
      // whose package.json has no `main` or `exports` entry.
    }
    const packageShortName = packageName.slice('@anthropic-ai/'.length);
    const fallback = join(sdkRoot, 'node_modules', '@anthropic-ai', packageShortName, executable);
    if (existsSync(fallback)) return fallback;
  }
  return undefined;
}

const ACCESS_MODES = [
  { id: 'default', label: '默认（每次询问）' },
  { id: 'acceptEdits', label: '自动接受编辑' },
  { id: 'plan', label: '计划模式' },
  { id: 'dontAsk', label: '不询问' },
  { id: 'auto', label: '自动' },
  { id: 'bypassPermissions', label: '跳过权限' },
];

/** Claude Code 的 effort 是 SDK 的原生参数；它没有 Codex 的 minimal/off 档位。 */
const CLAUDE_EFFORTS = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh', 'max']);

function toClaudeEffort(value: string): EffortLevel {
  if (CLAUDE_EFFORTS.has(value as EffortLevel)) return value as EffortLevel;
  throw Object.assign(new Error(`claude-code: 不支持的思考强度 ${value}`), { statusCode: 400 });
}

interface InputQueue {
  push: (text: string, images?: { media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }[]) => void;
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
    push(text: string, images?: { media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }[]) {
      const content =
        images === undefined || images.length === 0
          ? text
          : [
              ...images.map((image) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: image.media_type, data: image.data } })),
              { type: 'text' as const, text },
            ];
      const message: SDKUserMessage = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
      queue.push(message);
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
  answers?: Record<string, unknown>;
  resolve: (decision: { approved: boolean; optionId: string; answers?: Record<string, unknown>; annotations?: Record<string, unknown> }) => void;
}

interface SessionRuntime {
  envelopeId?: number;
  turnActive: boolean;
  backgroundTasks: Map<string, string | undefined>;
  hasBackgroundSnapshot: boolean;
  nativeId: string;
  /** 当前 query 使用的模型；setModel 会立即更新 SDK query 和此缓存。 */
  model?: string;
  /** 创建/恢复 query 时使用的完整启动参数；换模型时用于无损重连。 */
  launchOpts: CreateOpts;
  input: InputQueue;
  q: Query;
  pump: Promise<void>;
  turnStartedAt: number;
  /** 累计 Claude 模型生成片段，排除工具执行和审批等待。 */
  generationStartedAt: number | null;
  generationMs: number;
  pending: Map<string, PendingInteraction>;
  toolItems: Map<string, { itemKey: string; kind: EventKind; data: EventData[EventKind]; name: string; input: Record<string, unknown> }>;
  /** 会话的任务列表（F19：由 TaskCreate / TaskUpdate 及其结果算出） */
  tasks: Map<string, { text: string; status: 'pending' | 'in_progress' | 'completed' }>;
  taskOrder: string[];
  /** init 消息里的斜杠命令（F8） */
  slashCommands: string[];
  content: ClaudeContentReducer;
  ready: Promise<void>;
  frameSeq: number;
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
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      // 任务工具本身显示为普通工具步骤，同时更新任务面板（F19）
      return 'tool.call';
    case 'ToolSearch':
      return 'tool.call';
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
  private readonly generations = new Map<string, number>();

  constructor(options: ClaudeAdapterOptions = {}) {
    this.options = options;
  }

  /** Replay executes the same SDK and permission handlers without a query. */
  static replay(sessionId = 'replay'): { feed: (frame: TraceFrame) => AdapterEvent[]; adapter: ClaudeAdapter; decisions: PermissionResult[] } {
    const adapter = new ClaudeAdapter();
    const decisions: PermissionResult[] = [];
    const runtime: SessionRuntime = {
      nativeId: '', launchOpts: { sessionId, cwd: '.', providerId: null }, input: createInputQueue(), q: undefined as unknown as Query,
      pump: Promise.resolve(), turnActive: false, backgroundTasks: new Map(), hasBackgroundSnapshot: false, turnStartedAt: 0, generationStartedAt: null, generationMs: 0,
      pending: new Map(), toolItems: new Map(), tasks: new Map(), taskOrder: [],
      slashCommands: [], content: new ClaudeContentReducer(1), ready: Promise.resolve(), frameSeq: 0,
    };
    adapter.sessions.set(sessionId, runtime);
    let events: AdapterEvent[] = [];
    adapter.onEvent((_id, event) => events.push(event));
    return { adapter, decisions, feed(frame) {
      events = []; adapter.replayTime = frame.t; runtime.frameSeq = frame.i;
      const raw = frame.frame as Record<string, unknown>;
      if (frame.dir === 'in' && frame.ch === 'sdk') adapter.onSdkMessage(sessionId, raw as unknown as SDKMessage);
      else if (frame.dir === 'in' && frame.ch === 'canUseTool') {
        void adapter.handleCanUseTool(sessionId, String(raw['toolName'] ?? raw['tool'] ?? ''), (raw['input'] ?? {}) as Record<string, unknown>, { signal: new AbortController().signal, toolUseID: raw['toolUseID'] as string | undefined }).then(result => decisions.push(result));
      }
      return events.length > 0 ? [...events] : [{ type: 'item.complete', itemKey: `transport-${frame.ch}-${frame.i}`, kind: 'internal', data: { nativeType: frame.ch }, native: frame.frame }];
    } };
  }

  private replayTime?: number;
  private now(): number { return this.replayTime ?? Date.now(); }

  onEvent(cb: (sessionId: string, event: AdapterEvent) => void): void {
    this.listeners.push(cb);
  }

  bindRuntime(sessionId: string, identity: NonNullable<CreateOpts['runtime']>): void {
    const runtime = this.sessions.get(sessionId);
    if (runtime !== undefined) runtime.launchOpts = { ...runtime.launchOpts, runtime: identity };
  }

  private emit(sessionId: string, event: AdapterEvent): void {
    const current = this.sessions.get(sessionId);
    const identity = current?.launchOpts.runtime;
    if (identity !== undefined) event = { ...event, runtime: identity };
    if (current?.envelopeId !== undefined) event = { ...event, nativeEnvelopeId: current.envelopeId };
    // 发送前校验：不合格的完成态事件降级为 unknown（F2）
    if (event.type === 'item.complete' && !isValidEventData(event.kind, event.data)) {
      const degraded: AdapterEvent = {
        type: 'item.complete',
        itemKey: event.itemKey,
        kind: 'unknown',
        data: { nativeType: event.kind },
        native: event.native ?? event.data,
        runtime: event.runtime,
        nativeEnvelopeId: event.nativeEnvelopeId,
      };
      for (const listener of this.listeners) listener(sessionId, degraded);
      return;
    }
    for (const listener of this.listeners) listener(sessionId, event);
  }

  private observeNative(runtime: SessionRuntime, opts: CreateOpts, frame: TraceFrame): boolean {
    const receipt = opts.nativeEvents?.record(frame);
    runtime.envelopeId = receipt?.envelopeId;
    traceFrame(this.options.traceSink ?? opts.traceSink, frame);
    return receipt?.accepted !== false;
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

  /** 斜杠命令目录：Claude 的 init 消息里就有（F8 / SL-01） */
  async slashCommands(sessionId: string): Promise<{ name: string; description?: string }[]> {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return [];
    // The query is created before system/init arrives. Wait briefly so the
    // first slash-menu open observes the native command catalog instead of a
    // transient empty array.
    await Promise.race([runtime.ready, new Promise((resolve) => setTimeout(resolve, 3000))]);
    return runtime.slashCommands.map((name) => ({ name: name.startsWith('/') ? name : `/${name}` }));
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
      providerEnv['ANTHROPIC_BASE_URL'] = provider.endpoints?.['anthropic-messages'] ?? provider.baseUrl;
      providerEnv['ANTHROPIC_AUTH_TOKEN'] = provider.apiKey ?? '';
      providerEnv['ANTHROPIC_API_KEY'] = '';
      if (opts.model !== undefined) providerEnv['ANTHROPIC_MODEL'] = opts.model;
    }
    if (opts.recordingEndpoint !== undefined) providerEnv['ANTHROPIC_BASE_URL'] = opts.recordingEndpoint.url;
    const nativeCli = resolveNativeCli();
    return {
      env: { ...(this.options.env ?? {}), ...providerEnv },
      sdkOptions: {
        cwd: opts.cwd,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        ...(nativeCli === undefined ? {} : { pathToClaudeCodeExecutable: nativeCli }),
        // settings.json 的 env 会覆盖 options.env；用 flag 级 settings 注入 Provider 才能生效（F16 实测）
        ...(Object.keys(providerEnv).length === 0 ? {} : { settings: { env: providerEnv } }),
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.reasoningEffort === undefined ? {} : { effort: toClaudeEffort(opts.reasoningEffort) }),
        ...(nativeAccessMode(opts.accessMode) === undefined ? {} : { permissionMode: nativeAccessMode(opts.accessMode) }),
        ...(opts.model === undefined && this.options.model !== undefined ? { model: this.options.model } : {}),
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
    const ownerRef: { current?: SessionRuntime } = {};
    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      const owner = ownerRef.current;
      if (owner === undefined || this.sessions.get(sessionId) !== owner) return { behavior: 'deny', message: '原生运行实例已替换' };
      const result = await this.handleCanUseTool(sessionId, toolName, toolInput, options);
      if (this.sessions.get(sessionId) !== owner) return { behavior: 'deny', message: '原生运行实例已替换' };
      if (!this.observeNative(owner, opts, { i: ++owner.frameSeq, t: 0, dir: 'out', ch: 'canUseTool-result', frame: { toolName, toolUseID: options.toolUseID, result } })) return { behavior: 'deny', message: 'WebDCC 原生交互未持久化' };
      return result;
    };

    const q = query({ prompt: input.iterable, options: this.buildOptions(opts, canUseTool, resume) });
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);
    const runtime: SessionRuntime = {
      nativeId: resume ?? '',
      turnActive: false,
      backgroundTasks: new Map(),
      hasBackgroundSnapshot: false,
      ...(opts.model === undefined ? {} : { model: opts.model }),
      launchOpts: opts,
      input,
      q,
      pump: Promise.resolve(),
      turnStartedAt: this.now(),
      generationStartedAt: null,
      generationMs: 0,
      pending: new Map(),
      toolItems: new Map(),
      tasks: new Map(),
      taskOrder: [],
      slashCommands: [],
      content: new ClaudeContentReducer(generation),
      ready,
      frameSeq: 0,
    };
    this.sessions.set(sessionId, runtime);
    ownerRef.current = runtime;
    runtime.pump = (async () => {
      for await (const message of q as AsyncIterable<SDKMessage>) {
        runtime.frameSeq += 1;
        if (!this.observeNative(runtime, opts, { i: runtime.frameSeq, t: this.now() - runtime.turnStartedAt, dir: 'in', ch: 'sdk', frame: message })) return;
        if (this.sessions.get(sessionId) !== runtime) return;
        if (message.type === 'system' && message.subtype === 'init') {
          markReady();
        }
        this.onSdkMessage(sessionId, message);
      }
    })().catch((error: unknown) => {
      if (this.sessions.get(sessionId) !== runtime) return;
      const activeWork = runtime.turnActive || runtime.backgroundTasks.size > 0;
      runtime.turnActive = false;
      if (!this.observeNative(runtime, opts, { i: ++runtime.frameSeq, t: this.now() - runtime.turnStartedAt, dir: 'in', ch: 'sdk-error', frame: { message: error instanceof Error ? error.message : String(error) } })) return;
      this.emit(sessionId, {
        type: 'item.complete',
        itemKey: `error-${runtime.frameSeq}`,
        kind: 'error',
        data: { message: error instanceof Error ? error.message : String(error) },
      });
      if (activeWork) this.emit(sessionId, { type: 'transport.closed', reason: 'sdk-stream-error', activeWork });
      else this.emit(sessionId, { type: 'status', status: 'error' });
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
    runtime.turnStartedAt = this.now();
    runtime.generationStartedAt = null;
    runtime.generationMs = 0;
    const images = (input.images ?? []).map((image) => {
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mime)) throw new Error(`Claude 不支持图片格式 ${image.mime}`);
        const mediaType = image.mime as
          | 'image/png'
          | 'image/jpeg'
          | 'image/gif'
          | 'image/webp';
        return { media_type: mediaType, data: readFileSync(image.path).toString('base64') };
    });
    const content = images.length === 0 ? input.text : [...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } })), { type: 'text', text: input.text }];
    traceFrame(this.options.traceSink ?? runtime.launchOpts.traceSink, { i: ++runtime.frameSeq, t: 0, dir: 'out', ch: 'input', frame: input });
    if (!this.observeNative(runtime, runtime.launchOpts, { i: ++runtime.frameSeq, t: 0, dir: 'out', ch: 'sdk-input', frame: { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } })) throw Object.assign(new Error('原生输入未持久化'), { code: 'uncertain' });
    runtime.input.push(input.text, images.length === 0 ? undefined : images);
    runtime.turnActive = true;
  }

  /** 切换访问模式（F6）：Claude Code 用 SDK 的 setPermissionMode */
  async setAccessMode(sessionId: string, mode: string): Promise<{ accessMode: string }> {
    const runtime = this.require(sessionId);
    if (mode === 'inherit') { await this.replaceIdleQuery(sessionId, { accessMode: undefined }); return { accessMode: mode }; }
    if (!ACCESS_MODES.some(option => option.id === mode)) throw Object.assign(new Error('Claude 权限模式无效'), { statusCode: 400 });
    await runtime.q.setPermissionMode(mode as PermissionMode);
    if (this.sessions.get(sessionId) !== runtime) throw Object.assign(new Error('原生运行实例已替换'), { statusCode: 409 });
    runtime.launchOpts = { ...runtime.launchOpts, accessMode: mode };
    this.emit(sessionId, { type: 'permissions', observation: { effective: mode, source: 'Query.setPermissionMode', scope: 'query', policy: { permissionMode: mode } } });
    return { accessMode: mode };
  }

  /** Claude Agent SDK 支持在同一个 query 上切换模型。必须调用控制面，
   * 只更新 WebDCC 会话元数据会让下一轮仍然使用旧模型。 */
  async setModel(sessionId: string, model: string): Promise<void> {
    await this.replaceIdleQuery(sessionId, { model });
  }

  private async replaceIdleQuery(sessionId: string, patch: Partial<CreateOpts>): Promise<void> {
    const previous = this.require(sessionId);
    if (previous.turnActive || previous.pending.size > 0 || previous.backgroundTasks.size > 0) throw Object.assign(new Error('请等待当前 Claude 轮次和后台任务结束后切换模型或沿用原生权限'), { statusCode: 409 });
    const launchOpts = { ...previous.launchOpts, ...patch };
    this.sessions.delete(sessionId);
    previous.input.end();
    previous.q.close();
    await previous.pump;
    this.emit(sessionId, { type: 'permissions', observation: { effective: null, source: 'query:replacing', scope: 'query' } });
    const resume = previous.nativeId === '' ? undefined : previous.nativeId;
    try {
      const replacement = this.startQuery(sessionId, launchOpts, resume);
      await replacement.q.initializationResult();
      if (this.sessions.get(sessionId) !== replacement) throw new Error('原生运行实例已替换');
    } catch (error) {
      await this.dispose(sessionId);
      // The failed model/default-permission change must leave the previously
      // accepted launch configuration resumable, with only one native writer.
      try {
        const rollback = this.startQuery(sessionId, previous.launchOpts, resume);
        await rollback.q.initializationResult();
      } catch (rollbackError) {
        await this.dispose(sessionId);
        throw Object.assign(new Error(`Claude 切换失败且原配置恢复失败：${String(error)}；${String(rollbackError)}`), { code: 'native-runtime-unavailable', statusCode: 503 });
      }
      throw error;
    }
  }

  /** Claude Code 的 effort 可通过 SDK 控制面在下一轮生效，并在重连时由 launchOpts 恢复。 */
  async setReasoningEffort(sessionId: string, effort: string): Promise<void> {
    const runtime = this.require(sessionId);
    const value = toClaudeEffort(effort);
    await runtime.q.applyFlagSettings({ effortLevel: value });
    if (this.sessions.get(sessionId) !== runtime) throw Object.assign(new Error('原生运行实例已替换'), { statusCode: 409 });
    runtime.launchOpts = { ...runtime.launchOpts, reasoningEffort: value };
  }

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    await runtime.q.interrupt().catch(() => undefined);
  }

  async respond(sessionId: string, decision: ApprovalDecision): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    const pending = runtime?.pending.get(decision.approvalId);
    if (runtime === undefined || pending === undefined) throw Object.assign(new Error('Claude 审批已结束或不存在'), { statusCode: 409 });
    runtime.pending.delete(decision.approvalId);
    pending.resolve({ approved: decision.optionId === 'allow', optionId: decision.optionId });
  }

  /** 打断时把挂起的审批按拒绝处理（回调必须被 resolve，否则 SDK 一直等） */
  async cancelPending(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    for (const [key, pending] of runtime.pending) {
      runtime.pending.delete(key);
      pending.resolve({ approved: false, optionId: 'cancelled' });
    }
  }

  async answer(sessionId: string, questionId: string, answer: unknown): Promise<AnswerSubmission> {
    const runtime = this.sessions.get(sessionId);
    const separator = questionId.lastIndexOf(':');
    const requestId = questionId.slice(0, separator);
    const pending = runtime?.pending.get(requestId);
    if (runtime === undefined || pending === undefined) throw Object.assign(new Error('Claude 问题已结束或不存在'), { statusCode: 409 });
    const value = normalizeQuestionAnswer(answer).values;
    const index = Number(questionId.slice(questionId.lastIndexOf(':') + 1));
    const questions = (pending.input['questions'] ?? []) as Record<string, unknown>[];
    const question = questions[index];
    if (question === undefined) throw new Error('问题不存在');
    pending.answers ??= Object.create(null) as Record<string, string>;
    pending.answers[String(question['question'] ?? '请回答')] = value.join(', ');
    if (!this.observeNative(runtime, runtime.launchOpts, { i: ++runtime.frameSeq, t: 0, dir: 'out', ch: 'control', frame: { questionId, answer } })) throw Object.assign(new Error('原生回应未持久化'), { code: 'uncertain' });
    if (Object.keys(pending.answers).length < questions.length) return { submitted: false };
    runtime.pending.delete(requestId);
    pending.resolve({ approved: true, optionId: 'answer', answers: pending.answers });
    return { submitted: true, questionIds: questions.map((_, index) => `${requestId}:${index}`) };
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

  private finishGeneration(runtime: SessionRuntime): void {
    if (runtime.generationStartedAt === null) return;
    runtime.generationMs += Math.max(1, this.now() - runtime.generationStartedAt);
    runtime.generationStartedAt = null;
  }

  private waitForDecision(runtime: SessionRuntime, id: string, kind: 'approval' | 'question', toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<Parameters<PendingInteraction['resolve']>[0]> {
    let abort = (): void => undefined;
    return new Promise<Parameters<PendingInteraction['resolve']>[0]>(resolve => {
      runtime.pending.set(id, { kind, toolName, input, resolve });
      abort = () => resolve({ approved: false, optionId: 'cancel' });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }).finally(() => { signal.removeEventListener('abort', abort); runtime.pending.delete(id); });
  }

  // ---------- canUseTool：审批与提问都从这里来 ----------

  /** 把当前任务列表发给前端（F19：任务面板） */
  private emitTaskPanel(sessionId: string, runtime: SessionRuntime): void {
    const items = runtime.taskOrder
      .map((key) => runtime.tasks.get(key))
      .filter((task): task is { text: string; status: 'pending' | 'in_progress' | 'completed' } => task !== undefined)
      .map((task) => ({ text: task.text, status: task.status }));
    if (items.length === 0) return;
    this.emit(sessionId, {
      type: 'item.complete',
      itemKey: `plan-tasks-${runtime.frameSeq}`,
      kind: 'plan',
      data: { items },
    });
  }

  private async handleCanUseTool(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID?: string },
  ): Promise<PermissionResult> {
    const runtime = this.require(sessionId);
    if (!this.observeNative(runtime, runtime.launchOpts, { i: ++runtime.frameSeq, t: 0, dir: 'in', ch: 'canUseTool', frame: { toolName, input, toolUseID: options.toolUseID } })) return { behavior: 'deny', message: 'WebDCC 原生交互未持久化' };
    if (toolName === 'AskUserQuestion') {
      const questions = (input['questions'] as Record<string, unknown>[]) ?? [];
      const questionId = `${options.toolUseID ?? `q-${this.generations.get(sessionId) ?? 1}-${runtime.frameSeq + 1}`}`;
      const questionPromise = this.waitForDecision(runtime, questionId, 'question', toolName, input, options.signal);
      for (const [index, question] of questions.entries()) this.emit(sessionId, {
        type: 'item.complete',
        itemKey: `question-${questionId}-${index}`,
        kind: 'question',
        data: {
          questionId: `${questionId}:${index}`,
          groupId: questionId,
          prompt: String(question['question'] ?? '请回答'),
          ...(question['header'] === undefined ? {} : { header: String(question['header']) }),
          options: ((question['options'] as Record<string, unknown>[]) ?? []).map((option) => ({
            id: String(option['label'] ?? ''),
            label: String(option['label'] ?? ''),
            ...(option['description'] === undefined ? {} : { description: String(option['description']) }),
          })),
          multiSelect: question['multiSelect'] === true,
          allowsFreeText: true,
          ...(options.toolUseID === undefined ? {} : { toolCallId: options.toolUseID }),
        },
      });
      const decision = await questionPromise;
      if (!decision.approved) return { behavior: 'deny', message: '用户取消问题', interrupt: true };
      const answers = decision.answers ?? {};
      return { behavior: 'allow', updatedInput: { ...input, answers } } as PermissionResult;
    }

    const isPlanMode = toolName === 'ExitPlanMode';
    const approvalId = `${sessionId}:${options.toolUseID ?? `tool-${this.generations.get(sessionId) ?? 1}-${runtime.frameSeq + 1}`}`;
    const decisionPromise = this.waitForDecision(runtime, approvalId, 'approval', toolName, input, options.signal);
    this.emit(sessionId, {
      type: 'item.complete',
      itemKey: `approval-${approvalId}`,
      kind: 'approval.request',
      data: {
        approvalId,
        title: isPlanMode
          ? 'Claude Code 提交计划'
          : String(input['command'] ?? input['file_path'] ?? input['path'] ?? '') === ''
            ? toolName
            : `${toolName} · ${String(input['command'] ?? input['file_path'] ?? input['path'])}`,
        detail: JSON.stringify(input, null, 2).slice(0, 2000),
        tool: toolName,
        ...(isPlanMode
          ? { planMarkdown: String(input['plan'] ?? input['planMarkdown'] ?? input['content'] ?? JSON.stringify(input, null, 2)) }
          : {}),
        options: [
          { id: 'allow', label: '允许一次' },
          { id: 'deny', label: '拒绝' },
        ],
      },
    });
    const decision = await decisionPromise;
    if (decision.approved) return { behavior: 'allow', updatedInput: input } as PermissionResult;
    return { behavior: 'deny', message: '用户拒绝', interrupt: true } as PermissionResult;
  }

  // ---------- SDK 消息 → 我方事件 ----------

  private onSdkMessage(sessionId: string, message: SDKMessage): void {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;

    switch (message.type) {
      case 'system': {
        // Once the native level signal is available, edges are presentation
        // only: their ordering relative to snapshots is unspecified.
        if (message.subtype === 'background_tasks_changed') {
          runtime.hasBackgroundSnapshot = true;
          runtime.backgroundTasks = new Map(message.tasks.map(task => [task.task_id, task.run_id]));
        }
        if (!runtime.hasBackgroundSnapshot && (message.subtype === 'task_started' || message.subtype === 'task_progress')) {
          const current = runtime.backgroundTasks.get(message.task_id);
          if (!runtime.backgroundTasks.has(message.task_id) || message.run_id !== undefined && (current === undefined || message.run_id >= current)) runtime.backgroundTasks.set(message.task_id, message.run_id);
        }
        if (!runtime.hasBackgroundSnapshot && message.subtype === 'task_notification') {
          const current = runtime.backgroundTasks.get(message.task_id);
          if (message.run_id === current) runtime.backgroundTasks.delete(message.task_id);
        }
        if (message.subtype === 'init') {
          runtime.nativeId = message.session_id;
          this.emit(sessionId, { type: 'native-id', nativeId: message.session_id });
          runtime.slashCommands = message.slash_commands ?? [];
        }
        if ((message.subtype === 'init' || message.subtype === 'status') && typeof message.permissionMode === 'string') this.emit(sessionId, { type: 'permissions', observation: { effective: message.permissionMode, source: `system/${message.subtype}`, scope: 'query', policy: { permissionMode: message.permissionMode } } });
        this.emit(sessionId, claudeSystemEvent(message, runtime.frameSeq));
        return;
      }
      case 'stream_event': {
        if (message.event.type === 'content_block_start' || message.event.type === 'content_block_delta') runtime.generationStartedAt ??= this.now();
        for (const event of runtime.content.stream(message)) this.emit(sessionId, event);
        return;
      }
      case 'assistant': {
        this.finishGeneration(runtime);
        const content = (message.message?.content ?? []) as unknown as Record<string, unknown>[];
        const reduced = runtime.content.assistant(message);
        for (const event of reduced.events) this.emit(sessionId, event);
        if (reduced.duplicate) return;
        for (const block of content) {
          if (block['type'] !== 'tool_use') continue;
          const toolId = String(block['id'] ?? '');
          const name = String(block['name'] ?? '');
          const mappedKind = toolKind(name);
          const kind = mappedKind === 'question' ? 'tool.call' : mappedKind;
          const rawInput = (block['input'] ?? {}) as Record<string, unknown>;
          if (name === 'TodoWrite') {
            const todos = (rawInput['todos'] as { content?: string; status?: string }[] | undefined) ?? [];
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
            runtime.toolItems.set(toolId, { itemKey: `tool-${toolId}`, kind: 'tool.call', data: { name, input: rawInput, status: 'running' }, name, input: rawInput });
            continue;
          }
          if (name === 'TaskCreate') {
            const key = String(runtime.taskOrder.length + 1);
            runtime.tasks.set(key, {
              text: String(rawInput['subject'] ?? rawInput['description'] ?? ''),
              status: 'pending',
            });
            runtime.taskOrder.push(key);
          } else if (name === 'TaskUpdate') {
            const key = String(rawInput['taskId'] ?? '');
            const existing = runtime.tasks.get(key);
            const status = rawInput['status'] === 'completed' ? 'completed' : rawInput['status'] === 'in_progress' ? 'in_progress' : 'pending';
            if (existing !== undefined) existing.status = status;
            else if (key !== '') {
              runtime.tasks.set(key, { text: `任务 ${key}`, status });
              runtime.taskOrder.push(key);
            }
          }
          if (name === 'TaskCreate' || name === 'TaskUpdate' || name === 'TodoWrite') {
            this.emitTaskPanel(sessionId, runtime);
          }
          const data: EventData[EventKind] =
            kind === 'command'
              ? { command: String(rawInput['command'] ?? ''), status: 'running' }
              : kind === 'file.read'
                ? { path: String(rawInput['file_path'] ?? rawInput['pattern'] ?? '') }
                : kind === 'file.change' ? { changes: buildFileChanges(name, rawInput), status: 'running' }
                : { name, input: rawInput, status: 'running' };
          runtime.toolItems.set(toolId, { itemKey: `tool-${toolId}`, kind, data, name, input: rawInput });
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
              native: message,
            });
          } else if (item.kind === 'file.read') {
            this.emit(sessionId, { type: 'item.complete', itemKey: item.itemKey, kind: 'file.read', data: item.data as EventData['file.read'], native: message });
          } else if (item.kind === 'file.change') {
            this.emit(sessionId, {
              type: 'item.complete',
              itemKey: item.itemKey,
              kind: 'file.change',
              data: { changes: buildFileChanges(item.name, item.input), status: block['is_error'] === true ? 'failed' : 'completed' },
              native: message,
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
        runtime.turnActive = false;
        for (const event of runtime.content.flush(message.session_id)) this.emit(sessionId, event);
        const result = message as unknown as { subtype?: string; is_error?: boolean; duration_ms?: number; total_cost_usd?: number; modelUsage?: Record<string, unknown>; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
        this.finishGeneration(runtime);
        const generationMs = runtime.generationMs > 0 ? runtime.generationMs : undefined;
        runtime.generationMs = 0;
        const resultText = (message as unknown as { result?: unknown }).result;
        const aborted = message.terminal_reason === 'aborted_streaming' || message.terminal_reason === 'aborted_tools';
        if (result.is_error === true && !aborted) this.emit(sessionId, { type: 'item.complete', itemKey: `result-error-${runtime.frameSeq}`, kind: 'error', data: { message: 'errors' in message && message.errors.length > 0 ? message.errors.join('\n') : 'Claude 原生执行失败' }, native: message });
        if (typeof resultText === 'string' && resultText !== '') {
          this.emit(sessionId, { type: 'item.complete', itemKey: `result-${runtime.frameSeq}`, kind: 'assistant.message', data: { text: resultText, nativePhase: 'final_result' }, native: message });
        }
        this.emit(sessionId, {
          type: 'turn.end',
          status: result.is_error === true ? aborted ? 'interrupted' : 'failed' : 'completed',
          ...(result.usage === undefined
            ? {}
            : { usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, cacheReadInputTokens: result.usage.cache_read_input_tokens, cacheCreationInputTokens: result.usage.cache_creation_input_tokens, totalCostUsd: result.total_cost_usd, modelUsage: result.modelUsage, scope: 'turn', ...(generationMs === undefined ? {} : { generationMs }) } }),
          native: result,
        });
        return;
      }
      default:
        this.emit(sessionId, { type: 'item.complete', itemKey: `unknown-sdk-${runtime.frameSeq}`, kind: 'unknown', data: { nativeType: message.type }, native: message });
        return;
    }
  }
}

export { userMessage };
