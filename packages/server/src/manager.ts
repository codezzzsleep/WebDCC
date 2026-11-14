import type {
  AdapterEvent,
  ProviderRuntimeConfig,
  AgentAdapter,
  AgentId,
  ApprovalDecision,
  EventData,
  EventKind,
  FeedPatch,
  SessionDto,
  StoredEvent,
  UserInput,
  AnswerSubmission,
  RuntimeIdentity,
  ReconciliationView,
  NativeObservation,
  NativeControlSnapshot,
  NativeActionRequest,
  NativeActionResponse,
  InputContent,
  ResolvedInputPart,
} from '@webdcc/protocol';
import { randomUUID } from 'node:crypto';
import { initialPermissions, isInputContent, nativeAccessMode, normalizeQuestionAnswer, observePermissions, publicInputContent, ulid } from '@webdcc/protocol';
import type { Store } from './store.js';
import { findUserEcho, resolveAnswer } from '@webdcc/protocol';
import { TurnTracker } from './turn-tracker.js';
import { CodexWatchdog } from './watchdog.js';
import type { InteractionRecorder } from './interaction-recorder.js';
import type { ModelRecording } from './model-recording.js';
import type { CreateOpts } from '@webdcc/protocol';
import type { InteractionRow } from './interactions.js';
import { payloadHash } from './command-journal.js';
import type { FileStore } from './files.js';

const TURN_SETTLE_MS = 1_500;
const hotKey = (turnId: string | null, itemKey: string): string => JSON.stringify([turnId, itemKey]);

export interface HotItem {
  itemKey: string;
  kind: EventKind;
  data: EventData[EventKind];
  turnId: string | null;
}

export interface Runtime {
  identity: RuntimeIdentity;
  sessionId: string;
  adapter: AgentAdapter;
  workspacePath: string;
  nativeId: string;
  status: Exclude<SessionDto['status'], never>;
  turnId: string | null;
  turnStartedAt: number | null;
  hot: Map<string, HotItem>;
  completedItems?: Set<string>;
  idleTimer: NodeJS.Timeout | null;
  nativeActivity?: number;
  /** Codex 等 adapter 可能在 turn/end 后补发 item/diff；在终止前给它们一个收敛窗口。 */
  finishTimer: NodeJS.Timeout | null;
  finishAction: ((followedByNativeTurn?: boolean) => void) | null;
  queued: { turnId: string; input: UserInput; clientCommandId?: string }[];
  disposing: boolean;
  ownershipTimer: NodeJS.Timeout | null;
}

export interface ManagerHooks {
  onFeed: (sessionId: string, patch: FeedPatch, feedSeq: number) => void;
  onEvent: (event: StoredEvent) => void;
  onDelta: (sessionId: string, itemKey: string, field: 'text' | 'output', append: string, turnId?: string | null) => void;
  onUpdate: (sessionId: string, itemKey: string, data: unknown, turnId?: string | null) => void;
  onStatus: (sessionId: string, status: SessionDto['status']) => void;
}

export interface SendResult { turnId: string; queued: boolean; confirmed?: boolean }
const knownUnsubmittedInput = (error: unknown): boolean => error !== null && typeof error === 'object' && (error as { nativeAdmission?: unknown }).nativeAdmission === 'not-submitted';

export class SessionManager {
  readonly watchdog: CodexWatchdog;
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly runtimes = new Map<string, Runtime>();
  private readonly turns = new TurnTracker();
  private readonly activations = new Map<string, Promise<Runtime>>();
  private readonly activationStops = new Set<string>();
  private readonly controls = new Map<string, Promise<unknown>>();
  private readonly uncertainSessions = new Set<string>();
  private readonly ownerId = randomUUID();
  private files?: FileStore;
  private hooks: ManagerHooks = {
    onFeed: () => undefined,
    onEvent: () => undefined,
    onDelta: () => undefined,
    onUpdate: () => undefined,
    onStatus: () => undefined,
  };

  constructor(
    private readonly store: Store,
    private readonly options: {
      idleDisposeMin: number;
      resolveProvider?: (id: string | null) => ProviderRuntimeConfig | null;
      /** 把 diff 文本存成文件，返回 fileId（C2 / F10） */
      saveDiff?: (name: string, diff: string) => string;
      watchdogDataDir?: string;
      recorder?: InteractionRecorder;
      modelRecording?: ModelRecording;
      files?: FileStore;
    },
  ) {
    this.files = options.files;
    const recoverable = new Set(this.store.nativeOwners.recoverableSessions());
    this.store.journal.recover([...recoverable]);
    for (const row of this.store.interactions.recover([...recoverable])) this.persistInteractionSubmission(row, 'uncertain');
    // An unfinished legacy turn has no verifiable native outcome. Preserve it
    // and prevent new sends until native reconciliation establishes ownership.
    for (const session of this.store.listSessions(true)) {
      if (!recoverable.has(session.id)) continue;
      if (session.permissions !== undefined && session.permissions.phase !== 'failed') {
        const permissions = { ...session.permissions, phase: 'unknown' as const, revision: session.permissions.revision + 1 };
        this.store.updateSessionAndFeed(session.id, { permissions, touch: false }, { permissions });
      }
      const events = this.store.allEvents(session.id);
      const started = events.filter((event) => event.kind === 'turn.started');
      for (const begin of started) {
        if (events.some((event) => event.turnId === begin.turnId && event.kind === 'turn.completed')) continue;
        this.uncertainSessions.add(session.id);
        if (!events.some(event => event.itemKey === `turn-uncertain-${begin.turnId}`)) this.store.appendEvent({
          sessionId: session.id,
          turnId: begin.turnId,
          itemKey: `turn-uncertain-${begin.turnId}`,
          kind: 'notice',
          data: { level: 'warning', text: '服务重启，上次原生执行结果待核对；已接受的队列保留，暂不自动重发。', nativeType: 'command-uncertain' },
        });
        this.store.updateSessionAndFeed(session.id, { status: 'error' }, { status: 'error', queueRevision: Date.now() });
      }
    }
    this.watchdog = new CodexWatchdog(store, {
      isActive: (id) => {
        const owner = this.store.nativeOwners.get(id);
        if (owner !== undefined && owner.ownerId !== this.ownerId && (owner.state === 'opening' || owner.state === 'active')) return true;
        const runtime = this.runtimes.get(id);
        const unanswered = this.store.allEvents(id).filter((event) => event.kind === 'question');
        const lastQuestions = new Map(unanswered.map((event) => [(event.data as EventData['question']).questionId, event.data as EventData['question']]));
        return runtime?.turnId != null || runtime?.status === 'waiting' || runtime?.status === 'running' || this.pendingApprovalIds(id).length > 0 || [...lastQuestions.values()].some((question) => question.status !== 'answered' && question.status !== 'skipped');
      },
      create: (source) => this.createSession({
        workspaceId: source.workspaceId, agent: 'codex', providerId: source.providerId ?? null,
        ...(source.model === undefined ? {} : { model: source.model }),
        ...(source.reasoningEffort === undefined ? {} : { reasoningEffort: source.reasoningEffort }),
        ...(source.accessMode === undefined ? {} : { accessMode: source.accessMode }),
        title: `${source.title ?? 'Codex 任务'} · 自动接续`, parentId: source.id, handoffKind: 'watchdog',
      }),
      send: async (id, text, commandId, allowed) => { await this.send(id, { text }, commandId, allowed); },
      dispose: (id) => this.dispose(id),
      notice: (id, text) => {
        const event = this.store.appendEvent({ sessionId: id, turnId: null, itemKey: `watchdog-${ulid()}`, kind: 'notice', data: { level: 'info', text, nativeType: 'watchdog' } });
        this.hooks.onEvent(event);
      },
    }, options.watchdogDataDir);
  }

  registerAdapter(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
    adapter.bindGlobalNativeEvents?.({ record: frame => {
      const value = frame.frame !== null && typeof frame.frame === 'object' ? frame.frame as { dshTransport?: { verifiedHostFingerprint?: unknown } } : {};
      const fingerprint = value.dshTransport?.verifiedHostFingerprint;
      const host = typeof fingerprint === 'string' && /^[0-9a-f]{64}$/.test(fingerprint) ? fingerprint : 'unverified';
      const sessionId = `@native-host:${adapter.id}:${this.store.nativeOwners.hostId}:${host}`;
      try { return { envelopeId: this.store.nativeEvents.frame({ sessionId, agent: adapter.id }, frame, true), accepted: true }; }
      catch { return { envelopeId: 0, accepted: false }; }
    } });
    adapter.onEvent((sessionId, event) => this.handleAdapterEvent(sessionId, event, adapter));
    if (adapter.id === 'codex') this.watchdog.start();
  }

  private async prepareLaunch<T extends CreateOpts>(session: SessionDto, opts: T): Promise<T> {
    const runtime = this.runtimes.get(session.id);
    if (runtime === undefined) throw new Error('原生实例尚未绑定运行身份');
    this.store.nativeEvents.addSecret(opts.provider?.apiKey);
    opts = { ...opts, runtime: runtime.identity,
      onManagedProcess: (pid, profilePath, nativeVersion) => this.store.nativeOwners.bindProcess(session.id, runtime.identity, pid, profilePath, nativeVersion),
      nativeEvents: { record: frame => {
      try {
        const accepted = !runtime.disposing && this.runtimes.get(session.id) === runtime && this.store.nativeOwners.current(session.id, runtime.identity);
        const envelopeId = this.store.nativeEvents.frame({ sessionId: session.id, agent: session.agent, nativeId: runtime.nativeId, identity: runtime.identity }, frame, accepted);
        if (accepted && frame.dir === 'in') {
          const record = this.store.nativeEvents.get(envelopeId);
          this.store.nativeOwners.observe(session.id, runtime.identity, this.store.nativeOwners.get(session.id)?.activeNativeTurnId ?? null, record?.nativeSeq ?? undefined);
        }
        return { envelopeId, accepted };
      } catch {
        this.fenceRuntime(runtime);
        return { envelopeId: 0, accepted: false };
      }
    } } };
    if (opts.accessMode === 'inherit') { const { accessMode: _accessMode, ...rest } = opts; void _accessMode; opts = rest as T; }
    const recorder = this.options.recorder;
    if (recorder === undefined) return opts;
    recorder.bind({ sessionId: session.id, agent: session.agent as AgentId, workspaceId: session.workspaceId, cwd: opts.cwd, nativeId: session.nativeId, model: opts.model, providerId: opts.providerId });
    const traced = { ...opts, traceSink: recorder.sink(session.id) };
    if (this.adapters.get(session.agent)?.kind === 'fake') return traced;
    return this.options.modelRecording?.prepare(traced, session.agent as AgentId) as Promise<T> | undefined ?? traced;
  }

  adapter(id: AgentId): AgentAdapter | undefined {
    return this.adapters.get(id);
  }
  optionsProvider(id: string): ProviderRuntimeConfig | null { return this.options.resolveProvider?.(id) ?? null; }
  holdNativeActivity(sessionId: string): () => void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) throw this.nativeControlRejected('原生连接尚未激活');
    this.assertOwner(runtime);
    runtime.nativeActivity = (runtime.nativeActivity ?? 0) + 1;
    if (runtime.idleTimer !== null) clearTimeout(runtime.idleTimer);
    runtime.idleTimer = null;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      runtime.nativeActivity = Math.max(0, (runtime.nativeActivity ?? 1) - 1);
      if (this.runtimes.get(sessionId) === runtime && !runtime.disposing) this.touchIdle(runtime);
    };
  }

  adaptersList(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  /** 权限档位是安全边界，不能只依赖前端菜单的可见项。 */
  private defaultAccessMode(adapter: AgentAdapter): string | undefined {
    return adapter.kind === 'fake' ? adapter.accessModes()[0]?.id : undefined;
  }

  private async assertAccessMode(adapter: AgentAdapter, mode: string | undefined): Promise<void> {
    if (mode === undefined || mode === '' || mode === 'inherit') return;
    const options = adapter.listAccessModes === undefined ? adapter.accessModes() : await adapter.listAccessModes();
    const allowed = new Set(options.filter(option => option.allowed !== false && option.implemented !== false).map((item) => item.id));
    // Codex 的原生 permissionProfile/list 返回带冒号的 id，而旧版配置
    // 与下一轮参数仍接受无冒号别名。
    if (adapter.id === 'codex') {
      for (const id of ['read-only', 'workspace', 'danger-full-access']) if (allowed.has(id) || allowed.has(`:${id}`)) { allowed.add(id); allowed.add(`:${id}`); }
    }
    if (!allowed.has(mode)) throw Object.assign(new Error(`${adapter.id}: 不支持的访问模式 ${mode}`), { statusCode: 400 });
    if (adapter.id === 'claude-code' && mode === 'bypassPermissions' && typeof process.getuid === 'function' && process.getuid() === 0) {
      throw Object.assign(new Error('以 root 运行时 Claude Code 不允许 bypassPermissions'), { statusCode: 400 });
    }
  }

  setHooks(hooks: ManagerHooks): void {
    this.hooks = hooks;
  }

  getRuntime(sessionId: string): Runtime | undefined {
    return this.runtimes.get(sessionId);
  }

  /** Opening native controls is an explicit user operation. Reading a page
   * never creates/resumes a native writer or drains the input queue. */
  async connectNativeControls(sessionId: string, request: NativeActionRequest): Promise<NativeActionResponse> {
    this.requireSession(sessionId);
    return this.store.nativeActions.execute(sessionId, request, () => this.control(sessionId, async () => {
      if (request.action.type !== 'connect' || Object.keys(request.action).length !== 1) throw this.nativeControlRejected('无效的连接操作', 400);
      const session = this.requireSession(sessionId);
      const adapter = this.adapters.get(session.agent);
      if (adapter?.nativeState === undefined) throw this.nativeControlRejected('此 Agent 没有原生控制入口', 501);
      const workspace = this.requireWorkspace(session.workspaceId);
      if (session.nativeId === undefined && this.runtimes.get(sessionId) === undefined) throw this.nativeControlRejected('此会话尚未建立原生身份，请新建会话或核对失败的创建');
      await this.ensureReady(session, workspace.path);
      return this.nativeControls(sessionId);
    }));
  }

  private nativeControlRejected(message: string, statusCode = 409): Error {
    return Object.assign(new Error(message), { statusCode, code: 'native-control-rejected' });
  }

  async nativeControls(sessionId: string, includeCatalog = false): Promise<NativeControlSnapshot> {
    const session = this.requireSession(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (runtime?.adapter.nativeState === undefined) throw this.nativeControlRejected('原生控制尚未连接，请显式连接或核对恢复');
    this.assertOwner(runtime);
    const state = await runtime.adapter.nativeState(sessionId);
    const catalog = await runtime.adapter.nativeCatalog?.(sessionId);
    this.assertOwner(runtime);
    return { sessionId, agent: session.agent as AgentId, nativeId: session.nativeId ?? null, runtime: runtime.identity,
      revision: payloadHash({ runtime: runtime.identity, state, catalog }), state, ...(!includeCatalog || catalog === undefined ? {} : { catalog }) };
  }

  async executeNativeControl(sessionId: string, request: NativeActionRequest): Promise<NativeActionResponse> {
    this.requireSession(sessionId);
    return this.store.nativeActions.execute(sessionId, request, () => this.control(sessionId, async () => {
      if (!request.revision) throw this.nativeControlRejected('缺少已读取的原生状态版本', 400);
      const snapshot = await this.nativeControls(sessionId);
      if (snapshot.revision !== request.revision) throw this.nativeControlRejected('原生状态已变化，请刷新核对后重新操作');
      const runtime = this.runtimes.get(sessionId)!;
      if (runtime.adapter.executeNativeControl === undefined) throw this.nativeControlRejected('此 Agent 未公开该控制', 501);
      const state = snapshot.state as { revision?: string };
      const action = runtime.adapter.id === 'dsh' ? { ...request.action, revision: state.revision } : request.action;
      this.store.nativeActions.bind(request.commandId, runtime.identity, snapshot.nativeId ?? runtime.nativeId);
      // Interactive reply bodies stay ephemeral; disable native body capture
      // before resolving an SDK/Host callback that can echo a split secret.
      if (['elicitation', 'dialog'].includes(action.type)) this.store.nativeEvents.restrictSession(sessionId);
      if (['elicitation', 'dialog'].includes(action.type)) {
        const secrets = (value: unknown): void => {
          if (typeof value === 'string' && value) this.store.nativeEvents.addSecret(value);
          else if (Array.isArray(value)) value.forEach(secrets);
          else if (value !== null && typeof value === 'object') Object.values(value).forEach(secrets);
        };
        secrets(action['content'] ?? action['result']);
      }
      const result = await runtime.adapter.executeNativeControl(sessionId, action);
      // Native delete may intentionally dispose the runtime. Other operations
      // must still belong to the same writer after the awaited native result.
      if (action.type !== 'delete' && action.type !== 'archive') this.assertOwner(runtime);
      if (action.type === 'delete' || action.type === 'archive') {
        await this.dispose(sessionId);
        this.updateSessionAndFeed(sessionId, { archived: true }, { archived: true });
      }
      if (action.type === 'model' && typeof action['model'] === 'string') this.updateSessionAndFeed(sessionId, { model: action['model'] }, { model: action['model'] });
      if (action.type === 'effort' && typeof action['effort'] === 'string') this.updateSessionAndFeed(sessionId, { reasoningEffort: action['effort'] }, { reasoningEffort: action['effort'] });
      return result;
    }));
  }

  async readNativeHistory(sessionId: string, options: { cursor?: string; offset?: number; limit: number }): Promise<unknown> {
    this.requireSession(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (runtime?.adapter.readNativeHistory === undefined) throw this.nativeControlRejected('原生历史入口尚不可用', 501);
    this.assertOwner(runtime);
    const result = await runtime.adapter.readNativeHistory(sessionId, options);
    this.assertOwner(runtime);
    return result;
  }

  private async observeNative(sessionId: string): Promise<NativeObservation> {
    const session = this.requireSession(sessionId);
    const adapter = this.adapters.get(session.agent);
    if (adapter?.observe === undefined) throw Object.assign(new Error('此原生运行时的只读对账尚不可用'), { statusCode: 501 });
    if (!session.nativeId) throw Object.assign(new Error('会话没有可核对的原生身份'), { statusCode: 409 });
    const workspace = this.requireWorkspace(session.workspaceId);
    return adapter.observe({ sessionId, cwd: workspace.path, nativeId: session.nativeId, providerId: null,
      nativeEvents: { record: frame => {
        try { return { envelopeId: this.store.nativeEvents.frame({ sessionId, agent: session.agent, nativeId: session.nativeId! }, frame, true), accepted: true }; }
        catch { return { envelopeId: 0, accepted: false }; }
      } } });
  }

  async reconcile(sessionId: string): Promise<ReconciliationView> {
    return this.control(sessionId, async () => this.store.reconciliations.capture(sessionId, await this.observeNative(sessionId)));
  }

  async applyReconciliation(sessionId: string, revision: string): Promise<ReconciliationView> {
    return this.control(sessionId, async () => {
      if (this.runtimes.has(sessionId) || this.activations.has(sessionId)) throw Object.assign(new Error('托管实例尚未关闭，请重新读取状态'), { statusCode: 409 });
      const preview = this.store.reconciliations.get(sessionId, revision);
      if (preview === null || !preview.canApply || preview.applied) throw Object.assign(new Error('核对记录不可应用，请重新读取状态'), { statusCode: 409 });
      const fresh = await this.observeNative(sessionId);
      const result = this.store.reconciliations.apply(sessionId, revision, fresh);
      this.uncertainSessions.delete(sessionId);
      for (const event of result.events) this.hooks.onEvent(event);
      this.hooks.onFeed(sessionId, { status: 'idle', queueRevision: Date.now() }, result.feedSeq);
      return result.view;
    });
  }

  hotItems(sessionId: string): HotItem[] {
    return [...(this.runtimes.get(sessionId)?.hot.values() ?? [])];
  }

  // ---------- 生命周期 ----------

  async createSession(input: {
    workspaceId: string;
    agent: AgentId;
    providerId?: string | null;
    model?: string;
    reasoningEffort?: string;
    accessMode?: string;
    title?: string;
    parentId?: string;
    handoffKind?: SessionDto['handoffKind'];
  }): Promise<SessionDto> {
    const adapter = this.adapters.get(input.agent);
    if (adapter === undefined) throw Object.assign(new Error(`没有可用的 ${input.agent} adapter`), { statusCode: 400 });
    const accessMode = input.accessMode ?? this.defaultAccessMode(adapter);
    await this.assertAccessMode(adapter, accessMode);
    const workspace = this.store.getWorkspace(input.workspaceId);
    if (workspace === undefined) throw Object.assign(new Error('工作区不存在'), { statusCode: 404 });

    const session = this.store.createSession({
      workspaceId: input.workspaceId,
      agent: input.agent,
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      accessMode: accessMode ?? null,
      title: input.title ?? null,
      parentId: input.parentId !== undefined && this.store.getSession(input.parentId) !== undefined ? input.parentId : null,
      ...(input.handoffKind === undefined ? {} : { handoffKind: input.handoffKind }),
    });

    const provider = this.options.resolveProvider?.(input.providerId ?? null) ?? null;
    const opening = this.ensureRuntime(session, adapter, workspace.path, '');
    let created: { nativeId: string } | undefined;
    try {
      const activation = (async () => {
        created = await adapter.create(await this.prepareLaunch(session, {
          sessionId: session.id,
          cwd: workspace.path,
          providerId: input.providerId ?? null,
          provider,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
          ...(accessMode === undefined ? {} : { accessMode }),
        }));
        if (typeof created?.nativeId !== 'string') throw new Error('原生会话返回缺少有效身份');
        this.assertOwner(opening);
        this.store.nativeOwners.activate(session.id, opening.identity, created.nativeId || opening.nativeId);
        return opening;
      })();
      this.activations.set(session.id, activation);
      try { await activation; } finally { if (this.activations.get(session.id) === activation) this.activations.delete(session.id); }
    } catch (error) {
      await this.dispose(session.id);
      await this.options.modelRecording?.close(session.id);
      // 建会话失败就回滚，不留 native_id 为空的孤儿记录（SPEC-M8 F1）
      this.store.deleteSession(session.id);
      throw error;
    }

    if (created === undefined) throw new Error('原生会话初始化未完成');
    const createdNativeId = created.nativeId || opening.nativeId;
    const updated =
      createdNativeId === ''
        ? this.requireSession(session.id)
        : this.store.updateSession(session.id, { nativeId: createdNativeId });
    if (createdNativeId !== '') this.options.recorder?.nativeId(session.id, createdNativeId);
    const runtime = this.ensureRuntime(updated as SessionDto, adapter, workspace.path, createdNativeId);
    this.touchIdle(runtime);
    const createPatch: FeedPatch = {
      created: true,
      status: 'idle',
      agent: updated?.agent ?? input.agent,
      workspaceId: updated?.workspaceId ?? input.workspaceId,
      createdAt: updated?.createdAt ?? new Date().toISOString(),
      ...(updated?.title === undefined || updated.title === null ? {} : { title: updated.title }),
      ...(updated?.model === undefined ? {} : { model: updated.model }),
      ...(updated?.reasoningEffort === undefined ? {} : { reasoningEffort: updated.reasoningEffort }),
      ...(updated?.accessMode === undefined ? {} : { accessMode: updated.accessMode }),
      ...(updated?.permissions === undefined ? {} : { permissions: updated.permissions }),
      providerId: updated?.providerId ?? null,
      ...(updated?.parentId === undefined ? {} : { parentId: updated.parentId }),
      ...(updated?.handoffKind === undefined ? {} : { handoffKind: updated.handoffKind }),
    };
    const feedSeq = this.store.appendFeed(session.id, createPatch);
    this.hooks.onFeed(session.id, createPatch, feedSeq);
    return updated as SessionDto;
  }

  private ensureRuntime(session: SessionDto, adapter: AgentAdapter, workspacePath: string, nativeId: string): Runtime {
    const existing = this.runtimes.get(session.id);
    if (existing !== undefined) { this.assertOwner(existing); if (nativeId !== '') existing.nativeId = nativeId; return existing; }
    const identity = this.store.nativeOwners.acquire(this.ownerId, session.id, session.agent as AgentId, nativeId);
    adapter.bindRuntime?.(session.id, identity);
    const journal = this.store.journal;
    const runtime: Runtime = {
      identity,
      sessionId: session.id,
      adapter,
      workspacePath,
      nativeId,
      status: session.status,
      turnId: null,
      turnStartedAt: null,
      hot: new Map(),
      idleTimer: null,
      finishTimer: null,
      finishAction: null,
      get queued() { return journal.queue(session.id).filter(row => row.state === 'queued').map(row => ({ turnId: row.turnId, input: row.input, clientCommandId: row.commandId })); },
      disposing: false,
      ownershipTimer: null,
    };
    this.runtimes.set(session.id, runtime);
    runtime.ownershipTimer = setInterval(() => {
      try { if (this.runtimes.get(session.id) === runtime && !this.store.nativeOwners.renew(session.id, identity)) this.fenceRuntime(runtime); }
      catch { this.fenceRuntime(runtime); }
    }, 10_000);
    runtime.ownershipTimer.unref();
    return runtime;
  }

  /** 确保会话运行时就绪（服务重启后按需 resume） */
  private async ensureReady(session: SessionDto, workspacePath: string): Promise<Runtime> {
    const existing = this.activations.get(session.id);
    if (existing !== undefined) return existing;
    const pending = this.activate(session, workspacePath);
    this.activations.set(session.id, pending);
    try { const ready = await pending; this.assertOwner(ready); return ready; } finally { if (this.activations.get(session.id) === pending) this.activations.delete(session.id); this.activationStops.delete(session.id); }
  }

  private async activate(session: SessionDto, workspacePath: string): Promise<Runtime> {
    const adapter = this.adapters.get(session.agent);
    if (adapter === undefined) throw Object.assign(new Error(`没有可用的 ${session.agent} adapter`), { statusCode: 400 });
    const accessMode = session.accessMode ?? this.defaultAccessMode(adapter);
    await this.assertAccessMode(adapter, accessMode);
    const existing = this.runtimes.get(session.id);
    if (existing !== undefined) return existing;
    if (session.nativeId === undefined) throw Object.assign(new Error('会话缺少原生 id，无法恢复'), { statusCode: 500 });
    const runtime = this.ensureRuntime(session, adapter, workspacePath, session.nativeId);
    try { await adapter.resume(await this.prepareLaunch(session, {
      sessionId: session.id,
      cwd: workspacePath,
      providerId: session.providerId ?? null,
      provider: this.options.resolveProvider?.(session.providerId ?? null) ?? null,
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.reasoningEffort === undefined ? {} : { reasoningEffort: session.reasoningEffort }),
      ...(accessMode === undefined ? {} : { accessMode }),
      nativeId: session.nativeId,
    })); } catch (error) { await this.dispose(session.id); throw error; }
    this.assertOwner(runtime);
    this.store.nativeOwners.activate(session.id, runtime.identity, session.nativeId);
    if (this.activationStops.delete(session.id)) {
      await runtime.adapter.interrupt(session.id);
      await runtime.adapter.cancelPending?.(session.id);
    }
    const effectiveSession = session.accessMode === undefined && accessMode !== undefined
      ? this.store.updateSessionAndFeed(session.id, { accessMode }, { accessMode }).session ?? session
      : session;
    this.ensureRuntime(effectiveSession, adapter, workspacePath, session.nativeId);
    return runtime;
  }

  // ---------- 发送 / 介入 ----------

  bindFileStore(files: FileStore): void { this.files = files; }

  /** May run before command acceptance and is repeated before native send.
   * Only current server CAS/catalog identities determine native paths. */
  async prepareInput(sessionId: string, input: { text: string; images?: { fileId: string; mime?: string }[]; contentParts?: InputContent | UserInput['contentParts']; delivery?: UserInput['delivery']; expectedTurnId?: string }, checkIntent = true): Promise<UserInput> {
    const session = this.requireSession(sessionId); const adapter = this.adapters.get(session.agent);
    if (typeof input.text !== 'string' || input.delivery !== undefined && !['send', 'queue', 'steer'].includes(input.delivery)) throw Object.assign(new Error('输入格式无效'), { statusCode: 400 });
    const current = this.runtimes.get(sessionId);
    if (checkIntent && input.delivery === 'send' && (current?.turnId != null || this.store.journal.queue(sessionId).length > 0)) throw Object.assign(new Error('会话正在执行或队列仍有已接受输入，请明确选择排队或介入'), { statusCode: 409 });
    if (checkIntent && input.delivery === 'steer' && (current?.turnId == null || input.expectedTurnId !== current.turnId || current.adapter.steer === undefined)) throw Object.assign(new Error('介入目标轮次已变化或此 Agent 不支持介入，请刷新后重试'), { statusCode: 409 });
    const reference = input.contentParts === undefined ? undefined : publicInputContent(input.contentParts as NonNullable<UserInput['contentParts']>);
    if (reference !== undefined && (!isInputContent(reference, input.text) || input.images?.length)) throw Object.assign(new Error('结构化输入与正文不一致或混合了旧图片字段'), { statusCode: 400 });
    if (input.text.trim() === '' && !(reference?.parts.some(part => part.type !== 'text') || input.images?.length)) throw Object.assign(new Error('普通消息正文不能为空'), { statusCode: 400 });
    const output: UserInput = { text: input.text, ...(input.delivery === undefined ? {} : { delivery: input.delivery }), ...(input.expectedTurnId === undefined ? {} : { expectedTurnId: input.expectedTurnId }) };
    if (reference !== undefined) {
      const parts: ResolvedInputPart[] = [];
      for (const part of reference.parts) {
        if (part.type === 'image' || part.type === 'file' || part.type === 'audio') {
          if (this.files === undefined) throw Object.assign(new Error('附件存储尚未绑定'), { statusCode: 503 });
          parts.push(await this.files.resolveAttachment(part, sessionId));
        } else if (part.type === 'skill') {
          if (adapter?.resolveInputSkill === undefined) throw Object.assign(new Error('此 Agent 未提供可验证的 skill 目录'), { statusCode: 400 });
          await this.ensureReady(session, this.requireWorkspace(session.workspaceId).path);
          const resolved = await adapter.resolveInputSkill(sessionId, part); parts.push({ ...part, path: resolved.path });
        } else if (part.type === 'text' || part.type === 'resource') parts.push(structuredClone(part));
        else throw Object.assign(new Error('结构化输入类型无效'), { statusCode: 400 });
      }
      output.contentParts = { version: 1, parts };
    } else if (input.images?.length) {
      if (input.images.length > 32 || this.files === undefined) throw Object.assign(new Error('图片附件过多或附件存储尚未绑定'), { statusCode: 400 });
      output.images = [];
      for (const image of input.images) output.images.push(await this.files.resolveAttachment({ type: 'image', fileId: image.fileId, ...(image.mime === undefined ? {} : { mime: image.mime }) }, sessionId));
    }
    if (adapter?.validateInput !== undefined) { await this.ensureReady(session, this.requireWorkspace(session.workspaceId).path); await adapter.validateInput(sessionId, output); }
    if (checkIntent && input.delivery === 'send' && this.runtimes.get(sessionId)?.turnId != null) throw Object.assign(new Error('会话已开始执行，输入未发送，请明确选择排队'), { statusCode: 409 });
    return output;
  }

  async send(sessionId: string, input: UserInput, clientCommandId?: string, automatic?: () => boolean): Promise<SendResult> {
    return this.control(sessionId, () => this.sendAccepted(sessionId, input, clientCommandId, automatic));
  }

  private async sendAccepted(sessionId: string, input: UserInput, clientCommandId?: string, automatic?: () => boolean): Promise<SendResult> {
    const session = this.requireSession(sessionId);
    input = await this.prepareInput(sessionId, input);
    if (this.uncertainSessions.has(sessionId) || this.store.journal.queue(sessionId).some(row => row.state === 'uncertain')) throw Object.assign(new Error('上次原生执行结果待核对，禁止自动重发'), { statusCode: 409 });
    if (automatic === undefined) {
      this.watchdog.userInput(sessionId);
    }
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    if (this.requireSession(sessionId).permissions?.phase === 'failed') throw Object.assign(new Error('权限切换失败，请先重新选择权限再发送'), { statusCode: 409 });
    if (automatic !== undefined && !automatic()) throw new Error('Watchdog 已取消');
    if (automatic !== undefined && runtime.turnId !== null) throw Object.assign(new Error('会话已有正在运行的轮次'), { statusCode: 409 });
    if (input.delivery === 'send' && runtime.turnId !== null) throw Object.assign(new Error('会话已开始执行，输入未发送，请明确选择排队'), { statusCode: 409 });

    if (input.delivery === 'steer') return this.steerAccepted(runtime, input, clientCommandId);

    const turnId = ulid();
    const accepted = this.store.journal.enqueue(clientCommandId ?? `internal-${turnId}`, sessionId, turnId, input);
    this.queueChanged(sessionId);
    if (accepted.state !== 'queued') return { turnId: accepted.turnId, queued: accepted.state !== 'completed' };
    const next = runtime.turnId === null ? this.store.journal.next(sessionId) : undefined;
    if (next !== undefined) await this.startTurn(runtime, next.turnId, next.input, next.commandId);
    return { turnId: accepted.turnId, queued: next?.commandId !== accepted.commandId };
  }

  private async startTurn(runtime: Runtime, turnId: string, input: UserInput, clientCommandId?: string): Promise<void> {
    this.assertOwner(runtime);
    const sessionId = runtime.sessionId;
    const session = this.store.getSession(sessionId);
    if (session === undefined) throw new Error('会话不存在');
    if (session.permissions?.phase === 'failed') throw Object.assign(new Error('权限切换失败，已接受的队列保留但暂停执行'), { statusCode: 409 });
    if (runtime.disposing) throw new Error('会话正在回收');
    try { input = await this.prepareInput(sessionId, input, false); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.journal.preparationError(turnId, message); this.queueChanged(sessionId);
      const notice = this.store.appendEvent({ sessionId, turnId: null, itemKey: `queue-preparation-${turnId}`, kind: 'notice', data: { level: 'warning', text: `队列输入未发送：${message}。请核对附件后重试此输入。`, nativeType: 'input-preparation-failed' } });
      this.hooks.onEvent(notice); throw error;
    }
    this.assertOwner(runtime);
    if (runtime.turnId !== null) throw Object.assign(new Error('原生轮次已开始，已接受的输入继续排队'), { statusCode: 409 });
    if (!this.store.journal.beginInput(turnId)) throw Object.assign(new Error('队列输入已被取消或占有'), { statusCode: 409 });
    this.queueChanged(sessionId);
    runtime.turnId = turnId;
    runtime.turnStartedAt = Date.now();
    if (this.options.recorder !== undefined) await this.options.recorder.turnContext(sessionId, turnId);
    this.options.recorder?.record(sessionId, 'web', 'input', { input, clientCommandId }, 'out');

    const userEvent = this.store.appendEvent({
      sessionId,
      turnId,
      itemKey: `user-${turnId}`,
      kind: 'user.message',
      data: {
        text: input.text,
        intent: input.delivery ?? 'send',
        ...(clientCommandId === undefined ? {} : { clientCommandId }),
        ...(input.images === undefined ? {} : { images: input.images.map((image) => image.fileId) }),
        ...(input.contentParts === undefined ? {} : { contentParts: publicInputContent(input.contentParts) }),
      },
    });
    this.hooks.onEvent(userEvent);
    // 服务端分配轮次（F4）：一轮以 turn.started 开始、以 turn.completed 结束
    const startEvent = this.store.appendEvent({
      sessionId,
      turnId,
      itemKey: `turn-start-${turnId}`,
      kind: 'turn.started',
      data: {},
    });
    this.hooks.onEvent(startEvent);
    this.turns.start(sessionId, turnId, runtime.turnStartedAt);

    if (session.title === undefined || session.title === null || session.title === '') {
      const title = firstLine(input.text);
      // The first user prompt is the stable session label. Native title
      // notifications may arrive later (and in some harnesses are generated
      // from an auxiliary request), so they must not replace this label.
      this.store.setTitleSource(sessionId, 'user');
      const updated = this.updateSessionAndFeed(sessionId, { title }, { title });
      void updated;
    }

    try {
      await runtime.adapter.send(sessionId, { ...input, nativeRequestId: this.store.journal.nativeRequestId(turnId) });
      this.assertOwner(runtime);
      if (this.store.journal.queue(sessionId).some(row => row.turnId === turnId)) this.store.journal.inputState(turnId, 'native-accepted');
      this.queueChanged(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.runtimes.get(sessionId) === runtime && !runtime.disposing) this.finishTurn(runtime, 'failed', `${knownUnsubmittedInput(error) ? 'native-input-not-submitted' : 'native-outcome-uncertain'}: ${message}`);
      else this.store.journal.inputState(turnId, knownUnsubmittedInput(error) ? 'failed' : 'uncertain');
      throw error;
    }
    if (runtime.turnId === turnId) this.refreshInteractionStatus(runtime);
    this.touchIdle(runtime);
  }

  private async steerAccepted(runtime: Runtime, input: UserInput, commandId?: string): Promise<SendResult> {
    const target = runtime.turnId;
    if (target === null || input.expectedTurnId !== target || runtime.adapter.steer === undefined) throw Object.assign(new Error('介入目标轮次已变化或此 Agent 不支持介入，请刷新后重试'), { statusCode: 409 });
    input = await this.prepareInput(runtime.sessionId, input); this.assertOwner(runtime);
    if (runtime.turnId !== target || runtime.disposing) throw Object.assign(new Error('介入目标轮次已结束，输入未发送'), { statusCode: 409 });
    const nativeTarget = this.turns.nativeTurn(target);
    if (nativeTarget === undefined) throw Object.assign(new Error('当前轮次尚无已验证的原生身份，输入未发送'), { statusCode: 409 });
    const admissionId = ulid(); const accepted = this.store.journal.enqueue(commandId ?? `internal-${admissionId}`, runtime.sessionId, admissionId, input);
    if (!this.store.journal.beginInput(accepted.turnId, target)) throw Object.assign(new Error('介入输入已被占有或取消'), { statusCode: 409 });
    const user = this.store.appendEvent({ sessionId: runtime.sessionId, turnId: target, itemKey: `user-${admissionId}`, kind: 'user.message', data: { text: input.text, intent: 'steer', clientCommandId: accepted.commandId, ...(input.images === undefined ? {} : { images: input.images.map(image => image.fileId) }), ...(input.contentParts === undefined ? {} : { contentParts: publicInputContent(input.contentParts) }) } });
    this.hooks.onEvent(user);
    try {
      await runtime.adapter.steer(runtime.sessionId, { ...input, expectedTurnId: nativeTarget, nativeRequestId: this.store.journal.nativeRequestId(accepted.turnId) });
      this.assertOwner(runtime);
      if (this.store.journal.get(accepted.commandId)?.state !== 'completed') this.store.journal.inputState(accepted.turnId, 'native-accepted');
    } catch (error) {
      // A real persisted echo can precede a lost RPC response. Its positive
      // admission proof must not be downgraded into blind-replay uncertainty.
      if (this.store.journal.get(accepted.commandId)?.state === 'completed') { this.queueChanged(runtime.sessionId); return { turnId: target, queued: false, confirmed: true }; }
      this.store.journal.inputState(accepted.turnId, knownUnsubmittedInput(error) ? 'failed' : 'uncertain'); this.queueChanged(runtime.sessionId); throw error;
    }
    this.queueChanged(runtime.sessionId); return { turnId: target, queued: false, confirmed: this.store.journal.get(accepted.commandId)?.state === 'completed' };
  }

  async retryQueuedInput(sessionId: string, commandId: string): Promise<void> {
    return this.control(sessionId, async () => {
      const row = this.store.journal.queue(sessionId).find(row => row.commandId === commandId);
      if (row === undefined || row.state !== 'queued' || row.input.delivery === 'steer') throw Object.assign(new Error('此输入不是可重试的未发送队列输入'), { statusCode: 409 });
      await this.prepareInput(sessionId, row.input, false); this.store.journal.preparationError(row.turnId, null); this.queueChanged(sessionId);
      this.store.journal.state(commandId, 'queued', { ok: true, value: { turnId: row.turnId, queued: true } });
      const session = this.requireSession(sessionId); const workspace = this.requireWorkspace(session.workspaceId); const runtime = await this.ensureReady(session, workspace.path);
      await this.drainQueue(runtime);
    });
  }

  /** A live echo from the already-owned writer can release accepted queue
   * work. Read-only historical imports never activate or drain a runtime. */
  confirmInputEcho(sessionId: string, nativeRequestId: string, text: string, nativeTurnId?: string): boolean {
    let confirmed: boolean;
    try { confirmed = this.store.journal.confirmNativeInput(sessionId, nativeRequestId, text, nativeTurnId); }
    catch (error) {
      const record = this.store.journal.nativeInputRecord(sessionId, nativeRequestId);
      if (record !== undefined && this.store.journal.get(record.commandId)?.state !== 'completed') this.store.journal.inputState(record.admissionTurnId, 'uncertain');
      const notice = this.store.appendEvent({ sessionId, turnId: record?.turnId ?? null, itemKey: `input-echo-mismatch-${ulid()}`, kind: 'notice', data: { level: 'warning', text: error instanceof Error ? error.message : '原生输入回声关联不一致，执行结果待核对', nativeType: 'input-echo-mismatch' } });
      this.hooks.onEvent(notice); this.queueChanged(sessionId); return false;
    }
    if (!confirmed) return false;
    this.queueChanged(sessionId); const runtime = this.runtimes.get(sessionId);
    if (runtime !== undefined && runtime.turnId === null && !runtime.disposing) void this.control(sessionId, () => this.drainQueue(runtime)).catch(() => undefined);
    return true;
  }

  async approve(sessionId: string, decision: ApprovalDecision, commandId = ulid()): Promise<void> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    const pending = this.store.interactions.get(sessionId, 'approve', decision.approvalId);
    if (pending === undefined) throw Object.assign(new Error('审批已结束或不存在'), { statusCode: 409 });
    if (!(JSON.parse(pending.request) as Pick<EventData['approval.request'], 'options'>).options.some(option => option.id === decision.optionId)) throw Object.assign(new Error('审批选项无效'), { statusCode: 400 });
    const claim = this.store.interactions.claim(sessionId, 'approve', decision.approvalId, commandId);
    let confirmed: boolean;
    try { const result = await runtime.adapter.respond(sessionId, decision); this.assertOwner(runtime); confirmed = result?.confirmed !== false; } catch (error) { this.store.interactions.fail(claim, error); this.persistInteractionSubmission(claim, 'uncertain'); throw error; }
    if (!confirmed) { if (this.store.interactions.finish(claim, false, false)) this.persistInteractionSubmission(claim, 'sent'); this.refreshInteractionStatus(runtime); this.touchIdle(runtime); return; }
    if (!this.store.interactions.finish(claim)) { this.refreshInteractionStatus(runtime); this.touchIdle(runtime); return; }
    const resolvedTurn = runtime.turnId;
    const event = this.store.appendEvent({
      sessionId,
      turnId: resolvedTurn,
      itemKey: `approval-${decision.approvalId}`,
      kind: 'approval.resolved',
      data: { approvalId: decision.approvalId, optionId: decision.optionId, by: 'user' },
    });
    this.hooks.onEvent(event);
    this.refreshInteractionStatus(runtime);
    this.touchIdle(runtime);
  }

  protectAnswer(sessionId: string, questionId: string, answer: unknown): void {
    const row = this.store.interactions.get(sessionId, 'answer', questionId);
    if (row === undefined || (JSON.parse(row.request) as { isSecret?: boolean }).isSecret !== true) return;
    const form = this.store.allEvents(sessionId).findLast(event => event.kind === 'question' && (event.data as EventData['question']).questionId === questionId)?.data as EventData['question'] | undefined;
    const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
    const values = form?.elicitation !== undefined ? strings((answer as { content?: unknown } | null)?.content) : normalizeQuestionAnswer(answer).values;
    for (const value of values) {
      this.store.nativeEvents.addSecret(value); this.options.recorder?.addSecret(value);
    }
  }

  async answer(sessionId: string, questionId: string, answer: unknown, commandId = ulid()): Promise<AnswerSubmission> {
    this.protectAnswer(sessionId, questionId, answer);
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    if (runtime.adapter.answer === undefined) throw Object.assign(new Error('该 Agent 不支持回答问题'), { statusCode: 400 });
    const claim = this.store.interactions.claim(sessionId, 'answer', questionId, commandId);
    let result: void | AnswerSubmission;
    try { result = await runtime.adapter.answer(sessionId, questionId, answer); this.assertOwner(runtime); } catch (error) { this.store.interactions.fail(claim, error); this.persistInteractionSubmission(claim, 'uncertain'); throw error; }
    if (result?.submitted === false) { if (this.store.interactions.finish(claim, true)) this.persistInteractionSubmission(claim, 'collected'); return result; }
    if (result?.confirmed === false) { if (this.store.interactions.finish(claim, false, false)) for (const row of this.store.interactions.group(claim)) this.persistInteractionSubmission(row, 'sent'); this.refreshInteractionStatus(runtime); this.touchIdle(runtime); return result; }
    if (!this.store.interactions.finish(claim)) { this.refreshInteractionStatus(runtime); this.touchIdle(runtime); return result ?? { submitted: true, questionIds: [questionId] }; }
    for (const id of result?.questionIds ?? [questionId]) {
      const question = this.store.allEvents(sessionId).find((event) => event.kind === 'question' && (event.data as EventData['question']).questionId === id);
      if (question === undefined) continue;
      const data = question.data as EventData['question'];
      const resolved = this.store.appendEvent({
        sessionId,
        turnId: question.turnId,
        itemKey: `question-resolved-${id}`,
        kind: 'question',
        data: { ...data, status: 'answered' },
      });
      this.hooks.onEvent(resolved);
    }
    this.refreshInteractionStatus(runtime);
    this.touchIdle(runtime);
    return result ?? { submitted: true, questionIds: [questionId] };
  }

  private persistInteractionSubmission(row: InteractionRow, submission: 'sent' | 'uncertain' | 'collected'): void {
    if (this.store.interactions.get(row.session_id, row.kind, row.id)?.state !== submission) return;
    const request = this.store.allEvents(row.session_id).findLast(event => row.kind === 'answer'
      ? event.kind === 'question' && (event.data as EventData['question']).questionId === row.id
      : event.kind === 'approval.request' && (event.data as EventData['approval.request']).approvalId === row.id);
    if (request === undefined) return;
    const event = this.store.appendEvent({ sessionId: row.session_id, turnId: request.turnId, itemKey: request.itemKey, kind: request.kind,
      data: { ...(request.data as EventData['question'] | EventData['approval.request']), submission } });
    this.hooks.onEvent(event);
  }

  private refreshInteractionStatus(runtime: Runtime): void {
    const questions = new Map<string, EventData['question']>();
    const approvals = new Set<string>();
    for (const event of this.store.allEvents(runtime.sessionId)) {
      if (runtime.turnId !== null && event.turnId !== null && event.turnId !== runtime.turnId) continue;
      if (event.kind === 'question') { const question = event.data as EventData['question']; questions.set(question.questionId, question); }
      if (event.kind === 'approval.request') approvals.add((event.data as EventData['approval.request']).approvalId);
      if (event.kind === 'approval.resolved') approvals.delete((event.data as EventData['approval.resolved']).approvalId);
    }
    const waiting = approvals.size > 0 || [...questions.values()].some(question => question.status !== 'answered' && question.status !== 'skipped');
    if (!waiting) this.turns.resume(runtime.sessionId);
    this.setStatus(runtime, waiting ? 'waiting' : runtime.turnId === null ? 'idle' : 'running');
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.watchdog.cancel(sessionId, '用户停止了会话，取消自动恢复');
    if (this.activations.has(sessionId)) { this.activationStops.add(sessionId); return; }
    if (!this.runtimes.has(sessionId)) return;
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    await runtime.adapter.interrupt(sessionId);
    this.assertOwner(runtime);
    // 打断时把本会话挂起的审批标成已取消（只处理自己的会话，AG-*-09）
    const cancelled = await runtime.adapter.cancelPending?.(sessionId);
    if (cancelled?.confirmed === false) { this.touchIdle(runtime); return; }
    for (const approvalId of this.pendingApprovalIds(sessionId)) {
      const event = this.store.appendEvent({
        sessionId,
        turnId: runtime.turnId,
        itemKey: `approval-resolved-${approvalId}`,
        kind: 'approval.resolved',
        data: { approvalId, optionId: 'cancelled', by: 'system' },
      });
      this.hooks.onEvent(event);
    }
    this.touchIdle(runtime);
  }

  /** 还没有 approval.resolved 的审批 id */
  private pendingApprovalIds(sessionId: string): string[] {
    const events = this.store.allEvents(sessionId);
    const resolved = new Set(
      events.filter((event) => event.kind === 'approval.resolved').map((event) => (event.data as { approvalId: string }).approvalId),
    );
    return [...new Set(events
      .filter((event) => event.kind === 'approval.request')
      .map((event) => (event.data as { approvalId: string }).approvalId))]
      .filter((approvalId) => !resolved.has(approvalId));
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    return this.control(sessionId, () => this.applyModel(sessionId, model));
  }

  private async control<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.controls.get(sessionId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(run);
    this.controls.set(sessionId, pending);
    try { return await pending; }
    catch (error) {
      if ((error as { code?: string } | null)?.code === 'native-runtime-unavailable') await this.dispose(sessionId);
      throw error;
    } finally { if (this.controls.get(sessionId) === pending) this.controls.delete(sessionId); }
  }

  private async applyModel(sessionId: string, model: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    if (runtime.adapter.setModel !== undefined) await runtime.adapter.setModel(sessionId, model);
    this.assertOwner(runtime);
    // 推给所有客户端：否则输入框里的模型胶囊要等刷新才变
    this.updateSessionAndFeed(sessionId, { model }, { model });
  }

  async slashCommands(sessionId: string): Promise<{ name: string; description?: string }[]> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    return runtime.adapter.slashCommands?.(sessionId) ?? [];
  }

  async sendSubagent(sessionId: string, childSessionId: string, text: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    if (runtime.adapter.sendSubagent === undefined) throw Object.assign(new Error('该 Agent 不支持继续子 Agent'), { statusCode: 400 });
    await runtime.adapter.sendSubagent(sessionId, childSessionId, text);
    this.assertOwner(runtime);
  }

  async interruptSubagent(sessionId: string, childSessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    if (runtime.adapter.interruptSubagent === undefined) throw Object.assign(new Error('该 Agent 不支持打断子 Agent'), { statusCode: 400 });
    await runtime.adapter.interruptSubagent(sessionId, childSessionId);
    this.assertOwner(runtime);
  }

  async setReasoningEffort(sessionId: string, reasoningEffort: string): Promise<void> {
    return this.control(sessionId, () => this.applyReasoningEffort(sessionId, reasoningEffort));
  }

  private async applyReasoningEffort(sessionId: string, reasoningEffort: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    await runtime.adapter.setReasoningEffort?.(sessionId, reasoningEffort);
    this.assertOwner(runtime);
    this.updateSessionAndFeed(sessionId, { reasoningEffort }, { reasoningEffort });
  }

  /** 切换访问模式（F6）：记一个事件，轨迹里可见；实际生效的模式由 adapter 回报 */
  async setAccessMode(sessionId: string, mode: string): Promise<string> {
    return this.control(sessionId, () => this.applyAccessMode(sessionId, mode));
  }

  private async applyAccessMode(sessionId: string, mode: string): Promise<string> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    await this.assertAccessMode(runtime.adapter, mode);
    this.assertOwner(runtime);
    const previous = this.requireSession(sessionId).permissions ?? initialPermissions(session.accessMode);
    const requested = { ...previous, requested: nativeAccessMode(mode) ?? null, phase: 'pending' as const, error: undefined, revision: previous.revision + 1 };
    this.updateSessionAndFeed(sessionId, { accessMode: mode, permissions: requested }, { accessMode: mode, permissions: requested });
    let applied = mode;
    try {
    if (runtime.adapter.setAccessMode === undefined) throw Object.assign(new Error('该 Agent 不支持权限切换'), { statusCode: 400 });
      const result = await runtime.adapter.setAccessMode(sessionId, mode);
      this.assertOwner(runtime);
      if (result !== undefined && typeof result.accessMode === 'string') applied = result.accessMode;
    } catch (error) {
      if (!this.store.nativeOwners.current(sessionId, runtime.identity)) throw error;
      const current = this.requireSession(sessionId).permissions ?? requested;
      if (current.requested === requested.requested) {
        const failed = { ...current, phase: 'failed' as const, error: error instanceof Error ? error.message : String(error), revision: current.revision + 1 };
        this.updateSessionAndFeed(sessionId, { permissions: failed }, { permissions: failed });
      }
      throw error;
    }
    const event = this.store.appendEvent({
      sessionId,
      turnId: runtime.turnId,
      itemKey: `access-mode-${Date.now().toString(36)}`,
      kind: 'internal',
      data: { nativeType: 'access-mode', accessMode: applied } as unknown as EventData[EventKind],
    });
    this.hooks.onEvent(event);
    if (runtime.turnId === null) await this.drainQueue(runtime);
    return applied;
  }

  private async drainQueue(runtime: Runtime): Promise<void> {
    if (runtime.disposing || this.runtimes.get(runtime.sessionId) !== runtime || runtime.turnId !== null) return;
    const next = this.store.journal.next(runtime.sessionId);
    if (next === undefined || this.requireSession(runtime.sessionId).permissions?.phase === 'failed') return;
    await this.startTurn(runtime, next.turnId, next.input, next.commandId);
  }

  async rename(sessionId: string, title: string): Promise<void> {
    this.store.setTitleSource(sessionId, 'user');
    this.updateSessionAndFeed(sessionId, { title }, { title });
  }

  async archive(sessionId: string, archived: boolean): Promise<void> {
    if (archived) this.watchdog.cancel(sessionId, '会话已归档，取消自动恢复');
    this.updateSessionAndFeed(sessionId, { archived }, { archived });
  }

  async dispose(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime === undefined) return;
    runtime.disposing = true;
    if (runtime.ownershipTimer !== null) clearInterval(runtime.ownershipTimer);
    if (runtime.idleTimer !== null) clearTimeout(runtime.idleTimer);
    if (runtime.finishTimer !== null) clearTimeout(runtime.finishTimer);
    runtime.finishTimer = null;
    const confirmedFinish = runtime.finishAction;
    runtime.finishAction = null;
    confirmedFinish?.();
    this.store.nativeOwners.close(sessionId, runtime.identity);
    if (runtime.turnId !== null) {
      const turnId = runtime.turnId;
      this.store.journal.inputState(turnId, 'uncertain');
      this.uncertainSessions.add(sessionId);
      this.turns.forceClose(sessionId, 'failed');
      runtime.turnId = null;
      runtime.hot.clear();
      const event = this.store.appendEvent({ sessionId, turnId, itemKey: `runtime-unobserved-${turnId}`, kind: 'notice',
        data: { level: 'warning', text: '运行通道已关闭，原生轮次的结果待核对；已接受输入保留。', nativeType: 'runtime-unobserved' } });
      this.hooks.onEvent(event);
    }
    try {
      await runtime.adapter.dispose(sessionId);
      await this.options.modelRecording?.close(sessionId);
      this.store.nativeOwners.release(sessionId, runtime.identity, true);
    } catch (error) {
      this.store.nativeOwners.release(sessionId, runtime.identity, false);
      this.setStatus(runtime, 'error');
      throw error;
    }
    if (this.runtimes.get(sessionId) === runtime) this.runtimes.delete(sessionId);
    // 回收之后状态回到空闲，否则界面上会一直显示"停止"（AG-*-11）
    this.setStatus(runtime, this.uncertainSessions.has(sessionId) || this.store.journal.queue(sessionId).some(row => row.state === 'uncertain') ? 'error' : 'idle');
  }

  async disposeAll(): Promise<void> {
    this.watchdog.stop();
    for (const sessionId of [...this.runtimes.keys()]) await this.dispose(sessionId);
  }

  // ---------- adapter 事件 ----------

  private nativeReasoningEffort(event: AdapterEvent): string | undefined {
    if (event.type !== 'item.complete' || event.native === undefined) return undefined;
    if (typeof event.native !== 'object' || event.native === null) return undefined;
    const native = event.native as Record<string, unknown>;
    // Claude SDK: this is the effort actually applied after model/org caps.
    if (native['type'] === 'system' && native['subtype'] === 'init' && typeof native['effort'] === 'string') return native['effort'];
    // DSH: request/header is emitted for every model request and carries the
    // resolved adapter config, including the effective reasoning level.
    if (native['type'] === 'request/header') {
      const data = native['data'];
      if (typeof data === 'object' && data !== null) {
        const header = (data as Record<string, unknown>)['header'];
        if (typeof header === 'object' && header !== null) {
          const config = (header as Record<string, unknown>)['config'];
          if (typeof config === 'object' && config !== null && typeof (config as Record<string, unknown>)['reasoningEffort'] === 'string') {
            return (config as Record<string, unknown>)['reasoningEffort'] as string;
          }
        }
      }
    }
    // Codex app-server reports the resolved effort on thread/started and on
    // some resumed-thread payloads. Keep the database/page value aligned with
    // the native response instead of only trusting the requested value.
    if (typeof native['reasoningEffort'] === 'string') return native['reasoningEffort'];
    const thread = native['thread'];
    if (typeof thread === 'object' && thread !== null && typeof (thread as Record<string, unknown>)['reasoningEffort'] === 'string') {
      return (thread as Record<string, unknown>)['reasoningEffort'] as string;
    }
    return undefined;
  }

  private handleAdapterEvent(sessionId: string, event: AdapterEvent, source?: AgentAdapter): void {
    this.options.recorder?.record(sessionId, 'mapped', event.type, event, 'in');
    const runtime = this.runtimes.get(sessionId);
    const mismatch = runtime !== undefined && event.runtime !== undefined && (event.runtime.ownerId !== runtime.identity.ownerId || event.runtime.generation !== runtime.identity.generation || event.runtime.hostId !== runtime.identity.hostId);
    let disposition: string;
    let envelope: { id: number; duplicate: boolean };
    try {
      disposition = runtime === undefined ? 'unowned' : source !== undefined && source !== runtime.adapter ? 'source-mismatch'
        : runtime.disposing || !this.store.nativeOwners.current(sessionId, runtime.identity) || mismatch ? 'stale-generation' : 'accepted';
      envelope = this.store.nativeEvents.mapping({ sessionId, agent: source?.id ?? runtime?.adapter.id ?? 'unknown',
        nativeId: runtime?.nativeId, identity: event.runtime ?? runtime?.identity }, event, disposition);
    } catch { if (runtime !== undefined) this.fenceRuntime(runtime); return; }
    if (runtime === undefined || disposition !== 'accepted') return;
    if ('native' in event && event.native !== null && typeof event.native === 'object') {
      const native = event.native as Record<string, unknown>;
      const params = native['params'] !== null && typeof native['params'] === 'object' ? native['params'] as Record<string, unknown> : {};
      const item = params['item'] !== null && typeof params['item'] === 'object' ? params['item'] as Record<string, unknown> : {};
      if (runtime.adapter.id === 'codex' && params['threadId'] === runtime.nativeId
        && (native['method'] === 'thread/compacted' || native['method'] === 'item/completed' && item['type'] === 'contextCompaction')) {
        this.store.nativeActions.confirm(sessionId, runtime.identity, runtime.nativeId, { type: 'compact' });
      }
      if (runtime.adapter.id === 'claude-code' && native['type'] === 'system' && native['subtype'] === 'task_notification'
        && native['status'] === 'stopped' && typeof native['task_id'] === 'string') {
        this.store.nativeActions.confirm(sessionId, runtime.identity, runtime.nativeId, { type: 'stop-task', taskId: native['task_id'], runId: native['run_id'] ?? null });
      }
    }
    if (envelope.duplicate) {
      if (event.type === 'item.complete') {
        const assigned = this.turns.assignment(sessionId, event);
        runtime.hot.delete(hotKey(assigned.turnId, event.itemKey));
      }
      return;
    }
    this.options.recorder?.observeFiles(sessionId, event);
    if (event.type === 'native-id') this.options.recorder?.nativeId(sessionId, event.nativeId);
    if (event.type === 'transport.closed') {
      if (!event.activeWork && (runtime.turnId === null || runtime.finishAction !== null)) { void this.dispose(sessionId).catch(() => undefined); return; }
      const turnId = runtime.turnId;
      if (turnId !== null) this.store.journal.inputState(turnId, 'uncertain');
      this.uncertainSessions.add(sessionId);
      const notice = this.store.appendEvent({ sessionId, turnId, itemKey: `transport-closed-${envelope.id}`, kind: 'notice', nativeEnvelopeId: envelope.id,
        data: { level: 'warning', text: '原生运行通道中断，执行结果待核对，已接受输入保留。', nativeType: event.reason } });
      this.hooks.onEvent(notice);
      this.updateSessionAndFeed(sessionId, { status: 'error' }, { status: 'error' });
      this.fenceRuntime(runtime);
      return;
    }
    if (event.type === 'permissions') {
      const session = this.requireSession(sessionId);
      const permissions = observePermissions(session.permissions ?? initialPermissions(session.accessMode), event.observation);
      this.updateSessionAndFeed(sessionId, { permissions }, { permissions });
      return;
    }
    if (event.type === 'history') {
      const imported = this.store.nativeHistory.import(sessionId, event.nativeId, event.records);
      for (const stored of imported) this.hooks.onEvent(stored);
      const terminal = imported.find(stored => stored.kind === 'turn.completed' && stored.turnId === runtime.turnId);
      if (terminal !== undefined) this.finishTurn(runtime, (terminal.data as EventData['turn.completed']).status, undefined, terminal);
      return;
    }
    if (event.type === 'item.complete' && event.kind === 'user.message') {
      const data = event.data as EventData['user.message'];
      const identity = data.clientCommandId === undefined ? undefined : this.store.journal.nativeInputRecord(sessionId, data.clientCommandId);
      if (identity?.steered && !this.confirmInputEcho(sessionId, data.clientCommandId!, data.text, event.nativeTurnId)) return;
      const commandId = identity?.commandId ?? data.clientCommandId;
      const local = findUserEcho(this.store.allEvents(sessionId), { ...data, clientCommandId: commandId });
      if (local !== undefined) {
        return;
      }
    }
    if (event.type === 'turn.start' && event.nativeTurnId !== undefined) {
      const knownTurn = this.turns.publicTurn(sessionId, event.nativeTurnId) ?? this.store.nativeHistory.turn(sessionId, event.nativeTurnId);
      // A delayed acknowledgement of an old native turn must not take over
      // the active writer or restart its public turn.
      if (knownTurn !== undefined && knownTurn !== runtime.turnId) return;
      const currentNative = runtime.turnId === null ? undefined : this.turns.nativeTurn(runtime.turnId);
      if (currentNative !== undefined && currentNative !== event.nativeTurnId) {
        if (runtime.finishAction !== null) runtime.finishAction(true);
        else {
          // Native may start its next autonomous turn before the previous
          // terminal frame reaches us. Preserve the previous admission and
          // wait for its own identity instead of inventing a completion.
          this.store.journal.inputState(runtime.turnId!, 'uncertain');
          runtime.turnId = null;
          runtime.turnStartedAt = null;
        }
      }
      if (runtime.turnId === null) {
        const publicTurn = this.store.nativeHistory.turn(sessionId, event.nativeTurnId) ?? ulid();
        runtime.turnId = publicTurn;
        runtime.turnStartedAt = Date.now();
        this.turns.start(sessionId, publicTurn);
        if (!this.store.allEvents(sessionId).some(stored => stored.kind === 'turn.started' && stored.turnId === publicTurn)) {
          const started = this.store.appendEvent({ sessionId, turnId: publicTurn, itemKey: `turn-start-${publicTurn}`, kind: 'turn.started', data: {}, native: event.native });
          this.hooks.onEvent(started);
        }
      }
      this.store.nativeHistory.bind(sessionId, event.nativeTurnId, runtime.turnId);
      this.store.nativeOwners.observe(sessionId, runtime.identity, event.nativeTurnId);
    }
    const nativeEffort = this.nativeReasoningEffort(event);
    if (nativeEffort !== undefined && this.store.getSession(sessionId)?.reasoningEffort !== nativeEffort) {
      this.updateSessionAndFeed(sessionId, { reasoningEffort: nativeEffort }, { reasoningEffort: nativeEffort });
    }
    const assignment = this.turns.observe(sessionId, event);
    const turnId = assignment.turnId;
    if ('nativeTurnId' in event && event.nativeTurnId !== undefined && turnId === null && event.scope !== 'session') return;
    // Keep extending the settle window while frames for the pending turn are
    // still arriving. This is a quiet-period debounce, so a long Codex diff
    // stream settles without leaking a partial terminal view.
    if (runtime.finishTimer !== null && turnId === runtime.turnId) this.armFinishTimer(runtime);

    switch (event.type) {
      case 'item.start': {
        const key = hotKey(turnId, event.itemKey);
        if (turnId !== null && this.turns.ended(turnId) || runtime.completedItems?.has(key)) break;
        const item: HotItem = {
          itemKey: event.itemKey,
          kind: event.kind,
          data: event.data as EventData[EventKind],
          turnId,
        };
        runtime.hot.set(key, item);
        this.hooks.onUpdate(sessionId, event.itemKey, { started: true, kind: event.kind, data: item.data }, turnId);
        break;
      }
      case 'item.delta': {
        const item = runtime.hot.get(hotKey(turnId, event.itemKey));
        if (item === undefined) break;
        if (item !== undefined) {
          const data = item.data as { text?: string; outputTail?: string };
          if (event.field === 'text') data.text = (data.text ?? '') + event.append;
          else data.outputTail = (data.outputTail ?? '') + event.append;
        }
        this.hooks.onDelta(sessionId, event.itemKey, event.field, event.append, turnId);
        break;
      }
      case 'item.update': {
        const item = runtime.hot.get(hotKey(turnId, event.itemKey));
        if (item === undefined) break;
        if (item !== undefined) item.data = event.data as EventData[EventKind];
        this.hooks.onUpdate(sessionId, event.itemKey, event.data, item?.turnId ?? turnId);
        break;
      }
      case 'item.cancel': {
        runtime.hot.delete(hotKey(turnId, event.itemKey));
        (runtime.completedItems ??= new Set()).add(hotKey(turnId, event.itemKey));
        break;
      }
      case 'item.complete': {
        runtime.hot.delete(hotKey(turnId, event.itemKey));
        (runtime.completedItems ??= new Set()).add(hotKey(turnId, event.itemKey));
        // 改动卡片的数据来源：把 diff 文本存成文件，前端据此打开 diff 标签（C2）
        let completeData = event.data as EventData[EventKind];
        if (event.kind === 'file.change' || event.kind === 'turn.diff') {
          const data = completeData as EventData['file.change'] | EventData['turn.diff'];
          const changes = data.changes.map((change) => {
            if (change.diff === undefined || this.options.saveDiff === undefined) return change;
            const fileId = this.options.saveDiff(`${change.path}.diff`, change.diff);
            const { diff: _diff, ...rest } = change;
            void _diff;
            return { ...rest, diffFileId: fileId };
          });
          completeData = { ...data, changes } as EventData[EventKind];
        }
        if (event.kind === 'turn.completed' && turnId !== null) {
          const previous = this.store.allEvents(sessionId).filter((candidate) => candidate.turnId === turnId);
          const data = completeData as EventData['turn.completed'];
          completeData = { ...data, answerItemKeys: data.answerItemKeys ?? resolveAnswer(previous).map((item) => item.itemKey) };
        }
        const duplicateStart = event.kind === 'turn.started' && turnId !== null && this.store.allEvents(sessionId).some((candidate) => candidate.turnId === turnId && candidate.kind === 'turn.started');
        const kind = duplicateStart ? 'internal' : event.kind;
        const stored = this.store.appendEvent({
          nativeEnvelopeId: envelope.id,
          sessionId,
          turnId,
          itemKey: event.itemKey,
          kind,
          data: (duplicateStart ? { nativeType: 'turn.started' } : completeData) as EventData[EventKind],
          ...(event.native === undefined ? {} : { native: event.native }),
          ...(event.nativeSeq === undefined ? {} : { nativeSeq: event.nativeSeq }),
          ...(assignment.late ? { late: true } : {}),
        });
        // 原生标题：用户没改过名字时才生效（C1）
        if (kind === 'internal') {
          const internal = completeData as { nativeType?: string; title?: string };
          if ((internal.nativeType === 'thread/name/updated' || internal.nativeType === 'session/title') && typeof internal.title === 'string' && internal.title !== '') {
            if (this.store.titleSource(sessionId) !== 'user') {
              this.store.setTitleSource(sessionId, 'native');
              this.updateSessionAndFeed(sessionId, { title: internal.title }, { title: internal.title });
            }
          }
        }
        this.hooks.onEvent(stored);
        if (event.kind === 'approval.request' || event.kind === 'approval.resolved' || event.kind === 'question') this.refreshInteractionStatus(runtime);
        if (event.kind === 'turn.completed') {
          if (turnId === runtime.turnId) this.finishTurn(runtime, (completeData as EventData['turn.completed']).status, undefined, stored);
          else if (turnId !== null) this.finishPreviousTurn(runtime, turnId, (completeData as EventData['turn.completed']).status, stored);
        }
        break;
      }
      case 'turn.start': {
        if (runtime.turnId !== null) this.turns.bindNative(runtime.turnId, event.nativeTurnId);
        if (runtime.turnId !== null) this.setStatus(runtime, 'running');
        break;
      }
      case 'turn.end': {
        if (turnId !== null && !this.turns.ended(turnId)) {
          if (turnId === runtime.turnId) this.finishTurn(runtime, event.status, undefined, undefined, event.usage, event.native, envelope.id);
          else this.finishPreviousTurn(runtime, turnId, event.status, undefined, event.usage, event.native, envelope.id);
        }
        break;
      }
      case 'status': {
        // A few adapters report native idle before their final item/diff
        // notifications. The public turn remains active during the settle
        // window, so that status must not hide the stop state early.
        if (event.status === 'idle' && runtime.turnId !== null) break;
        if (runtime.turnId !== null || event.status === 'idle') this.setStatus(runtime, event.status);
        break;
      }
      case 'native-id': {
        runtime.nativeId = event.nativeId;
        this.store.nativeOwners.activate(sessionId, runtime.identity, event.nativeId);
        this.store.updateSession(sessionId, { nativeId: event.nativeId });
        break;
      }
    }
  }

  /** Persist exactly one terminal event and close all live items for a turn. */
  private finishTurn(
    runtime: Runtime,
    status: 'completed' | 'interrupted' | 'failed',
    reason?: string,
    existing?: StoredEvent,
    usage?: EventData['usage'],
    native?: unknown,
    nativeEnvelopeId?: number,
  ): void {
    // Codex can emit item/diff/status notifications just after turn/end. Keep
    // the public turn active briefly so those frames bind to this turn and a
    // refresh cannot observe a different summary from the live view.
    if (status === 'completed' && reason === undefined && existing === undefined) {
      runtime.finishAction = followedByNativeTurn => this.finishTurnNow(runtime, status, reason, existing, usage, native, nativeEnvelopeId, followedByNativeTurn);
      this.armFinishTimer(runtime);
      return;
    }
    this.finishTurnNow(runtime, status, reason, existing, usage, native, nativeEnvelopeId);
  }

  private finishTurnNow(
    runtime: Runtime,
    status: 'completed' | 'interrupted' | 'failed',
    reason?: string,
    existing?: StoredEvent,
    usage?: EventData['usage'],
    native?: unknown,
    nativeEnvelopeId?: number,
    followedByNativeTurn = false,
  ): void {
    const turnId = runtime.turnId;
    if (turnId === null) return;
    if (runtime.finishTimer !== null) {
      clearTimeout(runtime.finishTimer);
      runtime.finishTimer = null;
    }
    runtime.finishAction = null;
    const events = this.store.allEvents(runtime.sessionId).filter((event) => event.turnId === turnId);
    const answerItemKeys = resolveAnswer(events).map((item) => item.itemKey);
    if (existing === undefined) {
      const event = this.store.appendEvent({
        sessionId: runtime.sessionId,
        nativeEnvelopeId,
        turnId,
        itemKey: `turn-end-${turnId}`,
        kind: 'turn.completed',
        data: {
          status,
          durationMs: runtime.turnStartedAt === null ? 0 : Math.max(0, Date.now() - runtime.turnStartedAt),
          answerItemKeys,
          ...(usage === undefined ? {} : { usage }),
          ...(reason === undefined ? {} : { reason }),
        },
        ...(native === undefined ? {} : { native }),
      });
      this.hooks.onEvent(event);
    }
    for (const [key, item] of runtime.hot) if (item.turnId === turnId) runtime.hot.delete(key);
    for (const key of runtime.completedItems ?? []) if ((JSON.parse(key) as [string | null, string])[0] === turnId) runtime.completedItems?.delete(key);
    this.options.recorder?.turn(runtime.sessionId, null);
    this.turns.end(runtime.sessionId, turnId, status);
    runtime.turnId = null;
    if (this.store.nativeOwners.current(runtime.sessionId, runtime.identity)) this.store.nativeOwners.observe(runtime.sessionId, runtime.identity, null);
    this.store.journal.inputState(turnId, reason === 'session-disposed' || reason?.startsWith('native-outcome-uncertain:') ? 'uncertain' : status === 'failed' ? 'failed' : 'completed');
    this.queueChanged(runtime.sessionId);
    runtime.turnStartedAt = null;
    if (followedByNativeTurn) return;
    this.setStatus(runtime, 'idle');
    const next = runtime.disposing ? undefined : this.store.journal.next(runtime.sessionId);
    if (next !== undefined) {
      // A queued user message takes precedence over automatic recovery.
      this.watchdog.userInput(runtime.sessionId);
      void this.control(runtime.sessionId, () => this.drainQueue(runtime)).catch((error: unknown) => {
        // startTurn persists the failed turn; keep the manager available for
        // later queued messages even when one queued input fails immediately.
        if (process.env['WDCC_DEBUG_QUEUE'] === '1') console.error('[queue] failed', error);
      });
    } else {
      const terminalNative = (native ?? existing?.native) as { turn?: { error?: unknown }; error?: unknown } | undefined;
      const lastError = events.filter((event) => event.kind === 'error').at(-1)?.data as { message?: string } | undefined;
      this.watchdog.terminal(runtime.sessionId, turnId, status, terminalNative?.turn?.error ?? terminalNative?.error ?? reason ?? lastError?.message);
    }
  }

  /** A terminal frame for an earlier autonomous turn changes only that turn. */
  private finishPreviousTurn(runtime: Runtime, turnId: string, status: 'completed' | 'interrupted' | 'failed', existing?: StoredEvent,
    usage?: EventData['usage'], native?: unknown, nativeEnvelopeId?: number): void {
    if (this.turns.ended(turnId)) return;
    const events = this.store.allEvents(runtime.sessionId).filter(event => event.turnId === turnId);
    if (existing === undefined && !events.some(event => event.kind === 'turn.completed')) {
      const startedAt = this.turns.startedAt(turnId);
      const stored = this.store.appendEvent({ sessionId: runtime.sessionId, turnId, itemKey: `turn-end-${turnId}`, kind: 'turn.completed', nativeEnvelopeId,
        data: { status, durationMs: startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt), answerItemKeys: resolveAnswer(events).map(item => item.itemKey),
          ...(usage === undefined ? {} : { usage }) }, ...(native === undefined ? {} : { native }) });
      this.hooks.onEvent(stored);
    }
    for (const [key, item] of runtime.hot) if (item.turnId === turnId) runtime.hot.delete(key);
    for (const key of runtime.completedItems ?? []) if ((JSON.parse(key) as [string | null, string])[0] === turnId) runtime.completedItems?.delete(key);
    this.turns.end(runtime.sessionId, turnId, status);
    this.store.journal.inputState(turnId, status === 'failed' ? 'failed' : 'completed');
    this.queueChanged(runtime.sessionId);
  }

  private armFinishTimer(runtime: Runtime): void {
    if (runtime.finishAction === null) return;
    if (runtime.finishTimer !== null) clearTimeout(runtime.finishTimer);
    runtime.finishTimer = setTimeout(() => {
      runtime.finishTimer = null;
      const action = runtime.finishAction;
      runtime.finishAction = null;
      action?.();
    }, TURN_SETTLE_MS);
    runtime.finishTimer.unref?.();
  }

  private setStatus(runtime: Runtime, status: SessionDto['status']): void {
    const owner = this.store.nativeOwners.get(runtime.sessionId);
    if (owner?.ownerId !== runtime.identity.ownerId || owner.generation !== runtime.identity.generation) return;
    if (runtime.status === status) return;
    runtime.status = status;
    const result = this.updateSessionAndFeed(runtime.sessionId, { status }, { status });
    this.hooks.onStatus(runtime.sessionId, status);
    if (result.feedSeq > 0) this.hooks.onFeed(runtime.sessionId, { status }, result.feedSeq);
    this.touchIdle(runtime);
  }

  private touchIdle(runtime: Runtime): void {
    if (runtime.idleTimer !== null) clearTimeout(runtime.idleTimer);
    if ((runtime.nativeActivity ?? 0) > 0) { runtime.idleTimer = null; return; }
    if (runtime.disposing || this.runtimes.get(runtime.sessionId) !== runtime) return;
    if (this.options.idleDisposeMin <= 0) return;
    runtime.idleTimer = setTimeout(() => {
      if (runtime.status !== 'idle') return;
      void this.dispose(runtime.sessionId);
    }, this.options.idleDisposeMin * 60_000);
    runtime.idleTimer.unref?.();
  }

  // ---------- helpers ----------
  private assertOwner(runtime: Runtime): void {
    if (runtime.disposing || this.runtimes.get(runtime.sessionId) !== runtime) throw Object.assign(new Error('原生运行实例正在关闭或已替换'), { statusCode: 409, code: 'uncertain' });
    this.store.nativeOwners.assert(runtime.sessionId, runtime.identity);
  }

  private fenceRuntime(runtime: Runtime): void {
    if (runtime.ownershipTimer !== null) clearInterval(runtime.ownershipTimer);
    try { this.store.nativeOwners.release(runtime.sessionId, runtime.identity, false); } catch { /* storage unavailable */ }
    try { this.store.nativeActions.disconnect(runtime.sessionId, runtime.identity); } catch { /* storage unavailable */ }
    runtime.disposing = true;
    runtime.status = 'error';
    void runtime.adapter.dispose(runtime.sessionId).catch(() => undefined);
  }

  queueChanged(sessionId: string): void {
    const patch = { queueRevision: Date.now() };
    const feedSeq = this.store.appendFeed(sessionId, patch);
    this.hooks.onFeed(sessionId, patch, feedSeq);
  }

  updateSessionAndFeed(
    sessionId: string,
    patch: Parameters<Store['updateSession']>[1],
    feedPatch: FeedPatch,
  ): { session: SessionDto | undefined; feedSeq: number } {
    const result = this.store.updateSessionAndFeed(sessionId, patch, feedPatch);
    this.hooks.onFeed(sessionId, feedPatch, result.feedSeq);
    return result;
  }

  requireSession(sessionId: string): SessionDto {
    const session = this.store.getSession(sessionId);
    if (session === undefined) throw Object.assign(new Error('会话不存在'), { statusCode: 404 });
    return session;
  }

  private requireWorkspace(workspaceId: string): { id: string; name: string; path: string; createdAt: string } {
    const workspace = this.store.getWorkspace(workspaceId);
    if (workspace === undefined) throw Object.assign(new Error('工作区不存在'), { statusCode: 404 });
    return workspace;
  }
}

export function firstLine(text: string): string {
  const line = text.split(/\r?\n/)[0] ?? '';
  const trimmed = line.trim();
  if (trimmed.length === 0) return '新会话';
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
}
