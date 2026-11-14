import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type {
  ClientMessage,
  Command,
  DeltaMessage,
  EventMessage,
  FeedMessage,
  FeedPatch,
  ServerMessage,
  SnapshotMessage,
  StoredEvent,
  UpdateMessage,
} from '@webdcc/protocol';
import { isAuthenticated, requestAuthority } from './auth.js';
import { isClientMessage } from '@webdcc/protocol';
import type { CommandDispatcher, DispatchResult } from './dispatcher.js';
import type { SessionManager } from './manager.js';
import type { Store } from './store.js';

interface PendingDelta {
  sessionId: string;
  itemKey: string;
  field: 'text' | 'output';
  chunks: string[];
  turnId?: string | null;
}

interface ClientState {
  id: string;
  socket: WebSocket;
  subs: Map<string, { afterSeq: number }>;
  pendingDeltas: Map<string, PendingDelta>;
  /** WebSocket message handlers are concurrent; serialize commands per client so a
   * model/access change is applied before the following send command. */
  commandQueue: Promise<void>;
  lastPong: number;
  authorized: boolean;
}

const PING_INTERVAL_MS = 15_000;
const DEAD_AFTER_MS = 35_000;
const DELTA_FLUSH_MS = 50;
const BACKFILL_LIMIT = 500;

export class LiveHub {
  private readonly clients = new Set<ClientState>();
  private pingTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly manager: SessionManager,
    private readonly dispatcher: CommandDispatcher,
    private readonly token: string,
    private readonly fallbackAuthority = '127.0.0.1:0',
  ) {}

  attach(app: FastifyInstance): void {
    app.get('/api/ws', { websocket: true }, (socket, request) => {
      const authorized = isAuthenticated(this.token, request.headers.cookie, requestAuthority(request.headers, this.fallbackAuthority));
      const client: ClientState = {
        id: '',
        socket,
        subs: new Map(),
        pendingDeltas: new Map(),
        commandQueue: Promise.resolve(),
        lastPong: Date.now(),
        authorized,
      };
      this.clients.add(client);
      if (!authorized) {
        socket.close(1008, 'unauthorized');
        this.clients.delete(client);
        return;
      }
      socket.on('message', (raw: Buffer) => {
        void this.onMessage(client, raw.toString()).catch(() => socket.close(1011, 'message processing failed'));
      });
      socket.on('close', () => {
        this.clients.delete(client);
      });
      socket.on('error', () => {
        this.clients.delete(client);
      });
      client.lastPong = Date.now();
    });

    this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    this.pingTimer.unref?.();
    this.flushTimer = setInterval(() => this.flushDeltas(), DELTA_FLUSH_MS);
    this.flushTimer.unref?.();
    app.addHook('onClose', async () => {
      if (this.pingTimer !== null) clearInterval(this.pingTimer);
      if (this.flushTimer !== null) clearInterval(this.flushTimer);
      for (const client of this.clients) client.socket.close(1001, 'server closing');
      this.clients.clear();
    });
  }

  private send(client: ClientState, message: ServerMessage): void {
    if (client.socket.readyState !== 1) return;
    client.socket.send(JSON.stringify(message));
  }

  private async onMessage(client: ClientState, raw: string): Promise<void> {
    let message: ClientMessage;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isClientMessage(value)) { client.socket.close(1008, 'invalid message'); return; }
      message = value;
    } catch {
      return;
    }
    switch (message.op) {
      case 'hello': {
        client.id = message.clientId;
        await this.replayFeed(client, message.feedAfter);
        for (const item of message.subscribe) await this.subscribe(client, item.sessionId, item.afterSeq);
        break;
      }
      case 'subscribe': {
        for (const item of message.subscribe) await this.subscribe(client, item.sessionId, item.afterSeq);
        break;
      }
      case 'unsubscribe': {
        for (const sessionId of message.sessionIds) client.subs.delete(sessionId);
        break;
      }
      case 'pong': {
        client.lastPong = Date.now();
        break;
      }
      case 'command': {
        const command = message.command as Command;
        const run = async (): Promise<void> => {
          const result = await this.dispatcher.dispatch(command);
          this.send(client, {
            op: 'ack',
            clientCommandId: command.clientCommandId,
            result: toAckResult(result),
          });
        };
        const queued = client.commandQueue.then(run, run);
        client.commandQueue = queued.catch(() => undefined);
        await queued;
        break;
      }
      default:
        break;
    }
  }

  private toAckResultSafe = (result: DispatchResult): { ok: true; value?: unknown } | { ok: false; error: string; code?: string } =>
    toAckResult(result);

  private async replayFeed(client: ClientState, after: number): Promise<void> {
    let cursor = after;
    for (;;) {
      const batch = this.store.feedSince(cursor, 500);
      if (batch.length === 0) break;
      for (const entry of batch) {
        const message: FeedMessage = { op: 'feed', feedSeq: entry.feedSeq, sessionId: entry.sessionId, patch: entry.patch };
        this.send(client, message);
        cursor = entry.feedSeq;
      }
      if (batch.length < 500) break;
    }
  }

  private async subscribe(client: ClientState, sessionId: string, afterSeq: number): Promise<void> {
    client.subs.set(sessionId, { afterSeq });
    const session = this.store.getSession(sessionId);
    if (session === undefined) return;
    const historicalThrough = afterSeq === 0 ? session.lastSeq : 0;
    let cursor = Math.max(0, Math.min(afterSeq, session.lastSeq));
    for (;;) {
      const events = this.store.listEvents(sessionId, { after: cursor, limit: BACKFILL_LIMIT });
      if (events.length === 0) break;
      for (const event of events) {
        const message: EventMessage = { op: 'event', event, ...(event.seq <= historicalThrough ? { history: true } : {}) };
        this.send(client, message);
        cursor = event.seq;
      }
      if (events.length < BACKFILL_LIMIT) break;
    }
    const items = this.manager.hotItems(sessionId).map((item) => ({
      itemKey: item.itemKey,
      kind: item.kind,
      data: item.data,
      turnId: item.turnId,
    }));
    const snapshot: SnapshotMessage = { op: 'snapshot', sessionId, items };
    this.flushClientDeltas(client, pending => pending.sessionId === sessionId);
    this.send(client, snapshot);
  }

  // ---------- 广播 ----------

  broadcastFeed(sessionId: string, patch: FeedPatch, feedSeq: number): void {
    const message: FeedMessage = { op: 'feed', feedSeq, sessionId, patch };
    for (const client of this.clients) this.send(client, message);
  }

  broadcastEvent(event: StoredEvent): void {
    const message: EventMessage = { op: 'event', event };
    for (const client of this.clients) {
      if (client.subs.has(event.sessionId)) {
        this.flushClientDeltas(client, pending => pending.sessionId === event.sessionId && pending.turnId === event.turnId &&
          (pending.itemKey === event.itemKey || event.kind === 'turn.completed'));
        this.send(client, message);
      }
    }
  }

  broadcastUpdate(sessionId: string, itemKey: string, data: unknown, turnId?: string | null): void {
    const message: UpdateMessage = { op: 'update', sessionId, itemKey, data, ...(turnId === undefined ? {} : { turnId }) };
    for (const client of this.clients) {
      if (client.subs.has(sessionId)) {
        this.flushClientDeltas(client, pending => pending.sessionId === sessionId && pending.itemKey === itemKey &&
          (turnId === undefined || pending.turnId === turnId));
        this.send(client, message);
      }
    }
  }

  /** 流式增量按 itemKey 每 50 ms 合并一次（SPEC 7.2） */
  broadcastDelta(sessionId: string, itemKey: string, field: 'text' | 'output', append: string, turnId?: string | null): void {
    for (const client of this.clients) {
      if (!client.subs.has(sessionId)) continue;
      const key = JSON.stringify([sessionId, turnId ?? null, itemKey, field]);
      const existing = client.pendingDeltas.get(key);
      if (existing === undefined) {
        client.pendingDeltas.set(key, { sessionId, itemKey, field, chunks: [append], ...(turnId === undefined ? {} : { turnId }) });
      } else {
        existing.chunks.push(append);
      }
    }
  }

  private flushDeltas(): void {
    for (const client of this.clients) {
      this.flushClientDeltas(client, () => true);
    }
  }

  private flushClientDeltas(client: ClientState, matches: (pending: PendingDelta) => boolean): void {
    for (const [key, pending] of client.pendingDeltas) {
      if (!matches(pending)) continue;
      const message: DeltaMessage = {
        op: 'delta',
        sessionId: pending.sessionId,
        itemKey: pending.itemKey,
        field: pending.field,
        append: pending.chunks.join(''),
        ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
      };
      this.send(client, message);
      client.pendingDeltas.delete(key);
    }
  }

  private heartbeat(): void {
    const now = Date.now();
    for (const client of this.clients) {
      if (now - client.lastPong > DEAD_AFTER_MS) {
        client.socket.close(1001, 'heartbeat timeout');
        this.clients.delete(client);
        continue;
      }
      this.send(client, { op: 'ping' });
    }
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  /** 供测试用：主动断开所有连接（模拟网络切换） */
  dropAllConnections(): void {
    for (const client of this.clients) {
      client.socket.terminate();
      this.clients.delete(client);
    }
  }
}

function toAckResult(result: DispatchResult): { ok: true; value?: unknown } | { ok: false; error: string; code?: string } {
  return result.ok
    ? { ok: true, ...(result.value === undefined ? {} : { value: result.value }) }
    : { ok: false, error: result.error ?? 'unknown error', ...(result.code === undefined ? {} : { code: result.code }) };
}
