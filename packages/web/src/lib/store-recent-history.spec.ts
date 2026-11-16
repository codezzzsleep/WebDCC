import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoredEvent } from '@webdcc/protocol';
import type { SyncConnectionOptions } from './connection.js';

const mocks = vi.hoisted(() => ({ options: [] as SyncConnectionOptions[], events: vi.fn(), detail: vi.fn(), recent: vi.fn(), meta: vi.fn(), put: vi.fn() }));
vi.mock('./connection.js', () => ({ SyncConnection: class {
  constructor(options: SyncConnectionOptions) { mocks.options.push(options); }
  subscribe() {} unsubscribe() {}
} }));
vi.mock('./api.js', () => ({ api: { queue: vi.fn().mockResolvedValue({ inputs: [], revision: 0 }), session: mocks.detail, events: mocks.events } }));
vi.mock('./db.js', () => ({ cache: { getEvents: mocks.recent, getMeta: mocks.meta, putEvents: mocks.put,
  putSession: vi.fn().mockResolvedValue(undefined) } }));
import { AppStore } from './store.js';
const event = (seq: number): StoredEvent => ({ sessionId: 's', seq, turnId: null, itemKey: `item-${seq}`, kind: 'unknown',
  data: { nativeType: 'controlled-unrecognized-frame', detail: 'original' }, native: { itemId: `native-${seq}` }, at: new Date(0).toISOString() });
beforeEach(() => {
  vi.useFakeTimers();
  mocks.events.mockReset(); mocks.detail.mockReset().mockResolvedValue({ id: 's', lastSeq: 7 });
  mocks.recent.mockReset().mockResolvedValue([]); mocks.meta.mockReset().mockResolvedValue(undefined); mocks.put.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
async function evidence(name: string, store: AppStore, failure?: string): Promise<void> {
  const path = process.env['WDCC_RECENT_HISTORY_EVIDENCE_DIR'];
  if (path !== undefined) await writeFile(join(path, `${name}.json`), JSON.stringify({ events: store.getEvents('s'),
    cacheWrites: mocks.put.mock.calls, subscriptions: mocks.options.at(-1)!.getSubscriptions(), failure }, null, 2));
}

it.each([
  { name: 'foreign-session', events: [6, 7].map(seq => ({ ...event(seq), sessionId: 'other' })) },
  { name: 'zero', events: Array.from({ length: 8 }, (_, seq) => event(seq)) },
  { name: 'negative', events: Array.from({ length: 9 }, (_, seq) => event(seq - 1)) },
  { name: 'duplicate', events: [6, 6, 7].map(event) },
  { name: 'descending', events: [7, 6].map(event) },
  { name: 'gap', events: [5, 7].map(event) },
  { name: 'wrong-end', events: [5, 6].map(event) },
  { name: 'future-end', events: [7, 8].map(event) },
  { name: 'fraction', events: [5.5, 6.5, 7].map(event) },
  { name: 'null-events', events: null },
  { name: 'null-record', events: [null, event(7)] },
  { name: 'object-events', events: { seq: 7 } },
])('recent $name page cannot publish, commit or certify the requested session', async item => {
  const store = new AppStore(); mocks.events.mockResolvedValue({ events: item.events, hasMore: true });
  let failure: string | undefined;
  try { await store.ensureSession('s'); } catch (error) { failure = String(error); }
  await evidence(item.name, store, failure);
  expect(failure).toBeUndefined(); expect(store.getEvents('s')).toEqual([]); expect(mocks.put).not.toHaveBeenCalled();
  expect(mocks.options.at(-1)!.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 0 }]);
});

it('a page larger than the requested recent limit cannot certify or populate the session', async () => {
  const store = new AppStore(); mocks.detail.mockResolvedValue({ id: 's', lastSeq: 201 });
  mocks.events.mockResolvedValue({ events: Array.from({ length: 201 }, (_, i) => event(i + 1)), hasMore: false });
  await store.ensureSession('s'); await evidence('over-limit', store);
  expect(store.getEvents('s')).toEqual([]); expect(mocks.put).not.toHaveBeenCalled();
  expect(mocks.options.at(-1)!.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 0 }]);
});

it('an invalid recent page preserves committed cache coverage and valid live events received during the HTTP wait', async () => {
  const store = new AppStore(); mocks.recent.mockResolvedValue([event(1), event(2)]);
  mocks.meta.mockResolvedValue({ from: 1, to: 2 });
  mocks.events.mockImplementation(async () => {
    store.applyEvent(event(7), true);
    return { events: [6, 7].map(seq => ({ ...event(seq), sessionId: 'other', data: { text: 'foreign body' } })), hasMore: true };
  });
  await store.ensureSession('s'); await evidence('live-and-cache', store);
  expect(store.getEvents('s')).toEqual([event(1), event(2), event(7)]);
  expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.options.at(-1)!.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 2 }]);
});

it('a second open recovers the same valid unknown and internal records after an invalid first response', async () => {
  const store = new AppStore(); const original = [event(6), { ...event(7), kind: 'internal' as const }];
  mocks.events.mockResolvedValueOnce({ events: original.map(value => ({ ...value, sessionId: 'other' })), hasMore: true })
    .mockResolvedValueOnce({ events: original, hasMore: true });
  await store.ensureSession('s'); expect(store.getEvents('s')).toEqual([]);
  await store.ensureSession('s'); expect(store.getEvents('s')).toEqual(original);
  expect(mocks.put).toHaveBeenCalledTimes(1); expect(mocks.put).toHaveBeenCalledWith(original, { sessionId: 's', from: 6, to: 7 });
  expect(mocks.options.at(-1)!.getSubscriptions()).toEqual([{ sessionId: 's', afterSeq: 7 }]);
});
