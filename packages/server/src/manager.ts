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
} from '@webdcc/protocol';
import { ulid } from '@webdcc/protocol';
import type { Store } from './store.js';
import { resolveAnswer } from '@webdcc/protocol';
import { TurnTracker } from './turn-tracker.js';
import { CodexWatchdog } from './watchdog.js';

const TURN_SETTLE_MS = 1_500;

export interface HotItem {
  itemKey: string;
  kind: EventKind;
  data: EventData[EventKind];
  turnId: string | null;
}

export interface Runtime {
  sessionId: string;
  adapter: AgentAdapter;
  workspacePath: string;
  nativeId: string;
  status: Exclude<SessionDto['status'], never>;
  turnId: string | null;
  turnStartedAt: number | null;
  hot: Map<string, HotItem>;
  idleTimer: NodeJS.Timeout | null;
  /** Codex 等 adapter 可能在 turn/end 后补发 item/diff；在终止前给它们一个收敛窗口。 */
  finishTimer: NodeJS.Timeout | null;
  finishAction: (() => void) | null;
  queued: { turnId: string; input: UserInput; clientCommandId?: string }[];
}

export interface ManagerHooks {
  onFeed: (sessionId: string, patch: FeedPatch, feedSeq: number) => void;
  onEvent: (event: StoredEvent) => void;
  onDelta: (sessionId: string, itemKey: string, field: 'text' | 'output', append: string) => void;
  onUpdate: (sessionId: string, itemKey: string, data: unknown, turnId?: string | null) => void;
  onStatus: (sessionId: string, status: SessionDto['status']) => void;
}

export class SessionManager {
  readonly watchdog: CodexWatchdog;
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly runtimes = new Map<string, Runtime>();
  private readonly turns = new TurnTracker();
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
    },
  ) {
    // A previous process may have stopped after writing turn.started. Close
    // those turns before adapters are resumed so refresh never shows a
    // permanently running turn.
    for (const session of this.store.listSessions(true)) {
      const events = this.store.allEvents(session.id);
      const started = events.filter((event) => event.kind === 'turn.started');
      for (const begin of started) {
        if (events.some((event) => event.turnId === begin.turnId && event.kind === 'turn.completed')) continue;
        this.store.appendEvent({
          sessionId: session.id,
          turnId: begin.turnId,
          itemKey: `turn-recovered-${begin.turnId}`,
          kind: 'turn.completed',
          data: { status: 'interrupted', durationMs: 0, answerItemKeys: [], reason: 'server-restart' },
        });
        this.store.updateSession(session.id, { status: 'idle' });
      }
    }
    this.watchdog = new CodexWatchdog(store, {
      isActive: (id) => {
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
    adapter.onEvent((sessionId, event) => this.handleAdapterEvent(sessionId, event));
    if (adapter.id === 'codex') this.watchdog.start();
  }

  adapter(id: AgentId): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  adaptersList(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  /** 权限档位是安全边界，不能只依赖前端菜单的可见项。 */
  private defaultAccessMode(adapter: AgentAdapter): string | undefined {
    return adapter.accessModes()[0]?.id;
  }

  private assertAccessMode(adapter: AgentAdapter, mode: string | undefined): void {
    if (mode === undefined || mode === '') return;
    const allowed = new Set(adapter.accessModes().map((item) => item.id));
    // Codex 的原生 permissionProfile/list 返回带冒号的 id，而旧版配置
    // 与下一轮参数仍接受无冒号别名。
    if (adapter.id === 'codex') {
      for (const id of ['read-only', 'workspace', 'danger-full-access']) allowed.add(`:${id}`);
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
    this.assertAccessMode(adapter, accessMode);
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
    let created: { nativeId: string };
    try {
      created = await adapter.create({
        sessionId: session.id,
        cwd: workspace.path,
        providerId: input.providerId ?? null,
        provider,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        ...(accessMode === undefined ? {} : { accessMode }),
      });
    } catch (error) {
      // 建会话失败就回滚，不留 native_id 为空的孤儿记录（SPEC-M8 F1）
      this.store.deleteSession(session.id);
      throw error;
    }

    const updated =
      created.nativeId === ''
        ? session
        : this.store.updateSession(session.id, { nativeId: created.nativeId });
    const runtime = this.ensureRuntime(updated as SessionDto, adapter, workspace.path, created.nativeId);
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
    if (existing !== undefined) return existing;
    const runtime: Runtime = {
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
      queued: [],
    };
    this.runtimes.set(session.id, runtime);
    return runtime;
  }

  /** 确保会话运行时就绪（服务重启后按需 resume） */
  private async ensureReady(session: SessionDto, workspacePath: string): Promise<Runtime> {
    const adapter = this.adapters.get(session.agent);
    if (adapter === undefined) throw Object.assign(new Error(`没有可用的 ${session.agent} adapter`), { statusCode: 400 });
    const accessMode = session.accessMode ?? this.defaultAccessMode(adapter);
    this.assertAccessMode(adapter, accessMode);
    const existing = this.runtimes.get(session.id);
    if (existing !== undefined) return existing;
    if (session.nativeId === undefined) throw Object.assign(new Error('会话缺少原生 id，无法恢复'), { statusCode: 500 });
    await adapter.resume({
      sessionId: session.id,
      cwd: workspacePath,
      providerId: session.providerId ?? null,
      provider: this.options.resolveProvider?.(session.providerId ?? null) ?? null,
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.reasoningEffort === undefined ? {} : { reasoningEffort: session.reasoningEffort }),
      ...(accessMode === undefined ? {} : { accessMode }),
      nativeId: session.nativeId,
    });
    const effectiveSession = session.accessMode === undefined && accessMode !== undefined
      ? this.store.updateSessionAndFeed(session.id, { accessMode }, { accessMode }).session ?? session
      : session;
    const runtime = this.ensureRuntime(effectiveSession, adapter, workspacePath, session.nativeId);
    runtime.status = session.status;
    return runtime;
  }

  // ---------- 发送 / 介入 ----------

  async send(sessionId: string, input: UserInput, clientCommandId?: string, automatic?: () => boolean): Promise<{ turnId: string; queued: boolean }> {
    const session = this.requireSession(sessionId);
    if (automatic === undefined) {
      this.watchdog.userInput(sessionId);
    }
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    if (automatic !== undefined && !automatic()) throw new Error('Watchdog 已取消');
    if (automatic !== undefined && runtime.turnId !== null) throw Object.assign(new Error('会话已有正在运行的轮次'), { statusCode: 409 });

    const turnId = ulid();
    if (runtime.turnId !== null) {
      runtime.queued.push({ turnId, input, ...(clientCommandId === undefined ? {} : { clientCommandId }) });
      return { turnId, queued: true };
    }
    await this.startTurn(runtime, turnId, input, clientCommandId);
    return { turnId, queued: false };
  }

  private async startTurn(runtime: Runtime, turnId: string, input: UserInput, clientCommandId?: string): Promise<void> {
    const sessionId = runtime.sessionId;
    const session = this.store.getSession(sessionId);
    if (session === undefined) throw new Error('会话不存在');
    runtime.turnId = turnId;
    runtime.turnStartedAt = Date.now();

    const userEvent = this.store.appendEvent({
      sessionId,
      turnId,
      itemKey: `user-${turnId}`,
      kind: 'user.message',
      data: {
        text: input.text,
        ...(clientCommandId === undefined ? {} : { clientCommandId }),
        ...(input.images === undefined ? {} : { images: input.images.map((image) => image.fileId) }),
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
      await runtime.adapter.send(sessionId, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finishTurn(runtime, 'failed', message);
      throw error;
    }
    if (runtime.turnId === turnId) this.setStatus(runtime, 'running');
    this.touchIdle(runtime);
  }

  async approve(sessionId: string, decision: ApprovalDecision): Promise<void> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    await runtime.adapter.respond(sessionId, decision);
    this.turns.resume(sessionId);
    if (runtime.turnId !== null) this.setStatus(runtime, 'running');
    // 轮次已经结束之后才到的审批：处理完不要停在"待批准"
    if (runtime.turnId === null) this.setStatus(runtime, 'idle');
    const resolvedTurn = runtime.turnId;
    const event = this.store.appendEvent({
      sessionId,
      turnId: resolvedTurn,
      itemKey: `approval-${decision.approvalId}`,
      kind: 'approval.resolved',
      data: { approvalId: decision.approvalId, optionId: decision.optionId, by: 'user' },
    });
    this.hooks.onEvent(event);
    this.touchIdle(runtime);
  }

  async answer(sessionId: string, questionId: string, answer: unknown): Promise<void> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    if (runtime.adapter.answer === undefined) throw Object.assign(new Error('该 Agent 不支持回答问题'), { statusCode: 400 });
    await runtime.adapter.answer(sessionId, questionId, answer);
    this.turns.resume(sessionId);
    const question = this.store.allEvents(sessionId).find((event) => event.kind === 'question' && (event.data as EventData['question']).questionId === questionId);
    if (question !== undefined) {
      const data = question.data as EventData['question'];
      const resolved = this.store.appendEvent({
        sessionId,
        turnId: runtime.turnId,
        itemKey: `question-resolved-${questionId}`,
        kind: 'question',
        data: { ...data, status: 'answered' },
      });
      this.hooks.onEvent(resolved);
    }
    if (runtime.turnId !== null) this.setStatus(runtime, 'running');
    this.touchIdle(runtime);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.watchdog.cancel(sessionId, '用户停止了会话，取消自动恢复');
    if (!this.runtimes.has(sessionId)) return;
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    await runtime.adapter.interrupt(sessionId);
    // 打断时把本会话挂起的审批标成已取消（只处理自己的会话，AG-*-09）
    await runtime.adapter.cancelPending?.(sessionId);
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
    return events
      .filter((event) => event.kind === 'approval.request')
      .map((event) => (event.data as { approvalId: string }).approvalId)
      .filter((approvalId) => !resolved.has(approvalId));
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    if (runtime.adapter.setModel !== undefined) await runtime.adapter.setModel(sessionId, model);
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
  }

  async interruptSubagent(sessionId: string, childSessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    if (runtime.adapter.interruptSubagent === undefined) throw Object.assign(new Error('该 Agent 不支持打断子 Agent'), { statusCode: 400 });
    await runtime.adapter.interruptSubagent(sessionId, childSessionId);
  }

  async setReasoningEffort(sessionId: string, reasoningEffort: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    await runtime.adapter.setReasoningEffort?.(sessionId, reasoningEffort);
    this.updateSessionAndFeed(sessionId, { reasoningEffort }, { reasoningEffort });
  }

  /** 切换访问模式（F6）：记一个事件，轨迹里可见；实际生效的模式由 adapter 回报 */
  async setAccessMode(sessionId: string, mode: string): Promise<string> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    this.assertAccessMode(runtime.adapter, mode);
    let applied = mode;
    if (runtime.adapter.setAccessMode !== undefined) {
      const result = await runtime.adapter.setAccessMode(sessionId, mode);
      if (result !== undefined && typeof result.accessMode === 'string') applied = result.accessMode;
    }
    this.updateSessionAndFeed(sessionId, { accessMode: applied }, { accessMode: applied });
    const event = this.store.appendEvent({
      sessionId,
      turnId: runtime.turnId,
      itemKey: `access-mode-${Date.now().toString(36)}`,
      kind: 'internal',
      data: { nativeType: 'access-mode', accessMode: applied } as unknown as EventData[EventKind],
    });
    this.hooks.onEvent(event);
    return applied;
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
    if (runtime.idleTimer !== null) clearTimeout(runtime.idleTimer);
    if (runtime.finishTimer !== null) clearTimeout(runtime.finishTimer);
    runtime.finishTimer = null;
    runtime.finishAction = null;
    runtime.queued.length = 0;
    if (runtime.turnId !== null) this.finishTurn(runtime, 'interrupted', 'session-disposed');
    await runtime.adapter.dispose(sessionId);
    this.runtimes.delete(sessionId);
    // 回收之后状态回到空闲，否则界面上会一直显示"停止"（AG-*-11）
    if (runtime.status !== 'idle') this.setStatus(runtime, 'idle');
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

  private handleAdapterEvent(sessionId: string, event: AdapterEvent): void {
    const runtime = this.runtimes.get(sessionId);
    if (runtime === undefined) return;
    const nativeEffort = this.nativeReasoningEffort(event);
    if (nativeEffort !== undefined && this.store.getSession(sessionId)?.reasoningEffort !== nativeEffort) {
      this.updateSessionAndFeed(sessionId, { reasoningEffort: nativeEffort }, { reasoningEffort: nativeEffort });
    }
    const assignment = this.turns.observe(sessionId, event);
    const turnId = assignment.turnId;
    // Keep extending the settle window while frames for the pending turn are
    // still arriving. This is a quiet-period debounce, so a long Codex diff
    // stream settles without leaking a partial terminal view.
    if (runtime.finishTimer !== null && turnId === runtime.turnId) this.armFinishTimer(runtime);

    switch (event.type) {
      case 'item.start': {
        const item: HotItem = {
          itemKey: event.itemKey,
          kind: event.kind,
          data: event.data as EventData[EventKind],
          turnId,
        };
        runtime.hot.set(event.itemKey, item);
        this.hooks.onUpdate(sessionId, event.itemKey, { started: true, kind: event.kind, data: item.data }, turnId);
        break;
      }
      case 'item.delta': {
        const item = runtime.hot.get(event.itemKey);
        if (item !== undefined) {
          const data = item.data as { text?: string; outputTail?: string };
          if (event.field === 'text') data.text = (data.text ?? '') + event.append;
          else data.outputTail = (data.outputTail ?? '') + event.append;
        }
        this.hooks.onDelta(sessionId, event.itemKey, event.field, event.append);
        break;
      }
      case 'item.update': {
        const item = runtime.hot.get(event.itemKey);
        if (item !== undefined) item.data = event.data as EventData[EventKind];
        this.hooks.onUpdate(sessionId, event.itemKey, event.data, item?.turnId ?? turnId);
        break;
      }
      case 'item.cancel': {
        runtime.hot.delete(event.itemKey);
        break;
      }
      case 'item.complete': {
        runtime.hot.delete(event.itemKey);
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
          sessionId,
          turnId,
          itemKey: event.itemKey,
          kind,
          data: (kind === 'internal' ? { nativeType: 'turn.started' } : completeData) as EventData[EventKind],
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
        if (event.kind === 'approval.request' || event.kind === 'question') this.setStatus(runtime, 'waiting');
        if (event.kind === 'turn.completed') {
          this.finishTurn(runtime, (completeData as EventData['turn.completed']).status, undefined, stored);
        }
        break;
      }
      case 'turn.start': {
        if (runtime.turnId !== null) this.turns.bindNative(runtime.turnId, event.nativeTurnId);
        if (runtime.turnId !== null) this.setStatus(runtime, 'running');
        break;
      }
      case 'turn.end': {
        if (turnId !== null) this.finishTurn(runtime, event.status, undefined, undefined, event.usage, event.native);
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
  ): void {
    // Codex can emit item/diff/status notifications just after turn/end. Keep
    // the public turn active briefly so those frames bind to this turn and a
    // refresh cannot observe a different summary from the live view.
    if (status === 'completed' && reason === undefined && existing === undefined) {
      runtime.finishAction = () => this.finishTurnNow(runtime, status, reason, existing, usage, native);
      this.armFinishTimer(runtime);
      return;
    }
    this.finishTurnNow(runtime, status, reason, existing, usage, native);
  }

  private finishTurnNow(
    runtime: Runtime,
    status: 'completed' | 'interrupted' | 'failed',
    reason?: string,
    existing?: StoredEvent,
    usage?: EventData['usage'],
    native?: unknown,
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
    runtime.hot.clear();
    this.turns.end(runtime.sessionId, turnId, status);
    runtime.turnId = null;
    runtime.turnStartedAt = null;
    this.setStatus(runtime, 'idle');
    const next = runtime.queued.shift();
    if (next !== undefined) {
      // A queued user message takes precedence over automatic recovery.
      this.watchdog.userInput(runtime.sessionId);
      void this.startTurn(runtime, next.turnId, next.input, next.clientCommandId).catch((error: unknown) => {
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
    if (runtime.status === status) return;
    runtime.status = status;
    const result = this.updateSessionAndFeed(runtime.sessionId, { status }, { status });
    this.hooks.onStatus(runtime.sessionId, status);
    if (result.feedSeq > 0) this.hooks.onFeed(runtime.sessionId, { status }, result.feedSeq);
    this.touchIdle(runtime);
  }

  private touchIdle(runtime: Runtime): void {
    if (runtime.idleTimer !== null) clearTimeout(runtime.idleTimer);
    if (this.options.idleDisposeMin <= 0) return;
    runtime.idleTimer = setTimeout(() => {
      if (runtime.status !== 'idle') return;
      void this.dispose(runtime.sessionId);
    }, this.options.idleDisposeMin * 60_000);
    runtime.idleTimer.unref?.();
  }

  // ---------- helpers ----------

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
