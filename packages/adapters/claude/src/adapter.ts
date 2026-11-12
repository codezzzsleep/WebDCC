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
} from '@webdcc/protocol';
import {
  query,
  type CanUseTool,
  type EffortLevel,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { buildFileChanges, isValidEventData, traceFrame } from '@webdcc/protocol';

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
      queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
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
  messageSeq: number;
  /** 会话的任务列表（F19：由 TaskCreate / TaskUpdate 及其结果算出） */
  tasks: Map<string, { text: string; status: 'pending' | 'in_progress' | 'completed' }>;
  taskOrder: string[];
  /** init 消息里的斜杠命令（F8） */
  slashCommands: string[];
  /** 这一块是否已经发过 item.start（SDK 不一定给 block-start，按首个 delta 兜底） */
  liveStarted: boolean;
  liveItems: Map<number, { itemKey: string; kind: 'reasoning' | 'assistant.message'; text: string }>;
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
      ...(opts.model === undefined ? {} : { model: opts.model }),
      launchOpts: opts,
      input,
      q,
      pump: Promise.resolve(),
      turnStartedAt: Date.now(),
      generationStartedAt: null,
      generationMs: 0,
      pending: new Map(),
      toolItems: new Map(),
      messageSeq: 0,
      tasks: new Map(),
      taskOrder: [],
      slashCommands: [],
      liveStarted: false,
      liveItems: new Map(),
      ready,
      frameSeq: 0,
    };
    this.sessions.set(sessionId, runtime);
    runtime.pump = (async () => {
      for await (const message of q as AsyncIterable<SDKMessage>) {
        runtime.frameSeq += 1;
        traceFrame(this.options.traceSink, { i: runtime.frameSeq, t: Date.now() - runtime.turnStartedAt, dir: 'in', ch: 'sdk', frame: message });
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
        itemKey: `error-${runtime.frameSeq}`,
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
    runtime.generationStartedAt = null;
    runtime.generationMs = 0;
    traceFrame(this.options.traceSink, { i: ++runtime.frameSeq, t: 0, dir: 'out', ch: 'input', frame: input });
    const images = (input.images ?? []).flatMap((image) => {
      try {
        const mediaType = (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mime) ? image.mime : 'image/png') as
          | 'image/png'
          | 'image/jpeg'
          | 'image/gif'
          | 'image/webp';
        return [{ media_type: mediaType, data: readFileSync(image.path).toString('base64') }];
      } catch {
        return [];
      }
    });
    runtime.input.push(input.text, images.length === 0 ? undefined : images);
  }

  /** 切换访问模式（F6）：Claude Code 用 SDK 的 setPermissionMode */
  async setAccessMode(sessionId: string, mode: string): Promise<{ accessMode: string }> {
    const runtime = this.require(sessionId);
    await runtime.q.setPermissionMode(mode as never);
    return { accessMode: mode };
  }

  /** Claude Agent SDK 支持在同一个 query 上切换模型。必须调用控制面，
   * 只更新 WebDCC 会话元数据会让下一轮仍然使用旧模型。 */
  async setModel(sessionId: string, model: string): Promise<void> {
    const runtime = this.require(sessionId);
    runtime.model = model;
    // The pinned SDK exposes setModel, but the bundled CLI keeps honoring the
    // launch-time ANTHROPIC_MODEL in settings for subsequent prompts. Restart
    // the query against the same native session so the model is applied to the
    // next request while preserving conversation history.
    const previous = runtime;
    previous.launchOpts = { ...previous.launchOpts, model };
    this.sessions.delete(sessionId);
    // `close()` is synchronous in the SDK and can block while the child
    // process drains stdin. Schedule it after the replacement query has been
    // created so the command acknowledgement never waits on process teardown.
    const close = previous.q.close;
    if (typeof close === 'function') setImmediate(() => { try { close.call(previous.q); } catch { /* old query is being replaced */ } });
    const replacement = this.startQuery(sessionId, previous.launchOpts, previous.nativeId);
    await Promise.race([replacement.ready, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  }

  /** Claude Code 的 effort 可通过 SDK 控制面在下一轮生效，并在重连时由 launchOpts 恢复。 */
  async setReasoningEffort(sessionId: string, effort: string): Promise<void> {
    const runtime = this.require(sessionId);
    const value = toClaudeEffort(effort);
    await runtime.q.applyFlagSettings({ effortLevel: value });
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
    if (runtime === undefined || pending === undefined) return;
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

  private finishGeneration(runtime: SessionRuntime): void {
    if (runtime.generationStartedAt === null) return;
    runtime.generationMs += Math.max(1, Date.now() - runtime.generationStartedAt);
    runtime.generationStartedAt = null;
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
    if (toolName === 'AskUserQuestion') {
      const questions = (input['questions'] as Record<string, unknown>[]) ?? [];
      const questionId = `${options.toolUseID ?? `q-${runtime.frameSeq + 1}`}`;
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
      const decision = await questionPromise;
      const answers = decision.answers ?? {};
      return { behavior: 'allow', updatedInput: { ...input, answers } } as PermissionResult;
    }

    const isPlanMode = toolName === 'ExitPlanMode';
    const approvalId = `${sessionId}:${options.toolUseID ?? `tool-${runtime.frameSeq + 1}`}`;
    const decisionPromise = new Promise<{ approved: boolean; optionId: string; answers?: Record<string, unknown>; annotations?: Record<string, unknown> }>((resolve) => {
      runtime.pending.set(approvalId, { kind: 'approval', toolName, input, resolve });
    });
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
        if (message.subtype === 'init') {
          const initMessage = message as unknown as { slash_commands?: string[]; slashCommands?: string[] };
          runtime.slashCommands = initMessage.slash_commands ?? initMessage.slashCommands ?? [];
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
          runtime.generationStartedAt ??= Date.now();
          runtime.messageSeq += 1;
          runtime.liveStarted = true;
          const index = typeof event.index === 'number' ? event.index : runtime.messageSeq;
          const blockType = event.content_block?.type ?? event.block?.type ?? 'text';
          const itemKey = `msg-${runtime.messageSeq}-${index}`;
          const kind = blockType === 'thinking' ? 'reasoning' : 'assistant.message';
          runtime.liveItems.set(index, { itemKey, kind, text: '' });
          this.emit(sessionId, {
            type: 'item.start',
            itemKey,
            kind,
            data: { text: '' },
          });
          return;
        }
        if (event.type === 'content_block_delta') {
          runtime.generationStartedAt ??= Date.now();
          const delta = event.delta ?? {};
          const index = typeof event.index === 'number' ? event.index : runtime.messageSeq;
          let live = runtime.liveItems.get(index);
          if (live === undefined) {
            const kind = delta.type === 'thinking_delta' ? 'reasoning' : 'assistant.message';
            live = { itemKey: `msg-${runtime.messageSeq}-${index}`, kind, text: '' };
            runtime.liveItems.set(index, live);
            this.emit(sessionId, { type: 'item.start', itemKey: live.itemKey, kind, data: { text: '' } });
          }
          if (delta.type === 'text_delta' && delta.text !== undefined) {
            live.text += delta.text;
            this.emit(sessionId, { type: 'item.delta', itemKey: live.itemKey, field: 'text', append: delta.text });
          }
          if (delta.type === 'thinking_delta' && delta.thinking !== undefined) {
            live.text += delta.thinking;
            this.emit(sessionId, { type: 'item.delta', itemKey: live.itemKey, field: 'text', append: delta.thinking });
          }
        }
        return;
      }
      case 'assistant': {
        this.finishGeneration(runtime);
        const content = (message.message?.content ?? []) as unknown as Record<string, unknown>[];
        const textParts = content.filter((block) => block['type'] === 'text').map((block) => String(block['text'] ?? ''));
        const thinking = content.filter((block) => block['type'] === 'thinking').map((block) => String(block['thinking'] ?? '')).join('');
        const hadLive = runtime.liveItems.size > 0;
        for (const [index, live] of [...runtime.liveItems]) {
          const text = live.kind === 'reasoning' ? thinking : textParts.join('\n');
          this.emit(sessionId, { type: 'item.complete', itemKey: live.itemKey, kind: live.kind, data: { text }, native: message });
          runtime.liveItems.delete(index);
        }
        if (!hadLive && thinking !== '' && textParts.length === 0) {
          this.emit(sessionId, { type: 'item.complete', itemKey: `msg-${runtime.messageSeq}-thinking`, kind: 'reasoning', data: { text: thinking }, native: message });
        }
        if (!hadLive && textParts.length > 0 && content.length > 0) {
          const key = `msg-${runtime.messageSeq}-complete`;
          this.emit(sessionId, { type: 'item.complete', itemKey: key, kind: 'assistant.message', data: { text: textParts.join('\n') }, native: message });
        }
        for (const block of content) {
          if (block['type'] !== 'tool_use') continue;
          const toolId = String(block['id'] ?? '');
          const name = String(block['name'] ?? '');
          const kind = toolKind(name);
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
            });
          } else if (item.kind === 'file.read') {
            this.emit(sessionId, { type: 'item.complete', itemKey: item.itemKey, kind: 'file.read', data: item.data as EventData['file.read'] });
          } else if (item.kind === 'file.change') {
            this.emit(sessionId, {
              type: 'item.complete',
              itemKey: item.itemKey,
              kind: 'file.change',
              data: { changes: buildFileChanges(item.name, item.input), status: block['is_error'] === true ? 'failed' : 'completed' },
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
        this.finishGeneration(runtime);
        const generationMs = runtime.generationMs > 0 ? runtime.generationMs : undefined;
        runtime.generationMs = 0;
        const resultText = (message as unknown as { result?: unknown }).result;
        if (typeof resultText === 'string' && resultText !== '') {
          this.emit(sessionId, { type: 'item.complete', itemKey: `result-${runtime.frameSeq}`, kind: 'assistant.message', data: { text: resultText, nativePhase: 'final_result' }, native: message });
        }
        this.emit(sessionId, {
          type: 'turn.end',
          status: result.is_error === true ? (result.subtype === 'error_during_execution' ? 'interrupted' : 'failed') : 'completed',
          ...(result.usage === undefined
            ? {}
            : { usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, scope: 'turn', ...(generationMs === undefined ? {} : { generationMs }) } }),
          native: result,
        });
        return;
      }
      default:
        return;
    }
  }
}

export { userMessage };
