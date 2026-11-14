/** 全局状态：会话、事件、进行中条目、草稿、发件箱（SPEC 7.4、7.5） */
import type { Command, EventData, EventKind, OpenItem, ServerMessage, SessionDto, StoredEvent, TurnView, QueuedInput, PermissionState, InputContent, InputIntent } from '@webdcc/protocol';
import { isInputContent, publicInputContent, reduceTurn, ulid } from '@webdcc/protocol';
import { api } from './api.js';
import { cache, type CachedSession } from './db.js';
import { SyncConnection, type ConnectionState } from './connection.js';
import { InputPreparationStore } from './input-preparation-store.js';
import { UploadController } from './upload-controller.js';
import { SyncedInputDraftStore } from './synced-input-draft-store.js';
import type { PreparedPart } from './composer-input-controller.js';

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
  reasoningEffort?: string;
  accessMode?: string;
  permissions?: PermissionState;
  createdAt?: string;
  lastSeq?: number;
  /** 接续会话的上一棒 */
  parentId?: string;
  handoffKind?: SessionDto['handoffKind'];
}

export interface HotItem {
  itemKey: string;
  kind: EventKind;
  data: unknown;
  turnId?: string | null;
}

const hotKey = (turnId: string | null | undefined, itemKey: string): string => JSON.stringify([turnId ?? null, itemKey]);
function hotEntry(map: Map<string, HotItem>, itemKey: string, turnId: string | null | undefined): HotItem | undefined {
  if (turnId !== undefined) return map.get(hotKey(turnId, itemKey));
  // Legacy frames can update legacy items only. Their missing identity must
  // not be inferred from whichever scoped item is currently visible.
  const legacy = map.get(hotKey(undefined, itemKey));
  return legacy?.turnId === undefined ? legacy : undefined;
}

export interface PendingMessage {
  clientCommandId: string;
  text: string;
  at: string;
  status: 'pending' | 'queued' | 'sent' | 'failed' | 'uncertain';
  turnId?: string;
  images?: string[];
  contentParts?: InputContent;
  error?: string;
}

export interface TurnModel extends TurnView {
  events: StoredEvent[];
  hot: HotItem[];
  /** Legacy event handles used by non-timeline panels during migration. */
  legacyUser?: StoredEvent;
  started?: StoredEvent;
  completed?: StoredEvent;
  pending?: PendingMessage;
}

export interface InteractionSubmission {
  commandId: string;
  status: 'pending' | 'collected' | 'sent' | 'failed' | 'uncertain';
  error?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class AppStore {
  private sessions = new Map<string, SessionMeta>();
  private events = new Map<string, Map<number, StoredEvent>>();
  private hot = new Map<string, Map<string, HotItem>>();
  private pending = new Map<string, PendingMessage[]>();
  private durableQueue = new Map<string, QueuedInput[]>();
  private queueRevisions = new Map<string, number>();
  private drafts = new Map<string, { text: string; fileIds: string[] }>();
  private outbox = new Map<string, { command: Command; status: PendingMessage['status']; durable?: boolean; createdAt?: number; error?: string }>();
  private interactionSubmissions = new Map<string, InteractionSubmission>();
  private listeners = new Set<() => void>();
  private derived = new Map<string, { version: number; turns: TurnModel[] }>();
  /** 每个会话的订阅游标：新浏览器打开大会话时从服务端最新 seq 开始，不整段重拉 */
  private cursors = new Map<string, number>();
  private readonly interests = new Set<string>();
  private readonly subscribed = new Set<string>();
  private readonly sensitiveCommands = new Set<string>();
  private version = 0;
  private draftTimers = new Map<string, NodeJS.Timeout>();
  private readonly preparationStore = new InputPreparationStore<PreparedPart>();
  private readonly preparedDraftWrites = new Map<string, Promise<void>>();
  private readonly syncedLegacyDrafts = new SyncedInputDraftStore(this.preparationStore, new UploadController({ store: this.preparationStore }));
  private readonly draftRecovery = new Map<string, (input: Extract<Command, { op: 'send' }>) => boolean>();

  readonly connection: SyncConnection;
  /** 非当前查看的会话完成/等待审批时的未读数（A13） */
  unread = new Map<string, number>();
  currentSessionId: string | null = null;
  private visibleSessionIds = new Set<string>();
  feedSeq = 0;
  /** 窄屏抽屉侧边栏（F9） */
  drawerOpen = false;
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
    const readVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      let changed = false;
      for (const id of this.visibleSessionIds) changed = this.unread.delete(id) || changed;
      if (changed) this.notify();
    };
    document.addEventListener('visibilitychange', readVisible);
    window.addEventListener('focus', readVisible);
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
    return [...this.subscribed].map((sessionId) => ({
      sessionId,
      afterSeq: this.cursors.get(sessionId) ?? this.contiguousSeq(sessionId, 0),
    }));
  }

  maxSeq(sessionId: string): number {
    const map = this.events.get(sessionId);
    if (map === undefined || map.size === 0) return 0;
    let max = 0;
    for (const seq of map.keys()) if (seq > max) max = seq;
    return max;
  }

  private contiguousSeq(sessionId: string, after: number): number {
    const events = this.events.get(sessionId);
    while (events?.has(after + 1)) after++;
    return after;
  }

  // ---------- 服务端消息 ----------

  private handleMessage(message: ServerMessage): void {
    switch (message.op) {
      case 'feed': {
        if (message.patch.queueRevision !== undefined) void this.refreshQueue(message.sessionId);
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
          ...(patch['model'] === undefined ? {} : { model: String(patch['model']) }),
          ...(patch['reasoningEffort'] === undefined ? {} : { reasoningEffort: String(patch['reasoningEffort']) }),
          ...(patch['accessMode'] === undefined ? {} : { accessMode: String(patch['accessMode']) }),
          ...(patch['permissions'] === undefined ? {} : { permissions: patch['permissions'] as PermissionState }),
          ...(patch['providerId'] === undefined ? {} : { providerId: patch['providerId'] === null ? null : String(patch['providerId']) }),
          ...(typeof patch['parentId'] === 'string' ? { parentId: patch['parentId'] } : {}),
          ...(patch['handoffKind'] === 'manual' || patch['handoffKind'] === 'watchdog' ? { handoffKind: patch['handoffKind'] } : {}),
          updatedAt: nowIso(),
        };
        this.sessions.set(message.sessionId, next);
        void cache.putSession(next as CachedSession);
        if (patch['created'] === true && this.subscribed.has(message.sessionId)) this.connection.subscribe(message.sessionId, this.cursors.get(message.sessionId) ?? 0);
        if (existing !== undefined && !this.subscribed.has(message.sessionId) &&
          (next.status === 'waiting' && existing.status !== 'waiting' || next.status === 'idle' && (existing.status === 'running' || existing.status === 'waiting'))) this.bumpUnread(message.sessionId, next.title ?? '会话');
        this.notify();
        break;
      }
      case 'event': {
        this.applyEvent(message.event, message.history === true);
        break;
      }
      case 'snapshot': {
        const map = new Map<string, HotItem>();
        for (const item of message.items) {
          map.set(hotKey(item.turnId, item.itemKey), { itemKey: item.itemKey, kind: item.kind, data: item.data, ...(item.turnId === undefined ? {} : { turnId: item.turnId }) });
        }
        this.hot.set(message.sessionId, map);
        this.notify();
        break;
      }
      case 'delta': {
        const map = this.hot.get(message.sessionId) ?? new Map<string, HotItem>();
        const item = hotEntry(map, message.itemKey, message.turnId);
        // A delta without a preceding item.start/update violates the adapter
        // contract. Ignore it; manufacturing a live item makes refresh differ
        // from streaming state and hides the real translator bug.
        if (item === undefined) break;
        const data = item.data as { text?: string; outputTail?: string };
        if (message.field === 'text') data.text = (data.text ?? '') + message.append;
        else data.outputTail = (data.outputTail ?? '') + message.append;
        this.hot.set(message.sessionId, map);
        this.notify();
        break;
      }
      case 'update': {
        const map = this.hot.get(message.sessionId) ?? new Map<string, HotItem>();
        const item = hotEntry(map, message.itemKey, message.turnId);
        const payload = message.data as { started?: boolean; kind?: string; data?: unknown };
        if (item !== undefined) {
          item.data = payload.data ?? message.data;
        } else if (payload.started === true) {
          const previous = this.events.get(message.sessionId);
          if (previous !== undefined && [...previous.values()].some(event =>
            (event.turnId ?? null) === (message.turnId ?? null) && (event.itemKey === message.itemKey || event.kind === 'turn.completed'))) break;
          // 流式期间新开始的条目：客户端先建热条目，后续 delta 才有地方增长
          map.set(hotKey(message.turnId, message.itemKey), {
            itemKey: message.itemKey,
            kind: (payload.kind ?? 'tool.call') as HotItem['kind'],
            data: payload.data ?? {},
            ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
          });
        }
        this.hot.set(message.sessionId, map);
        this.notify();
        break;
      }
      case 'ack': {
        const entry = this.outbox.get(message.clientCommandId);
        if (entry !== undefined && (entry.command.op === 'answer' || entry.command.op === 'approve')) {
          const command = entry.command;
          const id = command.op === 'answer' ? command.questionId : command.approvalId;
          const key = JSON.stringify([command.sessionId, command.op, id]);
          if (this.interactionSubmissions.get(key)?.commandId === message.clientCommandId) {
            const collected = message.result.ok && (message.result.value as { submitted?: unknown } | undefined)?.submitted === false;
            this.interactionSubmissions.set(key, { commandId: message.clientCommandId, status: message.result.ok ? collected ? 'collected' : 'sent' : message.result.code === 'uncertain' ? 'uncertain' : 'failed', ...(message.result.ok ? {} : { error: message.result.error }) });
          }
        }
        if (entry !== undefined) {
          entry.status = message.result.ok ? 'sent' : message.result.code === 'uncertain' ? 'uncertain' : 'failed';
          this.outbox.set(message.clientCommandId, entry);
          if (message.result.ok) { this.outbox.delete(message.clientCommandId); void cache.deleteOutbox(message.clientCommandId); }
          else void cache.putOutbox({ clientCommandId: message.clientCommandId, command: this.cachedCommand(entry.command), status: entry.status === 'uncertain' ? 'uncertain' : 'failed', createdAt: entry.createdAt ?? Date.now(), error: message.result.error, ...(this.sensitiveCommands.has(message.clientCommandId) ? { sensitive: true } : {}) });
        }
        for (const [sessionId, list] of this.pending) {
          const match = list.find((item) => item.clientCommandId === message.clientCommandId);
          if (match !== undefined) {
            const queued = message.result.ok && typeof message.result.value === 'object' && message.result.value !== null && (message.result.value as { queued?: unknown }).queued === true;
            match.status = message.result.ok ? queued ? 'queued' : 'sent' : message.result.code === 'uncertain' ? 'uncertain' : 'failed';
            match.error = message.result.ok ? undefined : message.result.error;
            if (message.result.ok && typeof message.result.value === 'object' && message.result.value !== null) match.turnId = (message.result.value as { turnId?: string }).turnId;
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

  setCurrentSession(sessionId: string | null, dockSessionId?: string): void {
    this.currentSessionId = sessionId;
    this.visibleSessionIds = new Set([sessionId, dockSessionId].filter((id): id is string => typeof id === 'string'));
    for (const id of this.interests) if (!this.visibleSessionIds.has(id)) {
      this.interests.delete(id); this.subscribed.delete(id); this.connection.unsubscribe(id);
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    let changed = false;
    for (const id of this.visibleSessionIds) changed = this.unread.delete(id) || changed;
    if (changed) this.notify();
  }

  private bumpUnread(sessionId: string, title: string): void {
    if (this.visibleSessionIds.has(sessionId) && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) return;
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

  setDrawer(open: boolean): void {
    if (this.drawerOpen === open) return;
    this.drawerOpen = open;
    this.notify();
  }

  unreadTotal(): number {
    let total = 0;
    for (const count of this.unread.values()) total += count;
    return total;
  }

  appendDraft(sessionId: string, text: string): void {
    const current = this.getDraft(sessionId);
    const pending = this.preparedDraftWrites.get(sessionId) ?? Promise.resolve();
    const write = pending.catch(() => undefined).then(async () => {
      const previous = await this.preparationStore.getDraft(sessionId);
      const priorText = previous?.text ?? current.text;
      const nextText = priorText === '' ? text : `${priorText}\n${text}`;
      const contentParts = previous?.contentParts ?? { version: 1 as const, parts: current.fileIds.map(fileId => ({ type: 'image', fileId })) };
      await this.preparationStore.putDraft({ sessionId, revision: (previous?.revision ?? 0) + 1, text: nextText, contentParts, updatedAt: Date.now() }, previous?.revision ?? 0);
      const fileIds = contentParts.parts.flatMap(part => part.fileId === undefined ? [] : [part.fileId]);
      this.drafts.set(sessionId, { text: nextText, fileIds });
      await cache.putDraft({ sessionId, text: nextText, fileIds });
    });
    this.preparedDraftWrites.set(sessionId, write); void write.catch(() => undefined);
  }

  applyEvent(event: StoredEvent, historical = false): void {
    const map = this.events.get(event.sessionId) ?? new Map<number, StoredEvent>();
    const seen = map.has(event.seq);
    map.set(event.seq, event);
    this.events.set(event.sessionId, map);
    this.cursors.set(event.sessionId, this.contiguousSeq(event.sessionId, this.cursors.get(event.sessionId) ?? 0));
    const hot = this.hot.get(event.sessionId);
    if (hot !== undefined) {
      hot.delete(hotKey(event.turnId, event.itemKey));
      if (event.kind === 'turn.completed') for (const [key, item] of hot) if (item.turnId === event.turnId) hot.delete(key);
    }
    if (!seen && !historical && (event.kind === 'turn.completed' || event.kind === 'approval.request')) {
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
    this.interests.add(sessionId);
    void this.refreshQueue(sessionId);
    const t0 = performance.now();
    this.trace['ensureStart'] = t0;
    if (this.events.has(sessionId) === false) {
      const cached = await cache.getEvents(sessionId, 500).catch(() => []);
      // 等缓存的这段时间里，实时通道可能已经送来了新事件（例如刚发出的 user.message）：
      // 只能合并，不能整张表替换，否则这些事件会丢掉，直到刷新才出现
      const map = this.events.get(sessionId) ?? new Map<number, StoredEvent>();
      for (const event of cached) if (!map.has(event.seq)) map.set(event.seq, event);
      this.events.set(sessionId, map);
      const coverage = await cache.getMeta<{ from: number; to: number }>(`coveredWindow:${sessionId}`).catch(() => undefined);
      if (coverage !== undefined && Number.isSafeInteger(coverage.from) && Number.isSafeInteger(coverage.to) && coverage.from > 0 && coverage.to >= coverage.from &&
        this.contiguousSeq(sessionId, coverage.from - 1) >= coverage.to) this.cursors.set(sessionId, coverage.to);
    }
    performance.mark('wdcc:ensure-start');
    let serverLastSeq: number | undefined;
    // Read the current end even with a partial cache. Joining from zero while
    // showing cached state otherwise replays every old goal/tool update first.
    const beforeDetail = this.sessions.get(sessionId);
    try {
      const detail = await api.session(sessionId);
      const live = this.sessions.get(sessionId);
      const next = live !== beforeDetail && live !== undefined ? { ...detail, ...live } : detail;
      this.sessions.set(sessionId, next as SessionMeta);
      serverLastSeq = detail.lastSeq;
      void cache.putSession(next as CachedSession);
    } catch {
      // 会话可能已删除；保持现状
    }
    performance.mark('wdcc:detail-done');
    // 没有缓存时只取最近 200 条，并从服务端最新的 seq 开始订阅：不整段重拉（SPEC 7.5 / A5）
    if (serverLastSeq !== undefined && serverLastSeq > 0 && (serverLastSeq > this.maxSeq(sessionId) ||
      this.contiguousSeq(sessionId, this.cursors.get(sessionId) ?? 0) < serverLastSeq)) {
      const priorCursor = this.cursors.get(sessionId) ?? 0;
      const page = await api.events(sessionId, { before: serverLastSeq + 1, limit: 200 }).catch(() => undefined);
      const completeRecentPage = page !== undefined && page.events.length > 0 && page.events.every((event, index) => event.seq === page.events[0]!.seq + index) && page.events.at(-1)?.seq === serverLastSeq;
      let persisted = false;
      if (page !== undefined) {
        const map = this.events.get(sessionId) ?? new Map<number, StoredEvent>();
        for (const event of page.events) map.set(event.seq, event);
        this.events.set(sessionId, map);
        persisted = await cache.putEvents(page.events, completeRecentPage ? { sessionId, from: page.events[0]!.seq, to: serverLastSeq } : undefined).then(() => true, () => false);
      }
      const cursor = completeRecentPage && persisted ? this.contiguousSeq(sessionId, serverLastSeq)
        : page !== undefined && !persisted ? priorCursor : this.contiguousSeq(sessionId, priorCursor);
      this.cursors.set(sessionId, cursor);
      if (this.interests.has(sessionId)) { this.subscribed.add(sessionId); this.connection.subscribe(sessionId, cursor); }
      performance.mark('wdcc:events-done');
    } else {
      const cursor = this.contiguousSeq(sessionId, this.cursors.get(sessionId) ?? 0);
      this.cursors.set(sessionId, cursor);
      if (this.interests.has(sessionId)) { this.subscribed.add(sessionId); this.connection.subscribe(sessionId, cursor); }
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

  /** 轮次之外的事件（turnId 为 null）：只进轨迹，不构成一轮 */
  private orphans = new Map<string, StoredEvent[]>();

  getOrphans(sessionId: string): StoredEvent[] {
    return this.orphans.get(sessionId) ?? [];
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
    const sent = new Set(this.getEvents(sessionId).filter(event => event.kind === 'user.message').map(event => (event.data as { clientCommandId?: string }).clientCommandId));
    const authoritative = this.durableQueue.get(sessionId);
    const queued = new Set((authoritative ?? []).filter(row => ['queued', 'uncertain'].includes(row.state)).map(row => row.commandId));
    const pending = new Map((this.pending.get(sessionId) ?? []).filter(item => !sent.has(item.clientCommandId) && !(authoritative !== undefined && item.status === 'queued' && !queued.has(item.clientCommandId))).map(item => [item.clientCommandId, item]));
    for (const row of this.durableQueue.get(sessionId) ?? []) {
      if (sent.has(row.commandId) || !['queued', 'uncertain'].includes(row.state)) continue;
      pending.set(row.commandId, { clientCommandId: row.commandId, turnId: row.turnId, text: row.input.text,
        ...(row.input.contentParts === undefined ? {} : { contentParts: publicInputContent(row.input.contentParts) }),
        ...(row.input.images === undefined ? {} : { images: row.input.images.map(image => image.fileId) }),
        ...(row.preparationError === undefined ? {} : { error: row.preparationError }),
        at: row.createdAt, status: row.state === 'uncertain' ? 'uncertain' : 'queued' });
    }
    return [...pending.values()];
  }

  async refreshQueue(sessionId: string): Promise<void> {
    const result = await api.queue(sessionId).catch(() => undefined);
    if (result === undefined) return;
    if (result.revision < (this.queueRevisions.get(sessionId) ?? -1)) return;
    this.queueRevisions.set(sessionId, result.revision);
    this.durableQueue.set(sessionId, result.inputs);
    this.notify();
  }

  async cancelQueued(sessionId: string, commandId: string): Promise<void> {
    await api.cancelQueued(sessionId, commandId);
    this.pending.set(sessionId, (this.pending.get(sessionId) ?? []).filter(item => item.clientCommandId !== commandId));
    await this.refreshQueue(sessionId);
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
    // 轮次之外的事件（turnId 为 null）不构成一轮，只在轨迹里显示（F4）
    const orphans: StoredEvent[] = [];
    for (const event of events) {
      if (event.turnId === null) {
        orphans.push(event);
        continue;
      }
      let turn = byTurn.get(event.turnId);
      if (turn === undefined) {
        turn = { ...reduceTurn([], []), turnId: event.turnId, events: [], hot: [] };
        byTurn.set(event.turnId, turn);
        order.push(event.turnId);
      }
      turn.events.push(event);
      if (event.kind === 'user.message') turn.legacyUser = event;
      if (event.kind === 'turn.started') turn.started = event;
      if (event.kind === 'turn.completed') turn.completed = event;
    }
    for (const item of hot) {
      if (item.turnId === null || item.turnId === undefined) {
        continue;
      }
      let turn = byTurn.get(item.turnId);
      if (turn === undefined) {
        turn = { ...reduceTurn([], []), turnId: item.turnId, events: [], hot: [] };
        byTurn.set(item.turnId, turn);
        order.push(item.turnId);
      }
      turn.hot.push(item);
    }
    this.orphans.set(sessionId, orphans);
    for (const pending of this.getPending(sessionId)) {
      const turnId = pending.turnId ?? `pending-${pending.clientCommandId}`;
      const existing = byTurn.get(turnId);
      if (existing !== undefined) { existing.pendingInputs = [...existing.pendingInputs ?? [], pending]; continue; }
      const turn: TurnModel = {
        ...reduceTurn([], []),
        turnId,
        state: 'starting',
        user: { text: pending.text, images: pending.images, contentParts: pending.contentParts, at: pending.at },
        startedAt: pending.at,
        events: [],
        hot: [],
        pending,
      };
      byTurn.set(turnId, turn);
      order.push(turnId);
    }
    const turns = order.map((turnId) => {
      const turn = byTurn.get(turnId) as TurnModel;
      if (turn.pending !== undefined) return turn;
      const view = reduceTurn(turn.events, turn.hot as unknown as OpenItem[]);
      const uncertain = (this.durableQueue.get(sessionId) ?? []).some(row => row.turnId === turnId && row.state === 'uncertain');
      return { ...turn, ...view, turnId, ...(uncertain ? { commandState: 'uncertain' as const } : {}) };
    });
    this.derived.set(sessionId, { version: this.version, turns });
    return turns;
  }

  // ---------- 命令 ----------

  private cachedCommand(command: Command): Command {
    return command.op === 'answer' && this.sensitiveCommands.has(command.clientCommandId) ? { ...command, answer: { omitted: 'sensitive-answer' } } : command;
  }

  private enqueue(command: Command, sensitive = false): Promise<boolean> {
    if (sensitive) this.sensitiveCommands.add(command.clientCommandId);
    const createdAt = Date.now();
    this.outbox.set(command.clientCommandId, { command, status: 'pending', durable: false, createdAt });
    if (command.op === 'approve' || command.op === 'answer') {
      this.interactionSubmissions.set(JSON.stringify([command.sessionId, command.op, command.op === 'answer' ? command.questionId : command.approvalId]), { commandId: command.clientCommandId, status: 'pending' });
      this.notify();
    }
    return cache.putOutbox({ clientCommandId: command.clientCommandId, command: this.cachedCommand(command), status: 'pending', createdAt, ...(sensitive ? { sensitive: true } : {}) }).then(() => {
      const entry = this.outbox.get(command.clientCommandId); if (entry !== undefined) entry.durable = true;
      this.connection.sendCommand(command); return true;
    }).catch(() => {
      const entry = this.outbox.get(command.clientCommandId);
      if (entry !== undefined) entry.status = 'failed';
      if (command.op === 'approve' || command.op === 'answer') {
        const key = JSON.stringify([command.sessionId, command.op, command.op === 'answer' ? command.questionId : command.approvalId]);
        if (this.interactionSubmissions.get(key)?.commandId === command.clientCommandId) this.interactionSubmissions.set(key, { commandId: command.clientCommandId, status: 'failed', error: '答案未能保存，请重试' });
      }
      for (const item of this.pending.get('sessionId' in command ? command.sessionId : '') ?? []) if (item.clientCommandId === command.clientCommandId) { item.status = 'failed'; item.error = '消息未能保存，正文和附件仍在草稿中'; }
      this.notify();
      return false;
    });
  }

  private replayOutbox(): void {
    for (const entry of this.outbox.values()) {
      if (entry.status !== 'pending' || entry.durable !== true) continue;
      this.connection.sendCommand(entry.command);
    }
  }

  async restoreOutbox(): Promise<void> {
    const entries = await cache.getOutbox().catch(() => []);
    for (const entry of entries) {
      const status = entry.sensitive && entry.status !== 'uncertain' ? 'failed' : entry.status;
      this.outbox.set(entry.clientCommandId, { command: entry.command as Command, status, durable: true, createdAt: entry.createdAt, error: entry.error });
      const command = entry.command as Command;
      if (command.op === 'approve' || command.op === 'answer') this.interactionSubmissions.set(JSON.stringify([command.sessionId, command.op, command.op === 'answer' ? command.questionId : command.approvalId]), { commandId: command.clientCommandId, status: status === 'uncertain' ? 'uncertain' : status === 'failed' ? 'failed' : 'pending', ...(entry.sensitive && status === 'failed' ? { error: '敏感回答未保留，请重新输入；已送达的回应以原生状态为准。' } : {}) });
      if (command.op === 'send') {
        const list = this.pending.get(command.sessionId) ?? [];
        list.push({ clientCommandId: command.clientCommandId, text: command.text, images: command.images, contentParts: command.contentParts, error: entry.error,
          ...(command.intent !== 'steer' || command.expectedTurnId === undefined ? {} : { turnId: command.expectedTurnId }), at: new Date(entry.createdAt).toISOString(), status: entry.status });
        this.pending.set(command.sessionId, list);
      }
    }
  }

  sendMessage(sessionId: string, text: string, images: string[] = []): PendingMessage {
    const clientCommandId = ulid();
    const pending: PendingMessage = { clientCommandId, text, ...(images.length === 0 ? {} : { images }), at: nowIso(), status: 'pending' };
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

  /** Resolve only after IndexedDB admits the exact command. A network ACK
   * is separate; offline acceptance still retains the complete input. */
  async sendStructuredMessage(sessionId: string, text: string, contentParts: InputContent, intent: InputIntent = 'send', expectedTurnId?: string): Promise<{ commandId: string }> {
    if (!isInputContent(contentParts, text)) throw new Error('结构化输入与正文不一致或含有未授权字段');
    const commandId = ulid();
    const pending: PendingMessage = { clientCommandId: commandId, text, contentParts: structuredClone(contentParts),
      ...(intent !== 'steer' || expectedTurnId === undefined ? {} : { turnId: expectedTurnId }), at: nowIso(), status: 'pending' };
    this.pending.set(sessionId, [...this.pending.get(sessionId) ?? [], pending]);
    const accepted = this.enqueue({ op: 'send', clientCommandId: commandId, sessionId, text, contentParts: structuredClone(contentParts), intent,
      ...(expectedTurnId === undefined ? {} : { expectedTurnId }) });
    this.notify();
    if (!await accepted) throw new Error('消息未能保存，正文和附件仍在草稿中');
    return { commandId };
  }
  bindDraftRecovery(sessionId: string, recover: (input: Extract<Command, { op: 'send' }>) => boolean): () => void {
    this.draftRecovery.set(sessionId, recover);
    return () => { if (this.draftRecovery.get(sessionId) === recover) this.draftRecovery.delete(sessionId); };
  }
  canRecoverFailedInput(commandId?: string): boolean {
    const entry = commandId === undefined ? undefined : this.outbox.get(commandId);
    return entry?.status === 'failed' && entry.command.op === 'send';
  }
  recoverFailedInput(sessionId: string, commandId: string): void {
    const entry = this.outbox.get(commandId);
    if (entry?.status !== 'failed' || entry.command.op !== 'send' || entry.command.sessionId !== sessionId) throw new Error('请先核对原生执行结果，不能直接重发结果未确认的输入');
    if (this.draftRecovery.get(sessionId)?.(entry.command) !== true) throw new Error('请先打开该会话的输入框，待草稿恢复后再操作');
  }

  approve(sessionId: string, approvalId: string, optionId: string): void {
    if (['pending', 'sent', 'uncertain'].includes(this.getInteractionSubmission(sessionId, 'approve', approvalId)?.status ?? '')) return;
    this.enqueue({ op: 'approve', clientCommandId: ulid(), sessionId, approvalId, optionId });
  }

  getInteractionSubmission(sessionId: string, op: 'answer' | 'approve', id: string): InteractionSubmission | undefined {
    return this.interactionSubmissions.get(JSON.stringify([sessionId, op, id]));
  }

  answer(sessionId: string, questionId: string, answer: unknown): void {
    if (['pending', 'sent', 'uncertain'].includes(this.getInteractionSubmission(sessionId, 'answer', questionId)?.status ?? '')) return;
    const question = this.getEvents(sessionId).findLast(event => event.kind === 'question' && (event.data as EventData['question']).questionId === questionId);
    this.enqueue({ op: 'answer', clientCommandId: ulid(), sessionId, questionId, answer }, (question?.data as EventData['question'] | undefined)?.isSecret === true);
  }

  interrupt(sessionId: string): void {
    this.enqueue({ op: 'interrupt', clientCommandId: ulid(), sessionId, createdAt: Date.now() });
  }

  setAccessMode(sessionId: string, accessMode: string): void {
    this.enqueue({ op: 'set-access-mode', clientCommandId: ulid(), sessionId, accessMode });
  }

  setModel(sessionId: string, model: string): void {
    this.enqueue({ op: 'set-model', clientCommandId: ulid(), sessionId, model });
  }

  rename(sessionId: string, title: string): void {
    this.enqueue({ op: 'rename', clientCommandId: ulid(), sessionId, title });
  }

  archive(sessionId: string, archived: boolean): void {
    this.enqueue({ op: 'archive', clientCommandId: ulid(), sessionId, archived });
  }

  setPinned(sessionId: string, pinned: boolean): void {
    this.enqueue({ op: 'pin', clientCommandId: ulid(), sessionId, pinned });
  }

  async createSession(input: {
    workspaceId: string;
    agent: string;
    providerId?: string | null;
    model?: string;
    reasoningEffort?: string;
    accessMode?: string;
    parentId?: string;
  }): Promise<string> {
    const command: Command = {
      op: 'create-session',
      clientCommandId: ulid(),
      workspaceId: input.workspaceId,
      agent: input.agent,
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.accessMode === undefined ? {} : { accessMode: input.accessMode }),
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    };
    const result = await api.command(command);
    if (!result.ok) throw new Error(result.error ?? '创建会话失败');
    const value = result.value as { sessionId?: string } | undefined;
    return value?.sessionId ?? '';
  }

  setReasoningEffort(sessionId: string, reasoningEffort: string): void {
    this.enqueue({ op: 'set-reasoning-effort', clientCommandId: ulid(), sessionId, reasoningEffort });
  }

  // ---------- 草稿 ----------

  getDraft(sessionId: string): { text: string; fileIds: string[] } {
    return this.drafts.get(sessionId) ?? { text: '', fileIds: [] };
  }

  setDraft(sessionId: string, text: string, fileIds: string[] = []): void {
    this.drafts.set(sessionId, { text, fileIds });
    void cache.putDraft({ sessionId, text, fileIds });
    const pending = this.preparedDraftWrites.get(sessionId) ?? Promise.resolve();
    const write = pending.catch(() => undefined).then(async () => {
      const previous = await this.preparationStore.getDraft(sessionId);
      await this.preparationStore.putDraft({ sessionId, revision: (previous?.revision ?? 0) + 1, text,
        contentParts: { version: 1, parts: fileIds.map(fileId => ({ type: 'image', fileId })) }, updatedAt: Date.now() }, previous?.revision ?? 0);
    });
    this.preparedDraftWrites.set(sessionId, write); void write.catch(() => undefined);
    const existing = this.draftTimers.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);
    this.draftTimers.set(
      sessionId,
      setTimeout(() => {
        void this.flushDraft(sessionId).catch(() => undefined);
      }, 1000),
    );
  }

  /** 立即把草稿写进 IndexedDB 与服务端（"带到…"后马上跳转时用） */
  async flushDraft(sessionId: string): Promise<void> {
    const draft = this.getDraft(sessionId);
    await cache.putDraft({ sessionId, text: draft.text, fileIds: draft.fileIds });
    await this.preparedDraftWrites.get(sessionId);
    await this.syncedLegacyDrafts.sync(sessionId);
    const state = this.syncedLegacyDrafts.state(sessionId);
    if (state?.error !== undefined) throw new Error(state.error);
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
