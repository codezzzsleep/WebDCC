import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
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
  type ElicitationRequest,
  type ElicitationResult,
  type UserDialogRequest,
  type UserDialogResult,
} from '@anthropic-ai/claude-agent-sdk';
import { buildFileChanges, elicitationUrl, schemaHasSecrets, isValidEventData, traceFrame, normalizeQuestionAnswer, nativeAccessMode } from '@webdcc/protocol';

import { ClaudeContentReducer } from './content.js';
import { encodeClaudeInput, type ClaudeUserContent } from './input.js';
import { claudeSystemEvent } from './system.js';
import { managedClaudeProcess } from './managed-process.js';
import type { ClaudeStdioCaptureState } from './stdio-capture.js';
import { ClaudeNativeHistory, claudeNativeActionCatalog, elicitationResult, nativeError, nativeValidationError, parseClaudeNativeAction, record, type ClaudeNativeOptions } from './native.js';
import { ClaudeNativeState } from './native-state.js';

export const PINNED_SDK_VERSION = '0.3.322';
export const PINNED_CLI_VERSION = '2.1.322';

export interface ClaudeAdapterOptions {
  env?: Record<string, string>;
  model?: string;
  traceSink?: TraceSink;
  catalogOptions?: (providerId: string | null) => Promise<CreateOpts>;
  /** Trusted host renderers, registered only for dialog kinds with a verified native payload/result contract. */
  dialogSpecs?: Record<string, { validateRequest: (payload: Record<string, unknown>) => void; validateResult: (result: unknown) => void }>;
}

const requireFromAdapter = createRequire(import.meta.url);

/**
 * Resolve Claude Code's platform package explicitly. The Agent SDK normally
 * does this itself through an optional dependency, but a production release
 * is copied out of pnpm's virtual store and can lose the package lookup path
 * even when the native binary is present. Passing the concrete executable
 * path keeps startup independent of that package-manager layout.
 */
export function resolveNativeCli(): string | undefined {
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
  push: (text: string, images?: { media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }[], uuid?: string, preparedContent?: ClaudeUserContent) => void;
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
    push(text: string, images?: { media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }[], uuid?: string, preparedContent?: ClaudeUserContent) {
      const content = preparedContent ?? (
        images === undefined || images.length === 0
          ? text
          : [
              ...images.map((image) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: image.media_type, data: image.data } })),
              { type: 'text' as const, text },
            ]);
      if (uuid !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) throw nativeError('Claude nativeRequestId 必须为 UUID');
      const message: SDKUserMessage = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...(uuid === undefined ? {} : { uuid: uuid as SDKUserMessage['uuid'] }) };
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
  stdio: ClaudeStdioCaptureState;
  nativeOptions: ClaudeNativeOptions;
  state: ClaudeNativeState;
  capabilities: string[];
  nativePending: Map<string, NativePending>;
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
  /** init 消息里的斜杠命令（F8） */
  slashCommands: string[];
  content: ClaudeContentReducer;
  ready: Promise<void>;
  frameSeq: number;
}
interface NativePending {
  kind: 'elicitation' | 'dialog';
  requestId: string;
  payload: ElicitationRequest | UserDialogRequest;
  status: 'pending' | 'submitted' | 'cancelled';
  promise: Promise<ElicitationResult | UserDialogResult>;
  resolve: (result: ElicitationResult | UserDialogResult) => void;
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
  readonly nativeHistory: ClaudeNativeHistory;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.options = options;
    this.nativeHistory = new ClaudeNativeHistory(options.env);
  }

  /** Replay executes the same SDK and permission handlers without a query. */
  static replay(sessionId = 'replay'): { feed: (frame: TraceFrame) => AdapterEvent[]; adapter: ClaudeAdapter; decisions: PermissionResult[] } {
    const adapter = new ClaudeAdapter();
    const decisions: PermissionResult[] = [];
    const runtime: SessionRuntime = {
      stdio: { enabled: false, failed: false },
      nativeOptions: {}, state: new ClaudeNativeState(), capabilities: [], nativePending: new Map(),
      nativeId: '', launchOpts: { sessionId, cwd: '.', providerId: null }, input: createInputQueue(), q: undefined as unknown as Query,
      pump: Promise.resolve(), turnActive: false, backgroundTasks: new Map(), hasBackgroundSnapshot: false, turnStartedAt: 0, generationStartedAt: null, generationMs: 0,
      pending: new Map(), toolItems: new Map(),
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
    if (runtime.stdio.failed) return false;
    const receipt = opts.nativeEvents?.record(frame);
    runtime.envelopeId = receipt?.envelopeId;
    traceFrame(this.options.traceSink ?? opts.traceSink, frame);
    return receipt?.accepted !== false;
  }

  async probe(): Promise<ProbeResult> {
    const cli = resolveNativeCli();
    if (cli === undefined) return { installed: false, pinnedVersion: PINNED_SDK_VERSION, auth: 'unknown', compatible: false, notes: ['Claude 原生可执行文件不存在'] };
    let version: string;
    try {
      version = await new Promise<string>((resolve, reject) => execFile(cli, ['--version'], { timeout: 5000, env: { ...process.env, ...this.options.env } }, (error, stdout) => error === null ? resolve(stdout.trim()) : reject(error)));
    } catch { return { installed: true, pinnedVersion: PINNED_SDK_VERSION, auth: 'unknown', compatible: false, notes: ['Claude 原生版本探测失败'] }; }
    let sdkVersion: string | undefined;
    try { sdkVersion = (JSON.parse(readFileSync(join(dirname(requireFromAdapter.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8')) as { version?: string }).version; } catch { /* Unknown SDK builds remain restricted. */ }
    const compatible = version.split(/\s/)[0] === PINNED_CLI_VERSION && sdkVersion === PINNED_SDK_VERSION;
    return {
      installed: true,
      version: sdkVersion,
      pinnedVersion: PINNED_SDK_VERSION,
      auth: 'unknown',
      compatible,
      notes: [`Claude Agent SDK ${sdkVersion ?? 'unknown'} / CLI ${version}`],
    };
  }

  /** 斜杠命令目录：Claude 的 init 消息里就有（F8 / SL-01） */
  async slashCommands(sessionId: string): Promise<{ name: string; description?: string }[]> {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return [];
    // The query is created before system/init arrives. Wait briefly so the
    // first slash-menu open observes the native command catalog instead of a
    // transient empty array.
    const commands = await runtime.q.supportedCommands();
    return commands.map(command => ({ ...command, name: command.name.startsWith('/') ? command.name : `/${command.name}` }));
  }

  async listModels(providerId: string | null = null): Promise<ModelOption[]> {
    const live = [...this.sessions.values()].find(runtime => runtime.launchOpts.providerId === providerId && runtime.state.transport === 'live');
    const map = (models: Awaited<ReturnType<Query['supportedModels']>>) => models.map(model => ({ id: model.value, label: model.displayName,
      ...(model.supportedEffortLevels === undefined ? {} : { reasoningEfforts: model.supportedEffortLevels }), source: `Claude Query.supportedModels/${PINNED_CLI_VERSION}` }));
    if (live !== undefined) return map(await live.q.supportedModels());
    if (providerId !== null && this.options.catalogOptions === undefined) throw nativeError('需要 Provider 原生配置才能读取 Claude 模型目录', 503);
    const opts = await this.options.catalogOptions?.(providerId) ?? { sessionId: 'catalog-only', cwd: process.cwd(), providerId: null };
    const input = createInputQueue();
    const q = query({ prompt: input.iterable, options: this.buildOptions(opts, async () => ({ behavior: 'deny', message: '目录探测不执行工具' })) });
    try { return map(await q.supportedModels()); } finally { input.end(); q.close(); }
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

  private buildOptions(opts: CreateOpts, canUseTool: CanUseTool, resume?: string, stdio: ClaudeStdioCaptureState = { enabled: opts.nativeEvents !== undefined, failed: false }): Options {
    const spec = this.buildLaunchSpec(opts);
    const base = spec.sdkOptions as Options;
    return {
      ...base,
      // SDK 要求：用 bypassPermissions 时必须显式声明允许跳过
      ...(base.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(resume === undefined ? {} : { resume }),
      canUseTool,
      ...(opts.onManagedProcess === undefined && opts.nativeEvents === undefined ? {} : { spawnClaudeCodeProcess: options => managedClaudeProcess(options,
        pid => opts.onManagedProcess?.(pid, resolve(options.cwd ?? opts.cwd, options.env['CLAUDE_CONFIG_DIR'] ?? resolve(options.env['HOME'] ?? homedir(), '.claude')), PINNED_CLI_VERSION), base.stderr,
        opts.nativeEvents === undefined ? undefined : { record: frame => {
          // Raw stdio goes only through NativeFrameSink, never an unredacted TraceSink.
          // Failure fences the next user input; observing cannot rewrite bytes already in flight.
          try { if (!opts.nativeEvents!.record(frame).accepted) stdio.failed = true; }
          catch { stdio.failed = true; }
        } }) }),
      env: { ...(process.env as Record<string, string>), ...spec.env },
    };
  }

  private startQuery(sessionId: string, opts: CreateOpts, resume?: string, nativeOptions: ClaudeNativeOptions = {}): SessionRuntime {
    const input = createInputQueue();
    const stdio: ClaudeStdioCaptureState = { enabled: opts.nativeEvents !== undefined, failed: false };
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

    const q = query({ prompt: input.iterable, options: { ...this.buildOptions(opts, canUseTool, resume, stdio), ...nativeOptions,
      onElicitation: (request, callbackOptions) => this.nativeCallback(sessionId, ownerRef.current, 'elicitation', request, callbackOptions) as Promise<ElicitationResult>,
      onUserDialog: (request, callbackOptions) => this.nativeCallback(sessionId, ownerRef.current, 'dialog', request, callbackOptions) as Promise<UserDialogResult>,
      ...(this.options.dialogSpecs === undefined ? {} : { supportedDialogKinds: Object.keys(this.options.dialogSpecs) }),
    } });
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);
    const runtime: SessionRuntime = {
      stdio,
      nativeOptions, state: new ClaudeNativeState(), capabilities: [], nativePending: new Map(),
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
      if (this.sessions.get(sessionId) === runtime) {
        runtime.state.transport = 'closed';
        await this.cancelPending(sessionId);
        if (runtime.turnActive || runtime.backgroundTasks.size > 0) this.emit(sessionId, { type: 'transport.closed', reason: 'sdk-stream-ended', activeWork: true });
      }
    })().catch((error: unknown) => {
      if (this.sessions.get(sessionId) !== runtime) return;
      const activeWork = runtime.turnActive || runtime.backgroundTasks.size > 0;
      runtime.turnActive = false;
      runtime.state.transport = 'failed';
      void this.cancelPending(sessionId);
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
    if (this.sessions.has(opts.sessionId)) throw nativeError('Claude 会话已存在', 409);
    this.startQuery(opts.sessionId, opts);
    return { nativeId: '' };
  }

  async resume(opts: CreateOpts & { nativeId: string }): Promise<void> {
    if (this.sessions.has(opts.sessionId)) throw nativeError('Claude 会话已存在', 409);
    const runtime = this.startQuery(opts.sessionId, opts, opts.nativeId);
    await Promise.race([runtime.ready, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }

  async send(sessionId: string, input: UserInput): Promise<void> {
    const runtime = this.require(sessionId);
    if (runtime.stdio.failed) throw Object.assign(nativeError('Claude 原始记录捕获失败，不能接收新的输入', 503), { code: 'uncertain' });
    if (runtime.state.transport !== 'live') throw nativeError('Claude 连接已断开，需要恢复原生会话', 503);
    if (input.nativeRequestId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.nativeRequestId)) throw nativeError('Claude nativeRequestId 必须为 UUID');
    runtime.turnStartedAt = this.now();
    runtime.generationStartedAt = null;
    runtime.generationMs = 0;
    const content = await encodeClaudeInput(input);
    if (this.sessions.get(sessionId) !== runtime) throw Object.assign(new Error('Claude 运行实例在输入准备期间已替换'), { code: 'uncertain' });
    traceFrame(this.options.traceSink ?? runtime.launchOpts.traceSink, { i: ++runtime.frameSeq, t: 0, dir: 'out', ch: 'input', frame: input });
    if (!this.observeNative(runtime, runtime.launchOpts, { i: ++runtime.frameSeq, t: 0, dir: 'out', ch: 'sdk-input', frame: { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...(input.nativeRequestId === undefined ? {} : { uuid: input.nativeRequestId }) } })) throw Object.assign(new Error('原生输入未持久化'), { code: 'uncertain' });
    runtime.input.push(input.text, undefined, input.nativeRequestId, content);
    runtime.turnActive = true;
  }

  async validateInput(_sessionId: string, input: UserInput): Promise<void> {
    // The pinned SDK ModelInfo has no input modality declaration. Preserve
    // that unknown instead of guessing from model names or descriptions.
    await encodeClaudeInput(input);
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

  private async replaceIdleQuery(sessionId: string, patch: Partial<CreateOpts>, nativePatch: Partial<ClaudeNativeOptions> = {}): Promise<void> {
    const previous = this.require(sessionId);
    if (previous.turnActive || previous.pending.size > 0 || [...previous.nativePending.values()].some(pending => pending.status === 'pending') || previous.backgroundTasks.size > 0) throw Object.assign(new Error('请等待当前 Claude 轮次、交互和后台任务结束后更改启动选项'), { statusCode: 409 });
    const launchOpts = { ...previous.launchOpts, ...patch };
    this.sessions.delete(sessionId);
    previous.input.end();
    previous.q.close();
    await previous.pump;
    this.emit(sessionId, { type: 'permissions', observation: { effective: null, source: 'query:replacing', scope: 'query' } });
    const resume = previous.nativeId === '' ? undefined : previous.nativeId;
    try {
      const replacement = this.startQuery(sessionId, launchOpts, resume, { ...previous.nativeOptions, ...nativePatch });
      await replacement.q.initializationResult();
      if (this.sessions.get(sessionId) !== replacement) throw new Error('原生运行实例已替换');
    } catch (error) {
      await this.dispose(sessionId);
      // The failed model/default-permission change must leave the previously
      // accepted launch configuration resumable, with only one native writer.
      try {
        const rollback = this.startQuery(sessionId, previous.launchOpts, resume, previous.nativeOptions);
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
    await runtime.q.interrupt();
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
    for (const pending of runtime.nativePending.values()) if (pending.status === 'pending') {
      pending.status = 'cancelled';
      pending.resolve(pending.kind === 'elicitation' ? { action: 'cancel' } : { behavior: 'cancelled' });
      this.emit(sessionId, { type: 'item.cancel', itemKey: `claude-native-${pending.requestId}`, scope: 'session' });
    }
  }

  async answer(sessionId: string, questionId: string, answer: unknown): Promise<AnswerSubmission> {
    const runtime = this.sessions.get(sessionId);
    if (runtime?.nativePending.get(questionId)?.kind === 'elicitation') {
      const value = record(answer);
      await this.executeNativeControl(sessionId, parseClaudeNativeAction({ type: 'elicitation', requestId: questionId, action: value['action'], content: value['content'] }));
      return { submitted: true, confirmed: false, questionIds: [questionId] };
    }
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
    await this.cancelPending(sessionId);
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

  private nativeRevision(runtime: SessionRuntime): string {
    return createHash('sha256').update(JSON.stringify({ generation: this.generations.get(runtime.launchOpts.sessionId),
      runtime: runtime.launchOpts.runtime, nativeId: runtime.nativeId, model: runtime.model ?? runtime.launchOpts.model,
      effort: runtime.launchOpts.reasoningEffort, accessMode: runtime.launchOpts.accessMode, nativeOptions: runtime.nativeOptions,
      capabilities: runtime.capabilities })).digest('hex');
  }

  nativeState(sessionId: string) {
    const runtime = this.require(sessionId);
    return { revision: this.nativeRevision(runtime), nativeId: runtime.nativeId, transport: runtime.state.transport, turnActive: runtime.turnActive,
      stdioCapture: { ...runtime.stdio, maxLineBytes: 256 * 1024, source: 'public SpawnedProcess stdio observer', privateControlsAcknowledgeInteractions: false },
      tasks: [...runtime.state.tasks.values()], planTasks: [...runtime.state.plans.values()], usage: runtime.state.usage,
      rateLimit: runtime.state.rateLimit, auth: runtime.state.auth, structuredOutput: runtime.state.structuredOutput,
      interactions: [...runtime.nativePending.values()].map(({ requestId, kind, payload, status }) => ({ requestId, kind, payload, status })),
      teams: { mode: 'native-surface', reason: '锁定 SDK 没有公开 Teams 成员管理/发送接口；任务 actor 来自原生事件' },
      controls: { perTaskStopAffordance: false, taskStop: 'public-sdk-unverified', interruptAffectsBackground: 'native-defined' },
    };
  }
  nativeTerminalEnvironment(): Record<string, string | undefined> { return { ...process.env, ...this.options.env }; }

  async nativeCatalog(sessionId: string) {
    const runtime = this.require(sessionId);
    const [initialization, models, commands, agents, account, mcp, metadata] = await Promise.all([
      runtime.q.initializationResult(), runtime.q.supportedModels(), runtime.q.supportedCommands(), runtime.q.supportedAgents(), runtime.q.accountInfo(), runtime.q.mcpServerStatus(),
      runtime.nativeId === '' ? Promise.resolve(null) : this.nativeHistory.info(runtime.launchOpts.cwd, runtime.nativeId).catch(error => ({ status: 'unavailable', reason: error instanceof Error ? error.message : String(error) })),
    ]);
    if (this.sessions.get(sessionId) !== runtime) throw nativeError('原生运行实例已替换', 409);
    return { revision: this.nativeRevision(runtime), sdkVersion: PINNED_SDK_VERSION, cliVersion: initialization.claude_code_version,
      nativeId: runtime.nativeId, models, commands, agents, account, metadata,
      // Never return transport config: stdio args, headers, or URL query strings may contain credentials.
      mcp: mcp.map(({ config: _config, ...status }) => status),
      outputStyles: initialization.available_output_styles, outputStyle: initialization.output_style,
      actions: claudeNativeActionCatalog(models).map(action => ({ ...action,
        supported: action.type === 'stop-task' ? false : action.type === 'mcp-resource' ? runtime.capabilities.includes('mcp_read_resource_v1') : action.type === 'dialog' ? Object.keys(this.options.dialogSpecs ?? {}).length > 0 : true,
        ...(action.type === 'stop-task' ? { reason: '公开 stopTask 控制已接入；真实单任务停止闭环尚未验收，perTaskStopAffordance 未开启' } : {}),
      })),
      selected: { model: runtime.model ?? runtime.launchOpts.model, effort: runtime.launchOpts.reasoningEffort,
        ...runtime.nativeOptions }, capabilities: runtime.capabilities, supportedDialogKinds: Object.keys(this.options.dialogSpecs ?? {}),
      unsupported: { teams: 'native-surface', compact: '原生 /compact 命令；SDK 无专用 compact 控制', login: '原生 CLI 登录；SDK accountInfo 只读' },
    };
  }

  async readNativeHistory(sessionId: string, options: { cursor?: string; offset?: number; limit: number }): Promise<unknown> {
    const runtime = this.require(sessionId);
    if (runtime.nativeId === '') throw nativeError('原生会话 ID 尚未建立', 409);
    const offset = options.offset ?? (options.cursor === undefined ? 0 : Number(options.cursor));
    return this.nativeHistory.messages(runtime.launchOpts.cwd, runtime.nativeId, offset, options.limit);
  }

  async executeNativeControl(sessionId: string, value: unknown): Promise<unknown> {
    const action = parseClaudeNativeAction(value);
    const runtime = this.require(sessionId);
    if (runtime.stdio.failed) throw Object.assign(nativeError('Claude 原始记录捕获失败，需要先恢复原生连接', 503), { code: 'uncertain' });
    if (runtime.state.transport !== 'live') throw nativeValidationError('Claude 原生连接已结束，需要恢复会话', 503);
    const initialized = await runtime.q.initializationResult();
    if (initialized.claude_code_version !== PINNED_CLI_VERSION) throw nativeValidationError('Claude 原生版本未知或不匹配，控制已受限', 503);
    const current = (afterDispatch = false): void => { if (this.sessions.get(sessionId) !== runtime) throw (afterDispatch ? nativeError : nativeValidationError)('原生运行实例已替换', 409); };
    current();
    let result: unknown;
    switch (action.type) {
      case 'model': {
        const models = await runtime.q.supportedModels();
        current();
        if (!models.some(model => model.value === action.model || model.resolvedModel === action.model)) throw nativeValidationError('模型不在当前原生目录中');
        await this.setModel(sessionId, action.model);
        return this.nativeCatalog(sessionId);
      }
      case 'effort': {
        const models = await runtime.q.supportedModels();
        current();
        const modelId = runtime.model ?? runtime.launchOpts.model;
        const model = models.find(model => model.value === modelId || model.resolvedModel === modelId);
        if (model?.supportedEffortLevels !== undefined && !model.supportedEffortLevels.includes(action.effort as EffortLevel)) throw nativeValidationError('当前模型不支持该 effort');
        await this.setReasoningEffort(sessionId, action.effort); break;
      }
      case 'thinking':
        if (action.thinking?.type === 'adaptive') {
          const modelId = runtime.model ?? runtime.launchOpts.model;
          const model = (await runtime.q.supportedModels()).find(model => model.value === modelId || model.resolvedModel === modelId);
          if (model !== undefined && model.supportsAdaptiveThinking !== true) throw nativeValidationError('当前原生模型不支持 adaptive thinking');
        }
        current();
        await this.replaceIdleQuery(sessionId, {}, { thinking: action.thinking ?? undefined }); return this.nativeCatalog(sessionId);
      case 'output': await this.replaceIdleQuery(sessionId, {}, { outputFormat: action.schema === null ? undefined : { type: 'json_schema', schema: action.schema } }); return this.nativeCatalog(sessionId);
      case 'checkpoints': await this.replaceIdleQuery(sessionId, {}, { enableFileCheckpointing: action.enabled }); return this.nativeCatalog(sessionId);
      case 'resume-at': {
        if (runtime.nativeId === '') throw nativeValidationError('原生会话 ID 尚未建立', 409);
        const history = await this.nativeHistory.messages(runtime.launchOpts.cwd, runtime.nativeId, 0, 200);
        let found = history.entries.some(message => message.uuid === action.messageId && message.type === 'assistant');
        let next = history;
        while (!found && next.hasMore) { next = await this.nativeHistory.messages(runtime.launchOpts.cwd, runtime.nativeId, next.nextOffset, 200); found = next.entries.some(message => message.uuid === action.messageId && message.type === 'assistant'); }
        if (!found) throw nativeValidationError('resumeSessionAt 必须选择原生助手消息 UUID');
        current();
        await this.replaceIdleQuery(sessionId, {}, { resumeSessionAt: action.messageId }); return this.nativeCatalog(sessionId);
      }
      case 'rewind':
        if (runtime.nativeOptions.enableFileCheckpointing !== true) throw nativeValidationError('此 query 未显式启用原生文件检查点', 409);
        if (!action.dryRun && (runtime.turnActive || runtime.backgroundTasks.size > 0)) throw nativeValidationError('请等待原生任务结束后还原文件', 409);
        result = await runtime.q.rewindFiles(action.messageId, { dryRun: action.dryRun }); break;
      case 'rename': case 'tag': case 'fork': case 'delete':
        if (runtime.nativeId === '') throw nativeValidationError('原生会话 ID 尚未建立', 409);
        if (action.type === 'delete') {
          if (runtime.turnActive || runtime.backgroundTasks.size > 0 || runtime.pending.size > 0 || [...runtime.nativePending.values()].some(pending => pending.status === 'pending')) throw nativeValidationError('原生会话仍有工作，不能删除', 409);
          if (action.confirmNativeId !== runtime.nativeId) throw nativeValidationError('删除确认目标不一致');
          const info = await this.nativeHistory.info(runtime.launchOpts.cwd, runtime.nativeId);
          if (info.revision !== action.revision) throw nativeValidationError('原生会话已改变，请刷新后重试', 409);
          current();
          // Close this writer before deleting its transcript. A failed/uncertain filesystem mutation
          // leaves the runtime closed; it must not silently recreate a possibly-deleted transcript.
          await this.dispose(sessionId);
        }
        result = await this.nativeHistory.mutate(runtime.launchOpts.cwd, runtime.nativeId, action);
        if (action.type === 'fork') {
          const fork = record(result);
          if (typeof fork['sessionId'] !== 'string') throw nativeError('Claude fork 返回缺少原生 sessionId', 502);
          // Preserve the SDK result and expose its real native identity through the durable receipt contract.
          return { ...fork, id: fork['sessionId'] };
        }
        return result;
      case 'mcp-reconnect': result = await runtime.q.reconnectMcpServer(action.serverName); break;
      case 'mcp-toggle': result = await runtime.q.toggleMcpServer(action.serverName, action.enabled); break;
      case 'mcp-resource':
        if (!runtime.capabilities.includes('mcp_read_resource_v1')) throw nativeValidationError('原生 CLI 未声明 MCP resource 读取能力', 409);
        if (!action.uri.startsWith('ui://')) throw nativeValidationError('原生 MCP resource 仅允许 ui:// URI');
        result = await runtime.q.readMcpResource(action.serverName, action.uri); break;
      case 'reload-skills': result = await runtime.q.reloadSkills(); break;
      case 'reload-plugins': result = await runtime.q.reloadPlugins({ holdOnCacheImpact: action.holdOnCacheImpact }); break;
      case 'reload-output-styles': result = await runtime.q.reloadOutputStyles(); break;
      case 'background': result = await runtime.q.backgroundTasks(action.toolUseId); break;
      case 'stop-task': {
        const task = runtime.state.tasks.get(action.taskId);
        if (task === undefined || !['pending', 'running', 'paused'].includes(task.status) || (action.runId !== undefined && task.runId !== action.runId)) throw nativeValidationError('后台任务已结束或 runId 已改变', 409);
        await runtime.q.stopTask(action.taskId); result = { submitted: true, confirmed: false, taskId: action.taskId, runId: task.runId }; break;
      }
      case 'refresh': {
        // The native usage control is explicitly experimental in this pinned SDK; preserve its label.
        const [usage, context] = await Promise.all([runtime.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), runtime.q.getContextUsage({ detail: 'summary' })]);
        current(true); runtime.state.usage = { usage, context, source: 'Claude SDK experimental usage', scope: 'session' }; result = runtime.state.usage; break;
      }
      case 'elicitation': case 'dialog': {
        const pending = runtime.nativePending.get(action.requestId);
        if (pending === undefined || pending.kind !== action.type || pending.status !== 'pending') throw nativeValidationError('原生交互已提交、取消或不存在', 409);
        let reply: ElicitationResult | UserDialogResult;
        if (action.type === 'elicitation') {
          const request = pending.payload as ElicitationRequest;
          if (request.mode === 'url' && action.action === 'accept' && elicitationUrl(request.url ?? '') === null) throw nativeValidationError('原生认证 URL 无效');
          reply = elicitationResult(request.mode === 'url' ? undefined : request.requestedSchema ?? { type: 'object' }, action.action, action.content);
        } else {
          const request = pending.payload as UserDialogRequest;
          const spec = this.options.dialogSpecs?.[request.dialogKind];
          if (action.behavior === 'completed') { if (spec === undefined) throw nativeValidationError('此原生 dialog 没有已验证 renderer'); spec.validateResult(action.result); }
          reply = action.behavior === 'completed' ? { behavior: 'completed', result: action.result } : { behavior: 'cancelled' };
        }
        if (!this.observeNative(runtime, runtime.launchOpts, { i: ++runtime.frameSeq, t: 0, dir: 'out', ch: `${action.type}-result`, frame: { requestId: action.requestId, result: reply } })) throw Object.assign(nativeError('原生交互未持久化', 503), { code: 'uncertain' });
        pending.status = 'submitted'; pending.resolve(reply);
        this.emit(sessionId, { type: 'item.update', itemKey: `claude-native-${action.requestId}`, data: { submission: 'sent' }, scope: 'session' });
        result = { submitted: true, confirmed: false, requestId: action.requestId }; break;
      }
    }
    current(true);
    return result ?? { applied: true, revision: this.nativeRevision(runtime) };
  }

  private async nativeCallback(sessionId: string, runtime: SessionRuntime | undefined, kind: 'elicitation' | 'dialog', payload: ElicitationRequest | UserDialogRequest, options: { signal: AbortSignal; requestId: string }): Promise<ElicitationResult | UserDialogResult> {
    const cancelled = kind === 'elicitation' ? { action: 'cancel' as const } : { behavior: 'cancelled' as const };
    if (runtime === undefined || this.sessions.get(sessionId) !== runtime) return cancelled;
    const existing = runtime.nativePending.get(options.requestId);
    if (existing !== undefined) {
      if (existing.kind !== kind || JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
        this.emit(sessionId, { type: 'item.complete', itemKey: `claude-native-conflict-${options.requestId}`, kind: 'notice', data: { level: 'warning', text: 'Claude 原生 requestId 对应了冲突的交互内容，已取消冲突请求', nativeType: 'native-interaction/conflict' }, scope: 'session' });
        return cancelled;
      }
      return existing.promise;
    }
    if (!this.observeNative(runtime, runtime.launchOpts, { i: ++runtime.frameSeq, t: 0, dir: 'in', ch: kind, frame: { requestId: options.requestId, payload } })) return cancelled;
    if (kind === 'dialog') {
      const dialog = payload as UserDialogRequest;
      const spec = this.options.dialogSpecs?.[dialog.dialogKind];
      if (spec === undefined) {
        this.emit(sessionId, { type: 'item.complete', itemKey: `claude-native-${options.requestId}`, kind: 'notice', data: { level: 'warning', text: `Claude 原生对话 ${dialog.dialogKind} 没有已验证的 Web renderer，已取消；可使用原生界面`, nativeType: 'request_user_dialog/unsupported' }, native: payload, scope: 'session' });
        return cancelled;
      }
      try { spec.validateRequest(dialog.payload); } catch { return cancelled; }
    }
    let resolve: NativePending['resolve'] = () => undefined;
    const promise = new Promise<ElicitationResult | UserDialogResult>(res => { resolve = res; });
    const pending: NativePending = { requestId: options.requestId, kind, payload, status: 'pending', promise, resolve };
    runtime.nativePending.set(options.requestId, pending);
    if (kind === 'elicitation') {
      const request = payload as ElicitationRequest;
      const elicitation = request.mode === 'url' ? { kind: 'url' as const, serverName: request.serverName, url: request.url ?? '', elicitationId: request.elicitationId ?? options.requestId }
        : { kind: 'form' as const, serverName: request.serverName, schema: request.requestedSchema ?? { type: 'object' } };
      this.emit(sessionId, { type: 'item.complete', itemKey: `claude-native-${options.requestId}`, kind: 'question', data: {
        questionId: options.requestId, prompt: request.message, header: request.title, isSecret: schemaHasSecrets(request.requestedSchema), elicitation, status: 'pending',
      }, native: { requestId: options.requestId, payload }, scope: 'session' });
    } else this.emit(sessionId, { type: 'item.complete', itemKey: `claude-native-${options.requestId}`, kind: 'internal', data: { nativeType: 'request_user_dialog' }, native: { requestId: options.requestId, payload }, scope: 'session' });
    const abort = (): void => {
      pending.status = 'cancelled'; pending.resolve(cancelled);
      if (this.sessions.get(sessionId) === runtime) this.emit(sessionId, { type: 'item.cancel', itemKey: `claude-native-${options.requestId}`, scope: 'session' });
    };
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    try {
      const result = await promise;
      if (this.sessions.get(sessionId) !== runtime) return cancelled;
      return result;
    } finally {
      options.signal.removeEventListener('abort', abort);
      // Keep recent receipts for reinitialize redelivery; never submit an already-resolved request twice.
      if (runtime.nativePending.size > 128) for (const [id, item] of runtime.nativePending) if (item.status !== 'pending') { runtime.nativePending.delete(id); if (runtime.nativePending.size <= 128) break; }
    }
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
    const items = [...runtime.state.plans.values()].map(task => ({ text: task.text, status: task.status }));
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
          isSecret: question['isSecret'] === true,
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
        runtime.state.system(message);
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
          runtime.model = message.model;
          runtime.capabilities = message.capabilities ?? [];
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
          const failed = block['is_error'] === true || item.name === 'TaskUpdate' && record(message.tool_use_result)['success'] === false;
          if (runtime.state.toolResult(item.name, item.input, message.tool_use_result, failed)) this.emitTaskPanel(sessionId, runtime);
          if (item.name === 'TodoWrite' && !failed) {
            const todos = record(message.tool_use_result)['newTodos'];
            if (Array.isArray(todos)) this.emit(sessionId, { type: 'item.complete', itemKey: `plan-${toolId}`, kind: 'plan', data: {
              items: todos.map(value => record(value)).filter(todo => typeof todo['content'] === 'string' && ['pending', 'in_progress', 'completed'].includes(String(todo['status']))).map(todo => ({ text: todo['content'], status: todo['status'] })),
            }, native: message });
          }
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
              data: { ...(item.data as EventData['tool.call']), status: failed ? 'failed' : 'completed', output },
              native: message,
            });
          }
        }
        return;
      }
      case 'result': {
        runtime.turnActive = message.queued_turn_count !== undefined && message.queued_turn_count > 0;
        for (const event of runtime.content.flush(message.session_id)) this.emit(sessionId, event);
        const result = message as unknown as { subtype?: string; is_error?: boolean; duration_ms?: number; total_cost_usd?: number; modelUsage?: Record<string, unknown>; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
        runtime.state.usage = { scope: 'session', source: 'Claude result cumulative modelUsage', totalCostUsd: result.total_cost_usd, modelUsage: result.modelUsage, mainLoopTurnUsage: result.usage };
        runtime.state.structuredOutput = 'structured_output' in message ? message.structured_output : undefined;
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
            : { usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, cacheReadInputTokens: result.usage.cache_read_input_tokens, cacheCreationInputTokens: result.usage.cache_creation_input_tokens, scope: 'turn', ...(generationMs === undefined ? {} : { generationMs }) } }),
          native: result,
        });
        return;
      }
      case 'auth_status':
        runtime.state.auth = message;
        this.emit(sessionId, { type: 'item.complete', itemKey: `claude-auth-${runtime.frameSeq}`, kind: 'internal', data: { nativeType: 'auth_status' }, native: message, scope: 'session' });
        return;
      case 'rate_limit_event':
        runtime.state.rateLimit = message;
        this.emit(sessionId, { type: 'item.complete', itemKey: `claude-rate-limit-${runtime.frameSeq}`, kind: 'internal', data: { nativeType: 'rate_limit_event' }, native: message, scope: 'session' });
        return;
      default:
        this.emit(sessionId, { type: 'item.complete', itemKey: `unknown-sdk-${runtime.frameSeq}`, kind: 'unknown', data: { nativeType: message.type }, native: message });
        return;
    }
  }
}

export { userMessage };
