import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StoredEvent } from '@webdcc/protocol';
import type { SyncConnectionOptions } from './connection.js';

const mocks = vi.hoisted(() => ({ options: [] as SyncConnectionOptions[], detail: vi.fn(), events: vi.fn(),
  getEvents: vi.fn(), getMeta: vi.fn(), putEvents: vi.fn(), subscribe: vi.fn() }));
vi.mock('./connection.js', () => ({ SyncConnection: class {
  constructor(options: SyncConnectionOptions) { mocks.options.push(options); }
  subscribe = mocks.subscribe; unsubscribe = vi.fn();
} }));
vi.mock('./api.js', () => ({ api: { queue: vi.fn().mockResolvedValue({ inputs: [], revision: 0 }), session: mocks.detail, events: mocks.events } }));
vi.mock('./db.js', () => ({ cache: { getEvents: mocks.getEvents, getMeta: mocks.getMeta, putEvents: mocks.putEvents,
  putSession: vi.fn().mockResolvedValue(undefined), setMeta: vi.fn().mockResolvedValue(undefined) } }));
import { AppStore } from './store.js';

const event = (seq: number, sessionId = 's'): StoredEvent => ({ sessionId, seq, turnId: 'turn', itemKey: `item-${seq}`, kind: 'assistant.message', data: { text: `text-${seq}` }, at: new Date(0).toISOString() });
beforeEach(() => {
  vi.useFakeTimers(); mocks.options.length = 0;
  mocks.detail.mockReset().mockResolvedValue({ id: 's', lastSeq: 0 });
  mocks.events.mockReset().mockResolvedValue({ events: [], hasMore: false });
  mocks.getEvents.mockReset().mockResolvedValue([]); mocks.getMeta.mockReset().mockResolvedValue(undefined);
  mocks.putEvents.mockReset().mockResolvedValue(undefined); mocks.subscribe.mockClear();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('reconnect afterSeq stays at the committed boundary while a live cache batch is pending', async () => {
  let release!: () => void;
  mocks.putEvents.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const store = new AppStore(); const connection = mocks.options.at(-1)!;
  await store.ensureSession('s');
  store.applyEvent(event(1));
  expect(store.getEvents('s')).toEqual([event(1)]);
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 0 }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.putEvents).toHaveBeenCalledWith([event(1)]);
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 0 }]);
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 1 }]);
});

it('a repeated open cannot promote a page whose IndexedDB transaction failed', async () => {
  mocks.detail.mockResolvedValue({ id: 's', lastSeq: 1 });
  mocks.events.mockResolvedValue({ events: [event(1)], hasMore: false });
  mocks.putEvents.mockRejectedValueOnce(new Error('cache failed')).mockRejectedValueOnce(new Error('cache still failed'));
  const store = new AppStore(); const connection = mocks.options.at(-1)!;
  await store.ensureSession('s');
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 0 }]);
  await store.ensureSession('s');
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 0 }]);
  expect(mocks.putEvents).toHaveBeenCalledTimes(2);
  await store.ensureSession('s');
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 1 }]);
});

it('a persisted later event cannot cover a lower event until its own transaction commits', async () => {
  const store = new AppStore(); const connection = mocks.options.at(-1)!;
  await store.ensureSession('s');
  store.applyEvent(event(2)); await vi.advanceTimersByTimeAsync(100);
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 0 }]);
  store.applyEvent(event(1));
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 0 }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 2 }]);
});

it('failed live writes retain the gap and original batch without polling, then a later event repairs both', async () => {
  mocks.putEvents.mockRejectedValueOnce(new Error('IndexedDB transaction aborted'));
  const store = new AppStore(); const connection = mocks.options.at(-1)!;
  await store.ensureSession('s');
  store.applyEvent(event(1)); await vi.advanceTimersByTimeAsync(5000);
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 0 }]);
  expect(mocks.putEvents).toHaveBeenCalledTimes(1);
  store.applyEvent(event(2)); await vi.advanceTimersByTimeAsync(100);
  expect(mocks.putEvents).toHaveBeenLastCalledWith([event(1), event(2)]);
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 2 }]);
  expect(store.getEvents('s')).toEqual([event(1), event(2)]);
});

it('overlapping transactions finishing out of order preserve the uncommitted lower gap', async () => {
  let release!: () => void;
  mocks.putEvents.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const store = new AppStore(); const connection = mocks.options.at(-1)!;
  await store.ensureSession('s');
  store.applyEvent(event(1)); await vi.advanceTimersByTimeAsync(100);
  store.applyEvent(event(2)); await vi.advanceTimersByTimeAsync(100);
  expect(mocks.putEvents).toHaveBeenCalledTimes(2);
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 0 }]);
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 2 }]);
});

it('multiple sessions advance independently when one cached range has a gap', async () => {
  const store = new AppStore(); const connection = mocks.options.at(-1)!;
  await store.ensureSession('s'); await store.ensureSession('other');
  store.applyEvent(event(2)); store.applyEvent(event(1, 'other'));
  await vi.advanceTimersByTimeAsync(100);
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 0 }, { sessionId: 'other', afterSeq: 1 }]);
  store.applyEvent(event(1)); await vi.advanceTimersByTimeAsync(100);
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 2 }, { sessionId: 'other', afterSeq: 1 }]);
});

it('a committed recent HTTP window never includes a live event still waiting for cache flush', async () => {
  const store = new AppStore(); const connection = mocks.options.at(-1)!;
  mocks.detail.mockResolvedValueOnce({ id: 's', lastSeq: 3 });
  mocks.events.mockImplementationOnce(async () => {
    store.applyEvent(event(4));
    return { events: [event(1), event(2), event(3)], hasMore: false };
  });
  await store.ensureSession('s');
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 3 }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 4 }]);
});
