/** 全局状态：会话、事件、进行中条目、草稿、发件箱（SPEC 7.4、7.5） */
import type { Command, EventKind, ServerMessage, StoredEvent } from '@webdcc/protocol';
import { ulid } from '@webdcc/protocol';
import { api } from './api.js';
import { cache, type CachedSession } from './db.js';
import { SyncConnection, type ConnectionState } from './connection.js';

export interface SessionMeta {
  id: string;
  workspaceId: string;
  agent: string;
  title?: string;
  status: 'idle' | 'running' | 'waiting' | 'error';
  updatedAt: string;
  pinned?: boolean;
  archived?: boolean;
  providerId?: string | null;
  model?: string;
  accessMode?: string;
  createdAt?: string;
  lastSeq?: number;
}

export interface HotItem {
  itemKey: string;
  kind: EventKind;
  data: unknown;
  turnId?: string;
}

export interface PendingMessage {
  clientCommandId: string;
  text: string;
  at: string;
  status: 'pending' | 'sent' | 'failed';
}

export interface TurnModel {
  turnId: string;
  events: StoredEvent[];
  user?: StoredEvent;
  completed?: StoredEvent;
  hot: HotItem[];
  pending?: PendingMessage;
  startedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class AppStore {
  private sessions = new Map<string, SessionMeta>();
  private events = new Map<string, Map<number, StoredEvent>>();
  private hot = new Map<string, Map<string, HotItem>>();
  private pending = new Map<string, PendingMessage[]>();
  private drafts = new Map<string, { text: string; fileIds: string[] }>();
  private outbox = new Map<string, { command: Command; status: PendingMessage['status'] }>();
  private listeners = new Set<() => void>();
  private derived = new Map<string, { version: number; turns: TurnModel[] }>();
  /** 每个会话的订阅游标：新浏览器打开大会话时从服务端最新 seq 开始，不整段重拉 */
  private cursors = new Map<string, number>();
  private version = 0;
  private draftTimers = new Map<string, NodeJS.Timeout>();

  readonly connection: SyncConnection;
  /** 非当前查看的会话完成/等待审批时的未读数（A13） */
  unread = new Map<string, number>();
  currentSessionId: string | null = null;
  feedSeq = 0;
  connectionState: ConnectionState = 'connecting';
  connectionAttempt = 0;
  lastReconnectAt = 0;

  constructor() {
    this.connection = new SyncConnection({
      getSubscriptions: () => this.subscriptions(),
      getFeedAfter: () => this.feedSeq,
      onMessage: (message) => this.handleMessage(message),
      onState: (state, attempt) => {
        this.connectionState = state;
        this.connectionAttempt = attempt;
        if (state === 'online') this.lastReconnectAt = Date.now();
        this.notify();
      },
      onOpen: () => this.replayOutbox(),
    });
  }

  async init(): Promise<void> {
    performance.mark('wdcc:init-start');
    const cached = await cache.getSessions().catch(() => [] as CachedSession[]);
    for (const session of cached) this.sessions.set(session.id, session as SessionMeta);
    this.feedSeq = (await cache.getMeta<number>('feedSeq').catch(() => 0)) ?? 0;
    this.notify();
    this.connection.start();
    performance.mark('wdcc:init-end');
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getVersion(): number {
    return this.version;
  }

  private notifyScheduled = false;

  /** 同一 tick 内合并重渲染（5000 条事件时这是关键） */
  private cacheQueue: StoredEvent[] = [];
  private cacheFlushTimer: NodeJS.Timeout | null = null;

  private queueCache(event: StoredEvent): void {
    this.cacheQueue.push(event);
    if (this.cacheFlushTimer !== null) return;
    this.cacheFlushTimer = setTimeout(() => {
      const batch = this.cacheQueue.splice(0, this.cacheQueue.length);
      this.cacheFlushTimer = null;
      if (batch.length === 0) return;
      void cache.putEvents(batch);
      const last = batch[batch.length - 1];
      if (last !== undefined) void cache.setMeta(`maxSeq:${last.sessionId}`, last.seq);
    }, 100);
  }

  private notify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      this.version += 1;
      for (const listener of this.listeners) listener();
    });
  }

  private subscriptions(): { sessionId: string; afterSeq: number }[] {
    return [...this.sessions.keys()].map((sessionId) => ({
      sessionId,
      afterSeq: Math.max(this.maxSeq(sessionId), this.cursors.get(sessionId) ?? 0),
    }));
  }

  maxSeq(sessionId: string): number {
    const map = this.events.get(sessionId);
    if (map === undefined || map.size === 0) return 0;
    let max = 0;
    for (const seq of map.keys()) if (seq > max) max = seq;
    return max;
  }

  // ---------- 服务端消息 ----------

  private handleMessage(message: ServerMessage): void {
    switch (message.op) {
      case 'feed': {
        this.feedSeq = Math.max(this.feedSeq, message.feedSeq);
        void cache.setMeta('feedSeq', this.feedSeq);
        const existing = this.sessions.get(message.sessionId);
        const patch = message.patch as Record<string, unknown>;
        const next: SessionMeta = {
          ...(existing ?? {
            id: message.sessionId,
            workspaceId: String(patch['workspaceId'] ?? ''),
            agent: String(patch['agent'] ?? 'dsh'),
            status: 'idle',
            updatedAt: nowIso(),
          }),
          // F5：新会话的 agent 必须来自 patch，不能写死成 dsh
          ...(patch['agent'] === undefined ? {} : { agent: String(patch['agent']) }),
          ...(patch['workspaceId'] === undefined ? {} : { workspaceId: String(patch['workspaceId']) }),
          ...(patch['createdAt'] === undefined ? {} : { createdAt: String(patch['createdAt']) }),
          ...(patch['title'] === undefined ? {} : { title: String(patch['title']) }),
          ...(patch['status'] === undefined ? {} : { status: patch['status'] as SessionMeta['status'] }),
          ...(patch['archived'] === undefined ? {} : { archived: Boolean(patch['archived']) }),
          ...(patch['pinned'] === undefined ? {} : { pinned: Boolean(patch['pinned']) }),
          updatedAt: nowIso(),
        };
        this.sessions.set(message.sessionId, next);
        void cache.putSession(next as CachedSession);
        if (patch['created'] === true) this.connection.subscribe(message.sessionId, 0);
        this.notify();
        break;
      }
      case 'event': {
        this.applyEvent(message.event);
        break;
      }
      case 'snapshot': {
        const map = this.hot.get(message.sessionId) ?? new Map<string, HotItem>();
        for (const item of message.items) {
          map.set(item.itemKey, { itemKey: item.itemKey, kind: item.kind, data: item.data, ...(item.turnId === undefined ? {} : { turnId: item.turnId }) });
        }
        this.hot.set(message.sessionId, map);
        this.notify();
        break;
      }
      case 'delta': {
        const map = this.hot.get(message.sessionId) ?? new Map<string, HotItem>();
        let item = map.get(message.itemKey);
        if (item === undefined) {
          // 兜底：没收到 update 也要能接住增量
          item = { itemKey: message.itemKey, kind: message.field === 'output' ? 'command' : 'assistant.message', data: {} };
          map.set(message.itemKey, item);
        }
        const data = item.data as { text?: string; outputTail?: string };
        if (message.field === 'text') data.text = (data.text ?? '') + message.append;
        else data.outputTail = (data.outputTail ?? '') + message.append;
        this.hot.set(message.sessionId, map);
        this.notify();
        break;
      }
      case 'update': {
        const map = this.hot.get(message.sessionId) ?? new Map<string, HotItem>();
        const item = map.get(message.itemKey);
        const payload = message.data as { started?: boolean; kind?: string; data?: unknown };
        if (item !== undefined) {
          item.data = payload.data ?? message.data;
        } else if (payload.started === true) {
          // 流式期间新开始的条目：客户端先建热条目，后续 delta 才有地方增长
          map.set(message.itemKey, {
            itemKey: message.itemKey,
            kind: (payload.kind ?? 'tool.call') as HotItem['kind'],
            data: payload.data ?? {},
          });
        }
        this.hot.set(message.sessionId, map);
        this.notify();
        break;
      }
      case 'ack': {
        const entry = this.outbox.get(message.clientCommandId);
        if (entry !== undefined) {
          entry.status = message.result.ok ? 'sent' : 'failed';
          this.outbox.set(message.clientCommandId, entry);
          if (message.result.ok) void cache.deleteOutbox(message.clientCommandId);
        }
        for (const [sessionId, list] of this.pending) {
          const match = list.find((item) => item.clientCommandId === message.clientCommandId);
          if (match !== undefined) {
            match.status = message.result.ok ? 'sent' : 'failed';
            this.pending.set(sessionId, list);
          }
        }
        this.notify();
        break;
      }
      default:
        break;
    }
  }

  setCurrentSession(sessionId: string | null): void {
    this.currentSessionId = sessionId;
    if (sessionId !== null && this.unread.delete(sessionId)) this.notify();
  }

  private bumpUnread(sessionId: string, title: string): void {
    if (this.currentSessionId === sessionId) return;
    this.unread.set(sessionId, (this.unread.get(sessionId) ?? 0) + 1);
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('WebDCC', { body: `${title} 有新的进展` });
      }
    } catch {
      // 通知不可用时静默
    }
    this.notify();
  }

  unreadTotal(): number {
    let total = 0;
    for (const count of this.unread.values()) total += count;
    return total;
  }

  appendDraft(sessionId: string, text: string): void {
    const current = this.getDraft(sessionId);
    const next = current.text === '' ? text : `${current.text}
${text}`;
    this.setDraft(sessionId, next, current.fileIds);
  }

  applyEvent(event: StoredEvent): void {
    const map = this.events.get(event.sessionId) ?? new Map<number, StoredEvent>();
    map.set(event.seq, event);
    this.events.set(event.sessionId, map);
    const hot = this.hot.get(event.sessionId);
    if (hot !== undefined) hot.delete(event.itemKey);
    if (event.kind === 'turn.completed' || event.kind === 'approval.request') {
      this.bumpUnread(event.sessionId, this.sessions.get(event.sessionId)?.title ?? '会话');
    }
    if (event.kind === 'user.message') {
      const clientCommandId = (event.data as { clientCommandId?: string }).clientCommandId;
      if (clientCommandId !== undefined) {
        const list = this.pending.get(event.sessionId) ?? [];
        this.pending.set(event.sessionId, list.filter((item) => item.clientCommandId !== clientCommandId));
      }
    }
    this.queueCache(event);
    this.notify();
  }

  // ---------- 会话加载 ----------

  trace: Record<string, number> = {};

  async ensureSession(sessionId: string): Promise<void> {
    const t0 = performance.now();
    this.trace['ensureStart'] = t0;
    if (this.events.has(sessionId) === false) {
      const cached = await cache.getEvents(sessionId, 500).catch(() => []);
      const map = new Map<number, StoredEvent>();
      for (const event of cached) map.set(event.seq, event);
      this.events.set(sessionId, map);
    }
    performance.mark('wdcc:ensure-start');
    let serverLastSeq: number | undefined;
    if (this.sessions.has(sessionId) === false) {
      try {
        const detail = await api.session(sessionId);
        this.sessions.set(sessionId, detail as SessionMeta);
        serverLastSeq = detail.lastSeq;
        void cache.putSession(detail as CachedSession);
      } catch {
        // 会话可能已删除；保持现状
      }
    }
    performance.mark('wdcc:detail-done');
    const localMax = this.maxSeq(sessionId);
    // 没有缓存时只取最近 200 条，并从服务端最新的 seq 开始订阅：不整段重拉（SPEC 7.5 / A5）
    if ((this.events.get(sessionId)?.size ?? 0) === 0 && serverLastSeq !== undefined && serverLastSeq > 0) {
      const page = await api.events(sessionId, { before: serverLastSeq + 1, limit: 200 }).catch(() => undefined);
      if (page !== undefined) {
        const map = this.events.get(sessionId) ?? new Map<number, StoredEvent>();
        for (const event of page.events) map.set(event.seq, event);
        this.events.set(sessionId, map);
        void cache.putEvents(page.events);
      }
      const cursor = Math.max(serverLastSeq, localMax);
      this.cursors.set(sessionId, cursor);
      this.connection.subscribe(sessionId, cursor);
      performance.mark('wdcc:events-done');
    } else {
      const cursor = Math.max(this.cursors.get(sessionId) ?? 0, localMax);
      this.cursors.set(sessionId, cursor);
      this.connection.subscribe(sessionId, cursor);
    }
    this.trace['ensureEnd'] = performance.now();
    this.notify();
  }

  async loadOlder(sessionId: string): Promise<boolean> {
    const map = this.events.get(sessionId);
    if (map === undefined) return false;
    const first = [...map.keys()].sort((a, b) => a - b)[0];
    if (first === undefined || first <= 1) return false;
    const page = await api.events(sessionId, { before: first, limit: 200 }).catch(() => undefined);
    if (page === undefined || page.events.length === 0) return false;
    for (const event of page.events) map.set(event.seq, event);
    void cache.putEvents(page.events);
    this.notify();
    return true;
  }

  // ---------- 选择器 ----------

  getSession(sessionId: string): SessionMeta | undefined {
    return this.sessions.get(sessionId);
  }

  getSessions(): SessionMeta[] {
    return [...this.sessions.values()].sort((a, b) => {
      if (a.pinned === b.pinned) return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.pinned === true ? -1 : 1;
    });
  }

  getEvents(sessionId: string): StoredEvent[] {
    const map = this.events.get(sessionId);
    if (map === undefined) return [];
    return [...map.values()].sort((a, b) => a.seq - b.seq);
  }

  getPending(sessionId: string): PendingMessage[] {
    return this.pending.get(sessionId) ?? [];
  }

  getHot(sessionId: string): HotItem[] {
    return [...(this.hot.get(sessionId)?.values() ?? [])];
  }

  /** 按 turnId 分组，供虚拟列表渲染 */
  getTurns(sessionId: string): TurnModel[] {
    const cached = this.derived.get(sessionId);
    if (cached !== undefined && cached.version === this.version) return cached.turns;

    const events = this.getEvents(sessionId);
    const hot = this.getHot(sessionId);
    const byTurn = new Map<string, TurnModel>();
    const order: string[] = [];
    for (const event of events) {
      let turn = byTurn.get(event.turnId);
      if (turn === undefined) {
        turn = { turnId: event.turnId, events: [], hot: [], startedAt: event.at };
        byTurn.set(event.turnId, turn);
        order.push(event.turnId);
      }
      turn.events.push(event);
      if (event.kind === 'user.message') turn.user = event;
      if (event.kind === 'turn.completed') turn.completed = event;
    }
    for (const item of hot) {
      const turnId = item.turnId ?? 'live';
      let turn = byTurn.get(turnId);
      if (turn === undefined) {
        turn = { turnId, events: [], hot: [], startedAt: nowIso() };
        byTurn.set(turnId, turn);
        order.push(turnId);
      }
      turn.hot.push(item);
    }
    for (const pending of this.getPending(sessionId)) {
      const turnId = `pending-${pending.clientCommandId}`;
      const turn: TurnModel = { turnId, events: [], hot: [], startedAt: pending.at, pending };
      byTurn.set(turnId, turn);
      order.push(turnId);
    }
    const turns = order.map((turnId) => byTurn.get(turnId) as TurnModel);
    this.derived.set(sessionId, { version: this.version, turns });
    return turns;
  }

  // ---------- 命令 ----------

  private enqueue(command: Command): void {
    this.outbox.set(command.clientCommandId, { command, status: 'pending' });
    void cache.putOutbox({ clientCommandId: command.clientCommandId, command, status: 'pending', createdAt: Date.now() });
    this.connection.sendCommand(command);
  }

  private replayOutbox(): void {
    for (const entry of this.outbox.values()) {
      if (entry.status === 'sent') continue;
      this.connection.sendCommand(entry.command);
    }
  }

  async restoreOutbox(): Promise<void> {
    const entries = await cache.getOutbox().catch(() => []);
    for (const entry of entries) {
      this.outbox.set(entry.clientCommandId, { command: entry.command as Command, status: entry.status });
    }
  }

  sendMessage(sessionId: string, text: string, images: string[] = []): PendingMessage {
    const clientCommandId = ulid();
    const pending: PendingMessage = { clientCommandId, text, at: nowIso(), status: 'pending' };
    const list = this.pending.get(sessionId) ?? [];
    list.push(pending);
    this.pending.set(sessionId, list);
    this.enqueue({
      op: 'send',
      clientCommandId,
      sessionId,
      text,
      ...(images.length === 0 ? {} : { images }),
    });
    this.notify();
    return pending;
  }

  approve(sessionId: string, approvalId: string, optionId: string): void {
    this.enqueue({ op: 'approve', clientCommandId: ulid(), sessionId, approvalId, optionId });
  }

  answer(sessionId: string, questionId: string, answer: unknown): void {
    this.enqueue({ op: 'answer', clientCommandId: ulid(), sessionId, questionId, answer });
  }

  interrupt(sessionId: string): void {
    this.enqueue({ op: 'interrupt', clientCommandId: ulid(), sessionId, createdAt: Date.now() });
  }

  rename(sessionId: string, title: string): void {
    this.enqueue({ op: 'rename', clientCommandId: ulid(), sessionId, title });
  }

  archive(sessionId: string, archived: boolean): void {
    this.enqueue({ op: 'archive', clientCommandId: ulid(), sessionId, archived });
  }

  async createSession(input: {
    workspaceId: string;
    agent: string;
    providerId?: string | null;
    model?: string;
    accessMode?: string;
  }): Promise<string> {
    const command: Command = {
      op: 'create-session',
      clientCommandId: ulid(),
      workspaceId: input.workspaceId,
      agent: input.agent,
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.accessMode === undefined ? {} : { accessMode: input.accessMode }),
    };
    const result = await api.command(command);
    if (!result.ok) throw new Error(result.error ?? '创建会话失败');
    const value = result.value as { sessionId?: string } | undefined;
    return value?.sessionId ?? '';
  }

  // ---------- 草稿 ----------

  getDraft(sessionId: string): { text: string; fileIds: string[] } {
    return this.drafts.get(sessionId) ?? { text: '', fileIds: [] };
  }

  setDraft(sessionId: string, text: string, fileIds: string[] = []): void {
    this.drafts.set(sessionId, { text, fileIds });
    void cache.putDraft({ sessionId, text, fileIds });
    const existing = this.draftTimers.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);
    this.draftTimers.set(
      sessionId,
      setTimeout(() => {
        void api.saveDraft(sessionId, text, fileIds).catch(() => undefined);
      }, 1000),
    );
  }

  /** 立即把草稿写进 IndexedDB 与服务端（"带到…"后马上跳转时用） */
  async flushDraft(sessionId: string): Promise<void> {
    const draft = this.getDraft(sessionId);
    await cache.putDraft({ sessionId, text: draft.text, fileIds: draft.fileIds }).catch(() => undefined);
    await api.saveDraft(sessionId, draft.text, draft.fileIds).catch(() => undefined);
  }

  async loadDraft(sessionId: string): Promise<{ text: string; fileIds: string[] }> {
    const local = await cache.getDraft(sessionId).catch(() => undefined);
    if (local !== undefined) {
      this.drafts.set(sessionId, { text: local.text, fileIds: local.fileIds });
      return { text: local.text, fileIds: local.fileIds };
    }
    const remote = await api.draft(sessionId).catch(() => undefined);
    if (remote !== undefined) {
      this.drafts.set(sessionId, { text: remote.text, fileIds: remote.fileIds });
      return { text: remote.text, fileIds: remote.fileIds };
    }
    return { text: '', fileIds: [] };
  }
}

export const store = new AppStore();

// 便于 e2e 与排错观察内部状态（只读用途）
(globalThis as { __wdccStore?: AppStore }).__wdccStore = store;
