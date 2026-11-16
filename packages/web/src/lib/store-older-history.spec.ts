import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StoredEvent } from '@webdcc/protocol';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SyncConnectionOptions } from './connection.js';

const mocks = vi.hoisted(() => ({ options: [] as SyncConnectionOptions[], events: vi.fn(), recent: vi.fn(), getEventsBefore: vi.fn(), putEvents: vi.fn() }));
vi.mock('./connection.js', () => ({ SyncConnection: class {
  constructor(options: SyncConnectionOptions) { mocks.options.push(options); }
  subscribe() {} unsubscribe() {}
} }));
vi.mock('./api.js', () => ({ api: { queue: vi.fn().mockResolvedValue({ inputs: [], revision: 0 }), session: vi.fn(async (id: string) => ({ id, lastSeq: 6 })), events: mocks.events } }));
vi.mock('./db.js', () => ({ cache: {
  getEvents: mocks.recent, getMeta: vi.fn().mockResolvedValue({ from: 5, to: 6 }),
  putSession: vi.fn().mockResolvedValue(undefined), getEventsBefore: mocks.getEventsBefore, putEvents: mocks.putEvents,
} }));
import { AppStore } from './store.js';
function event(seq: number): StoredEvent { return { sessionId: 's', seq, turnId: 't', itemKey: `item-${seq}`, kind: 'assistant.message', data: { text: `event ${seq}` }, at: new Date(0).toISOString() }; }
async function setup() { const store = new AppStore(); await store.ensureSession('s'); return store; }
async function evidence(name: string, store: AppStore) {
  const directory = process.env['WDCC_OLDER_HISTORY_EVIDENCE_DIR'];
  if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify({ events: store.getEvents('s'), requests: mocks.events.mock.calls,
    cachedReads: mocks.getEventsBefore.mock.calls, commits: mocks.putEvents.mock.calls }, null, 2));
}
beforeEach(() => {
  mocks.events.mockReset(); mocks.getEventsBefore.mockReset().mockResolvedValue([]); mocks.putEvents.mockReset().mockResolvedValue(undefined);
  mocks.recent.mockReset().mockImplementation(async (id: string) => [event(5), event(6)].map(value => ({ ...value, sessionId: id })));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('older page remains pending and does not advance its next before until its cache commit', async () => {
  const store = await setup(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  mocks.events.mockResolvedValue({ events: [event(3), event(4)], hasMore: true }); mocks.putEvents.mockReturnValue(gate);
  let done = false; const loading = store.loadOlder('s').then(value => { done = true; return value; });
  try {
    await vi.waitFor(() => expect(mocks.putEvents).toHaveBeenCalledTimes(1));
    await evidence('pending', store);
    expect(done).toBe(false); expect(store.getEvents('s').map(e => e.seq)).toEqual([5, 6]);
    expect(store.getOlderHistoryState('s').phase).toBe('loading');
    release(); expect(await loading).toBe(true); expect(store.getEvents('s').map(e => e.seq)).toEqual([3, 4, 5, 6]);
  } finally { release(); await loading; }
});

it('two concurrent scroll loads share a single request and cache transaction', async () => {
  const store = await setup(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  mocks.events.mockImplementation(async () => { await gate; return { events: [event(3), event(4)], hasMore: true }; });
  const first = store.loadOlder('s'); const second = store.loadOlder('s');
  try {
    await vi.waitFor(() => expect(mocks.events.mock.calls.length).toBeGreaterThan(0));
    await evidence('concurrent', store); expect(first).toBe(second); expect(mocks.events).toHaveBeenCalledTimes(1);
    release(); expect(await first).toBe(true); expect(await second).toBe(true); expect(mocks.putEvents).toHaveBeenCalledTimes(1);
  } finally { release(); await Promise.all([first, second]); }
});

it('a failed cache write leaves the original before available for a successful retry', async () => {
  const store = await setup(); mocks.events.mockResolvedValue({ events: [event(3), event(4)], hasMore: true });
  const rejected = Promise.reject(new Error('controlled cache failure'));
  // Observe this fixture rejection independently so the pre-fix semantic
  // failure does not abort unrelated cases; actual browser abort is separate.
  void rejected.catch(() => undefined); mocks.putEvents.mockReturnValueOnce(rejected);
  const result = await store.loadOlder('s'); await evidence('cache-failure', store);
  expect(result).toBe(false); expect(store.getEvents('s').map(e => e.seq)).toEqual([5, 6]);
  expect(store.getOlderHistoryState('s').phase).toBe('error');
  expect(await store.loadOlder('s')).toBe(true); expect(mocks.events.mock.calls.map(call => call[1])).toEqual([{ before: 5, limit: 200 }, { before: 5, limit: 200 }]);
  expect(store.getEvents('s').map(e => e.seq)).toEqual([3, 4, 5, 6]);
  expect(store.getOlderHistoryState('s').phase).toBe('idle');
});

it('committed earlier cache restores history offline instead of requiring another server page', async () => {
  const store = await setup(); mocks.getEventsBefore.mockResolvedValue([event(3), event(4)]); mocks.events.mockRejectedValue(new Error('offline'));
  const result = await store.loadOlder('s'); await evidence('offline-cache', store);
  expect(result).toBe(true); expect(mocks.events).not.toHaveBeenCalled(); expect(mocks.putEvents).not.toHaveBeenCalled();
  expect(store.getEvents('s').map(e => e.seq)).toEqual([3, 4, 5, 6]);
});

it('a detached cached range cannot hide the intervening history gap', async () => {
  const store = await setup(); mocks.getEventsBefore.mockResolvedValue([event(1), event(2)]);
  mocks.events.mockResolvedValue({ events: [event(3), event(4)], hasMore: true });
  expect(await store.loadOlder('s')).toBe(true); expect(mocks.events).toHaveBeenCalledWith('s', { before: 5, limit: 200 });
  expect(store.getEvents('s').map(e => e.seq)).toEqual([3, 4, 5, 6]);
});

it('a page belonging to another session cannot contaminate this history or its pagination', async () => {
  const store = await setup(); mocks.events.mockResolvedValue({ events: [3, 4].map(seq => ({ ...event(seq), sessionId: 'other' })), hasMore: true });
  const result = await store.loadOlder('s'); await evidence('wrong-session', store);
  expect(result).toBe(false); expect(mocks.putEvents).not.toHaveBeenCalled(); expect(store.getEvents('s').map(e => e.seq)).toEqual([5, 6]);
});

it.each([[4, 3], [3, 3, 4], [2, 4], [2, 3], [4, 5], [0, 1, 2, 3, 4], [], [3.5, 4]])(
  'an invalid page %j preserves its missing range and exposes recovery', async (...seqs: number[]) => {
    const store = await setup(); mocks.events.mockResolvedValue({ events: seqs.map(event), hasMore: true });
    expect(await store.loadOlder('s')).toBe(false);
    expect(mocks.putEvents).not.toHaveBeenCalled(); expect(store.getOlderHistoryState('s').phase).toBe('error');
    expect(store.getEvents('s').map(e => e.seq)).toEqual([5, 6]);
  },
);

it('HTTP failure retries the same before rather than silently reporting the end of history', async () => {
  const store = await setup(); mocks.events.mockRejectedValueOnce(new Error('network interrupted'))
    .mockResolvedValueOnce({ events: [event(3), event(4)], hasMore: true });
  expect(await store.loadOlder('s')).toBe(false); expect(store.getOlderHistoryState('s').phase).toBe('error');
  expect(await store.loadOlder('s')).toBe(true);
  expect(mocks.events.mock.calls.map(call => call[1])).toEqual([{ before: 5, limit: 200 }, { before: 5, limit: 200 }]);
});

it('a failed cached read falls back to a committed HTTP page', async () => {
  const store = await setup(); mocks.getEventsBefore.mockRejectedValueOnce(new Error('aborted read'));
  mocks.events.mockResolvedValueOnce({ events: [event(3), event(4)], hasMore: true });
  expect(await store.loadOlder('s')).toBe(true); expect(mocks.putEvents).toHaveBeenCalledTimes(1);
  expect(store.getEvents('s').map(e => e.seq)).toEqual([3, 4, 5, 6]);
});

it('a cached suffix stops at the gap and the next page fills that exact gap', async () => {
  const store = await setup(); mocks.getEventsBefore.mockResolvedValueOnce([event(1), event(2), event(4)]);
  expect(await store.loadOlder('s')).toBe(true); expect(mocks.events).not.toHaveBeenCalled();
  expect(store.getEvents('s').map(e => e.seq)).toEqual([4, 5, 6]);
  mocks.events.mockResolvedValueOnce({ events: [event(1), event(2), event(3)], hasMore: false });
  expect(await store.loadOlder('s')).toBe(true); expect(mocks.events).toHaveBeenCalledWith('s', { before: 4, limit: 200 });
  expect(await store.loadOlder('s')).toBe(false); expect(store.getOlderHistoryState('s').phase).toBe('end');
  expect(mocks.events).toHaveBeenCalledTimes(1);
});

it('different sessions paginate independently while a pending page preserves live history and unread state', async () => {
  const store = await setup(); await store.ensureSession('other');
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  mocks.events.mockImplementation(async (id: string) => {
    if (id === 's') await gate;
    return { events: [event(3), event(4)].map(value => ({ ...value, sessionId: id, kind: 'turn.completed' as const, data: { status: 'completed' } })), hasMore: true };
  });
  const originalCursor = mocks.options.at(-1)!.getSubscriptions();
  const pending = store.loadOlder('s');
  try {
    expect(await store.loadOlder('other')).toBe(true);
    store.applyEvent(event(7), true);
    release(); expect(await pending).toBe(true);
    expect(store.getEvents('s').map(e => e.seq)).toEqual([3, 4, 5, 6, 7]);
    expect(store.getEvents('other').map(e => e.seq)).toEqual([3, 4, 5, 6]);
    expect(store.unreadTotal()).toBe(0);
    // The older page does not certify the pending live event's cache write.
    expect(mocks.options.at(-1)!.getSubscriptions()).toEqual(originalCursor);
  } finally { release(); await pending; }
});
