import { afterEach, expect, it, vi } from 'vitest';
import type { StoredEvent } from '@webdcc/protocol';
import type { SyncConnectionOptions } from './connection.js';

const mocks = vi.hoisted(() => ({ options: [] as SyncConnectionOptions[], events: vi.fn(), subscribe: vi.fn() }));
vi.mock('./connection.js', () => ({ SyncConnection: class {
  constructor(options: SyncConnectionOptions) { mocks.options.push(options); }
  subscribe = mocks.subscribe;
} }));
vi.mock('./api.js', () => ({ api: { queue: vi.fn().mockResolvedValue({ inputs: [], revision: 0 }), session: vi.fn().mockResolvedValue({ id: 's', lastSeq: 7 }), events: mocks.events } }));
vi.mock('./db.js', () => ({ cache: { getEvents: vi.fn().mockResolvedValue([]), putSession: vi.fn().mockResolvedValue(undefined), putEvents: vi.fn().mockResolvedValue(undefined), setMeta: vi.fn().mockResolvedValue(undefined) } }));
import { AppStore } from './store.js';
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
