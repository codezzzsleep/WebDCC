import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StoredEvent } from '@webdcc/protocol';
import type { SyncConnectionOptions } from './connection.js';

const mocks = vi.hoisted(() => ({ options: [] as SyncConnectionOptions[], events: vi.fn(), detail: vi.fn().mockResolvedValue({ id: 's', lastSeq: 7 }), subscribe: vi.fn(), unsubscribe: vi.fn(), getEvents: vi.fn().mockResolvedValue([]), getMeta: vi.fn().mockResolvedValue(undefined), putEvents: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./connection.js', () => ({ SyncConnection: class {
  constructor(options: SyncConnectionOptions) { mocks.options.push(options); }
  subscribe = mocks.subscribe;
  unsubscribe = mocks.unsubscribe;
} }));
vi.mock('./api.js', () => ({ api: { queue: vi.fn().mockResolvedValue({ inputs: [], revision: 0 }), session: mocks.detail, events: mocks.events } }));
vi.mock('./db.js', () => ({ cache: { getEvents: mocks.getEvents, getMeta: mocks.getMeta, putSession: vi.fn().mockResolvedValue(undefined), putEvents: mocks.putEvents, setMeta: vi.fn().mockResolvedValue(undefined) } }));
import { AppStore } from './store.js';
beforeEach(() => {
  mocks.events.mockReset(); mocks.detail.mockReset().mockResolvedValue({ id: 's', lastSeq: 7 });
  mocks.getEvents.mockReset().mockResolvedValue([]); mocks.getMeta.mockReset().mockResolvedValue(undefined);
  mocks.putEvents.mockReset().mockResolvedValue(undefined); mocks.subscribe.mockClear(); mocks.unsubscribe.mockClear();
});
afterEach(() => vi.useRealTimers());
const event = (seq: number): StoredEvent => ({ sessionId: 's', seq, turnId: 't', itemKey: `item-${seq}`, kind: 'assistant.message', data: { text: 'text' }, at: new Date(0).toISOString() });

it('NP-05 does not advance past failed history and retries on a second open; later out-of-order events retain gaps', async () => {
  vi.useFakeTimers();
  const store = new AppStore();
  mocks.events.mockRejectedValueOnce(new Error('history failed')).mockResolvedValueOnce({ events: [event(6), event(7)], hasMore: true });
  await store.ensureSession('s');
  expect(mocks.subscribe).toHaveBeenLastCalledWith('s', 0);
  expect(mocks.options.at(-1)?.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 0 }]);
  await store.ensureSession('s');
  expect(mocks.events).toHaveBeenCalledTimes(2);
  expect(mocks.subscribe).toHaveBeenLastCalledWith('s', 7);
  store.applyEvent(event(9));
  expect(mocks.options.at(-1)?.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 7 }]);
  store.applyEvent(event(8));
  expect(mocks.options.at(-1)?.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 9 }]);
});

it('NP-05 an empty authoritative snapshot clears previously live items', () => {
  const store = new AppStore();
  const options = mocks.options.at(-1);
  options?.onMessage({ op: 'snapshot', sessionId: 's', items: [{ itemKey: 'live', kind: 'reasoning', data: { text: 'old' } }] });
  expect(store.getHot('s')).toHaveLength(1);
  options?.onMessage({ op: 'snapshot', sessionId: 's', items: [] });
  expect(store.getHot('s')).toEqual([]);
});

it('NP-05 a partial cached history reads the newest bounded page before subscribing, and a cache failure cannot advance its cursor', async () => {
  const store = new AppStore();
  mocks.getEvents.mockResolvedValueOnce([event(1), event(2)]);
  mocks.detail.mockResolvedValueOnce({ id: 's', lastSeq: 10000 });
  const recent = Array.from({ length: 200 }, (_, index) => event(9801 + index));
  mocks.events.mockResolvedValueOnce({ events: recent, hasMore: true });
  await store.ensureSession('s');
  expect(mocks.events).toHaveBeenCalledWith('s', { before: 10001, limit: 200 });
  expect(mocks.putEvents).toHaveBeenCalledWith(recent, { sessionId: 's', from: 9801, to: 10000 });
  expect(mocks.subscribe).toHaveBeenLastCalledWith('s', 10000);
  const failed = new AppStore();
  mocks.detail.mockResolvedValueOnce({ id: 's', lastSeq: 10000 });
  mocks.events.mockResolvedValueOnce({ events: recent, hasMore: true }); mocks.putEvents.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
  await failed.ensureSession('s');
  expect(mocks.subscribe).toHaveBeenLastCalledWith('s', 0);
});

it('NP-45 opening the list never subscribes cached or newly created background histories; switching removes old subscriptions', async () => {
  const store = new AppStore(); const connection = mocks.options.at(-1)!;
  for (let i = 0; i < 100; i++) connection.onMessage({ op: 'feed', feedSeq: i + 1, sessionId: `background-${i}`, patch: { created: true, agent: 'codex', workspaceId: 'workspace', status: 'running' } });
  expect(connection.getSubscriptions()).toEqual([]); expect(mocks.subscribe).not.toHaveBeenCalled();
  connection.onMessage({ op: 'feed', feedSeq: 101, sessionId: 'background-0', patch: { status: 'idle' } });
  expect(store.unreadTotal()).toBe(1);
  mocks.events.mockResolvedValueOnce({ events: [event(6), event(7)], hasMore: true });
  await store.ensureSession('s');
  expect(connection.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 7 }]);
  store.setCurrentSession('another');
  expect(mocks.unsubscribe).toHaveBeenCalledWith('s'); expect(connection.getSubscriptions()).toEqual([]);
});

it('NP-05 a delayed session detail cannot overwrite a newer live permission update', async () => {
  const store = new AppStore(); const connection = mocks.options.at(-1)!;
  mocks.detail.mockImplementationOnce(async () => {
    connection.onMessage({ op: 'feed', feedSeq: 1, sessionId: 's', patch: { permissions: { requested: 'workspace', effective: 'workspace', phase: 'observed', revision: 9 } } });
    return { id: 's', lastSeq: 7, permissions: { requested: null, effective: null, phase: 'unknown', revision: 1 } };
  });
  mocks.events.mockResolvedValueOnce({ events: [event(6), event(7)], hasMore: true });
  await store.ensureSession('s');
  expect(store.getSession('s')?.permissions?.revision).toBe(9);
});

it('NP-05 a transactionally cached recent window resumes at its verified end without replaying all older events', async () => {
  const store = new AppStore();
  mocks.getEvents.mockResolvedValueOnce(Array.from({ length: 200 }, (_, index) => event(9801 + index)));
  mocks.getMeta.mockResolvedValueOnce({ from: 9801, to: 10000 }); mocks.detail.mockResolvedValueOnce({ id: 's', lastSeq: 10000 });
  await store.ensureSession('s');
  expect(mocks.events).not.toHaveBeenCalled(); expect(mocks.subscribe).toHaveBeenLastCalledWith('s', 10000);
});
