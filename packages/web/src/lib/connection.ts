/** WebSocket 同步客户端：续传、心跳、退避重连、发件箱重放（SPEC 7.3、7.4） */
import type { Command, ServerMessage } from '@webdcc/protocol';

export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface Subscription {
  sessionId: string;
  afterSeq: number;
}

export interface SyncConnectionOptions {
  getSubscriptions: () => Subscription[];
  getFeedAfter: () => number;
  onMessage: (message: ServerMessage) => void;
  onState: (state: ConnectionState, attempt: number) => void;
  /** 连接建立后（hello 之前）调用，用于重放发件箱 */
  onOpen?: () => void;
}

const BACKOFF = [0.5, 1, 2, 4, 8, 15];
const DEAD_AFTER_MS = 35_000;

export class SyncConnection {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private lastMessageAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private deadTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly subscriptions = new Map<string, number>();

  constructor(private readonly options: SyncConnectionOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
    window.addEventListener('online', () => this.reconnectNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.reconnectNow();
    });
    window.addEventListener('focus', () => this.reconnectNow());
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.deadTimer !== null) clearInterval(this.deadTimer);
    this.socket?.close();
    this.socket = null;
  }

  get state(): ConnectionState {
    if (this.socket?.readyState === WebSocket.OPEN) return 'online';
    return this.attempt === 0 ? 'connecting' : 'reconnecting';
  }

  private connect(): void {
    if (this.stopped) return;
    this.options.onState(this.state, this.attempt);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.options.onState('online', 0);
      this.subscriptions.clear();
      for (const item of this.options.getSubscriptions()) this.subscriptions.set(item.sessionId, item.afterSeq);
      this.sendRaw({
        op: 'hello',
        clientId: clientId(),
        feedAfter: this.options.getFeedAfter(),
        subscribe: [...this.subscriptions].map(([sessionId, afterSeq]) => ({ sessionId, afterSeq })),
      });
      this.options.onOpen?.();
      if (this.deadTimer !== null) clearInterval(this.deadTimer);
      this.deadTimer = setInterval(() => {
        if (Date.now() - this.lastMessageAt > DEAD_AFTER_MS) {
          socket.close();
        }
      }, 5_000);
    });

    socket.addEventListener('message', (event) => {
      this.lastMessageAt = Date.now();
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.op === 'ping') {
        this.sendRaw({ op: 'pong' });
        return;
      }
      this.options.onMessage(message);
    });

    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      if (this.deadTimer !== null) clearInterval(this.deadTimer);
      if (!this.stopped) this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      socket.close();
    });
  }

  private scheduleReconnect(): void {
    const base = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)] ?? 15;
    const jitter = base * (0.8 + Math.random() * 0.4);
    this.attempt += 1;
    this.options.onState('reconnecting', this.attempt);
    this.reconnectTimer = setTimeout(() => this.connect(), jitter * 1000);
  }

  reconnectNow(): void {
    if (this.stopped) return;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.attempt = 0;
    this.connect();
  }

  subscribe(sessionId: string, afterSeq: number): void {
    if (this.subscriptions.get(sessionId) === afterSeq) return;
    this.subscriptions.set(sessionId, afterSeq);
    this.sendRaw({ op: 'subscribe', subscribe: [{ sessionId, afterSeq }] });
  }

  unsubscribe(sessionId: string): void {
    this.subscriptions.delete(sessionId);
    this.sendRaw({ op: 'unsubscribe', sessionIds: [sessionId] });
  }

  sendCommand(command: Command): void {
    this.sendRaw({ op: 'command', command });
  }

  private sendRaw(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}

export function clientId(): string {
  const key = 'wdcc-client-id';
  const existing = sessionStorage.getItem(key);
  if (existing !== null) return existing;
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  sessionStorage.setItem(key, id);
  return id;
}
