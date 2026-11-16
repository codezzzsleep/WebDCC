import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SyncConnection } from './connection.js';

class ControlledSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: ControlledSocket[] = [];
  readyState = ControlledSocket.CONNECTING;
  closeCalls = 0;
  sent: unknown[] = [];
  private listeners = new Map<string, EventListener[]>();
  constructor(readonly url: string) { ControlledSocket.instances.push(this); }
  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? []; listeners.push(listener); this.listeners.set(type, listeners);
  }
  send(value: string): void { this.sent.push(JSON.parse(value) as unknown); }
  close(): void { this.closeCalls++; this.readyState = ControlledSocket.CLOSING; }
  emit(type: string, value?: unknown): void {
    const event = type === 'message' ? new MessageEvent(type, { data: JSON.stringify(value) }) : new Event(type);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open(): void { this.readyState = ControlledSocket.OPEN; this.emit('open'); }
  finishClose(): void { this.readyState = ControlledSocket.CLOSED; this.emit('close'); }
}

const connections: SyncConnection[] = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5); ControlledSocket.instances = [];
  vi.stubGlobal('WebSocket', ControlledSocket);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { protocol: 'https:', host: 'test.invalid' } }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
afterEach(() => {
  for (const connection of connections.splice(0)) connection.stop();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function fixture() {
  const onMessage = vi.fn(); const onState = vi.fn(); const onOpen = vi.fn();
  const connection = new SyncConnection({ getSubscriptions: () => [{ sessionId: 's', afterSeq: 5 }], getFeedAfter: () => 10, onMessage, onState, onOpen });
  connections.push(connection); connection.start();
  return { connection, old: ControlledSocket.instances[0]!, onMessage, onState, onOpen };
}

it('focus while connecting replaces and closes the old socket; focus while online preserves the active socket', () => {
  const { old } = fixture(); window.dispatchEvent(new Event('focus'));
  expect(old.closeCalls).toBe(1); expect(ControlledSocket.instances).toHaveLength(2);
  const current = ControlledSocket.instances[1]!; current.open(); window.dispatchEvent(new Event('focus'));
  expect(ControlledSocket.instances).toHaveLength(2); expect(current.closeCalls).toBe(0);
});

it('an obsolete open cannot mark a still-connecting replacement online or replay its outbox', () => {
  const { connection, old, onState, onOpen } = fixture(); connection.reconnectNow();
  old.emit('open');
  expect(onOpen).not.toHaveBeenCalled(); expect(onState).not.toHaveBeenCalledWith('online', 0);
  const current = ControlledSocket.instances[1]!; current.open();
  expect(onOpen).toHaveBeenCalledOnce();
  expect(current.sent).toEqual([{ op: 'hello', clientId: expect.any(String), feedAfter: 10, subscribe: [{ sessionId: 's', afterSeq: 5 }] }]);
});

it('old messages cannot update current projection while the current connection still forwards its original frame', () => {
  const { connection, old, onMessage } = fixture(); connection.reconnectNow(); const current = ControlledSocket.instances[1]!; current.open();
  old.emit('message', { op: 'feed', feedSeq: 9, sessionId: 's', patch: { title: 'obsolete' } });
  expect(onMessage).not.toHaveBeenCalled();
  const frame = { op: 'feed', feedSeq: 11, sessionId: 's', patch: { title: 'current' } };
  current.emit('message', frame); expect(onMessage).toHaveBeenCalledOnce(); expect(onMessage).toHaveBeenCalledWith(frame);
});

it('an old close or error does not replace an online current connection or alter its state', async () => {
  const { connection, old, onState } = fixture(); connection.reconnectNow(); const current = ControlledSocket.instances[1]!; current.open();
  old.finishClose(); old.emit('error'); await vi.advanceTimersByTimeAsync(1000);
  expect(ControlledSocket.instances).toHaveLength(2); expect(current.closeCalls).toBe(0);
  expect(onState).toHaveBeenLastCalledWith('online', 0);
});

it('stop fences already queued open and message callbacks and leaves no reconnect', async () => {
  const { connection, old, onMessage, onOpen, onState } = fixture(); connection.stop();
  old.emit('open'); old.emit('message', { op: 'snapshot', sessionId: 's', items: [], throughSeq: 5 }); old.finishClose();
  await vi.advanceTimersByTimeAsync(10000);
  expect(onMessage).not.toHaveBeenCalled(); expect(onOpen).not.toHaveBeenCalled();
  expect(onState).not.toHaveBeenCalledWith('online', 0); expect(ControlledSocket.instances).toHaveLength(1);
});

it('the current socket close schedules one backoff and preserves client/subscription identity', async () => {
  const { old, onOpen } = fixture(); old.open(); old.close(); old.finishClose();
  await vi.advanceTimersByTimeAsync(499); expect(ControlledSocket.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(ControlledSocket.instances).toHaveLength(2);
  const current = ControlledSocket.instances[1]!; current.open();
  expect(current.sent).toEqual(old.sent); expect(onOpen).toHaveBeenCalledTimes(2);
});

it('obsolete messages cannot disguise the active peer exceeding its heartbeat timeout', async () => {
  const { connection, old } = fixture(); connection.reconnectNow(); const current = ControlledSocket.instances[1]!; current.open();
  await vi.advanceTimersByTimeAsync(30000);
  old.emit('message', { op: 'ping' });
  await vi.advanceTimersByTimeAsync(10000);
  expect(current.closeCalls).toBe(1);
});
