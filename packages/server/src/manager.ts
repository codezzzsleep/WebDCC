import type {
  AdapterEvent,
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

export interface HotItem {
  itemKey: string;
  kind: EventKind;
  data: EventData[EventKind];
  turnId: string;
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
}

export interface ManagerHooks {
  onFeed: (sessionId: string, patch: FeedPatch, feedSeq: number) => void;
  onEvent: (event: StoredEvent) => void;
  onDelta: (sessionId: string, itemKey: string, field: 'text' | 'output', append: string) => void;
  onUpdate: (sessionId: string, itemKey: string, data: unknown) => void;
  onStatus: (sessionId: string, status: SessionDto['status']) => void;
}

export class SessionManager {
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly runtimes = new Map<string, Runtime>();
  private hooks: ManagerHooks = {
    onFeed: () => undefined,
    onEvent: () => undefined,
    onDelta: () => undefined,
    onUpdate: () => undefined,
    onStatus: () => undefined,
  };

  constructor(
    private readonly store: Store,
    private readonly options: { idleDisposeMin: number },
  ) {}

  registerAdapter(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
    adapter.onEvent((sessionId, event) => this.handleAdapterEvent(sessionId, event));
  }

  adapter(id: AgentId): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  adaptersList(): AgentAdapter[] {
    return [...this.adapters.values()];
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
    accessMode?: string;
    title?: string;
  }): Promise<SessionDto> {
    const adapter = this.adapters.get(input.agent);
    if (adapter === undefined) throw Object.assign(new Error(`没有可用的 ${input.agent} adapter`), { statusCode: 400 });
    const workspace = this.store.getWorkspace(input.workspaceId);
    if (workspace === undefined) throw Object.assign(new Error('工作区不存在'), { statusCode: 404 });

    const session = this.store.createSession({
      workspaceId: input.workspaceId,
      agent: input.agent,
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      accessMode: input.accessMode ?? null,
      title: input.title ?? null,
    });

    const created = await adapter.create({
      sessionId: session.id,
      cwd: workspace.path,
      providerId: input.providerId ?? null,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.accessMode === undefined ? {} : { accessMode: input.accessMode }),
    });

    const updated = this.store.updateSession(session.id, { nativeId: created.nativeId });
    const runtime = this.ensureRuntime(updated as SessionDto, adapter, workspace.path, created.nativeId);
    this.touchIdle(runtime);
    const createPatch: FeedPatch = {
      created: true,
      status: 'idle',
      agent: updated?.agent ?? input.agent,
      workspaceId: updated?.workspaceId ?? input.workspaceId,
      createdAt: updated?.createdAt ?? new Date().toISOString(),
      ...(updated?.title === undefined || updated.title === null ? {} : { title: updated.title }),
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
    };
    this.runtimes.set(session.id, runtime);
    return runtime;
  }

  /** 确保会话运行时就绪（服务重启后按需 resume） */
  private async ensureReady(session: SessionDto, workspacePath: string): Promise<Runtime> {
    const adapter = this.adapters.get(session.agent);
    if (adapter === undefined) throw Object.assign(new Error(`没有可用的 ${session.agent} adapter`), { statusCode: 400 });
    const existing = this.runtimes.get(session.id);
    if (existing !== undefined) return existing;
    if (session.nativeId === undefined) throw Object.assign(new Error('会话缺少原生 id，无法恢复'), { statusCode: 500 });
    await adapter.resume({
      sessionId: session.id,
      cwd: workspacePath,
      providerId: session.providerId ?? null,
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.accessMode === undefined ? {} : { accessMode: session.accessMode }),
      nativeId: session.nativeId,
    });
    const runtime = this.ensureRuntime(session, adapter, workspacePath, session.nativeId);
    runtime.status = session.status;
    return runtime;
  }

  // ---------- 发送 / 介入 ----------

  async send(sessionId: string, input: UserInput, clientCommandId?: string): Promise<{ turnId: string }> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);

    const turnId = ulid();
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

    if (session.title === undefined || session.title === null || session.title === '') {
      const title = firstLine(input.text);
      const updated = this.updateSessionAndFeed(sessionId, { title }, { title });
      void updated;
    }

    await runtime.adapter.send(sessionId, input);
    this.setStatus(runtime, 'running');
    this.touchIdle(runtime);
    return { turnId };
  }

  async approve(sessionId: string, decision: ApprovalDecision): Promise<void> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    await runtime.adapter.respond(sessionId, decision);
    const resolvedTurn = runtime.turnId ?? 'unknown';
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
    this.touchIdle(runtime);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    await runtime.adapter.interrupt(sessionId);
    this.touchIdle(runtime);
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);
    const runtime = await this.ensureReady(session, workspace.path);
    if (runtime.adapter.setModel !== undefined) await runtime.adapter.setModel(sessionId, model);
    this.updateSessionAndFeed(sessionId, { model }, {});
  }

  async rename(sessionId: string, title: string): Promise<void> {
    this.updateSessionAndFeed(sessionId, { title }, { title });
  }

  async archive(sessionId: string, archived: boolean): Promise<void> {
    this.updateSessionAndFeed(sessionId, { archived }, { archived });
  }

  async dispose(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime === undefined) return;
    if (runtime.idleTimer !== null) clearTimeout(runtime.idleTimer);
    await runtime.adapter.dispose(sessionId);
    this.runtimes.delete(sessionId);
  }

  async disposeAll(): Promise<void> {
    for (const sessionId of [...this.runtimes.keys()]) await this.dispose(sessionId);
  }

  // ---------- adapter 事件 ----------

  private handleAdapterEvent(sessionId: string, event: AdapterEvent): void {
    const runtime = this.runtimes.get(sessionId);
    if (runtime === undefined) return;
    // 一轮的 turnId 由 manager 在 send() 时分配；adapter 的原生 turn id 只作为参考，
    // 否则 adapter 自造的 turnId 会让 user.message 和后续事件分到两个轮次里
    const nativeTurnId = 'turnId' in event ? event.turnId : undefined;
    const turnId = runtime.turnId ?? nativeTurnId ?? ulid();

    switch (event.type) {
      case 'item.start': {
        const item: HotItem = {
          itemKey: event.itemKey,
          kind: event.kind,
          data: event.data as EventData[EventKind],
          turnId: event.turnId ?? turnId,
        };
        runtime.hot.set(event.itemKey, item);
        this.hooks.onUpdate(sessionId, event.itemKey, { started: true, kind: event.kind, data: item.data });
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
        this.hooks.onUpdate(sessionId, event.itemKey, event.data);
        break;
      }
      case 'item.complete': {
        runtime.hot.delete(event.itemKey);
        const stored = this.store.appendEvent({
          sessionId,
          turnId: event.turnId ?? turnId,
          itemKey: event.itemKey,
          kind: event.kind,
          data: event.data as EventData[EventKind],
          ...(event.native === undefined ? {} : { native: event.native }),
          ...(event.nativeSeq === undefined ? {} : { nativeSeq: event.nativeSeq }),
        });
        this.hooks.onEvent(stored);
        if (event.kind === 'turn.completed') {
          runtime.turnId = null;
          runtime.turnStartedAt = null;
          this.setStatus(runtime, 'idle');
        }
        break;
      }
      case 'status': {
        this.setStatus(runtime, event.status);
        break;
      }
    }
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
