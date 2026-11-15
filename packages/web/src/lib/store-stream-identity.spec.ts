import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerMessage, StoredEvent } from '@webdcc/protocol';
import type { SyncConnectionOptions } from './connection.js';

const mocks = vi.hoisted(() => ({ options: [] as SyncConnectionOptions[] }));
vi.mock('./connection.js', () => ({ SyncConnection: class {
  constructor(options: SyncConnectionOptions) { mocks.options.push(options); }
  subscribe = vi.fn(); unsubscribe = vi.fn();
} }));
vi.mock('./api.js', () => ({ api: { queue: vi.fn().mockResolvedValue({ inputs: [], revision: 0 }) } }));
vi.mock('./db.js', () => ({ cache: { putEvents: vi.fn().mockResolvedValue(undefined), setMeta: vi.fn().mockResolvedValue(undefined) } }));
import { AppStore } from './store.js';

beforeEach(() => { vi.useFakeTimers(); mocks.options.length = 0; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function fixture() {
  const store = new AppStore(); const connection = mocks.options.at(-1)!;
  return { store, feed: (message: ServerMessage) => connection.onMessage(message) };
}
const hot = (turnId: string, text: string) => ({ itemKey: 'shared', turnId, kind: 'reasoning' as const, data: { text } });
const completed = (turnId: string, seq: number): StoredEvent => ({ sessionId: 's', turnId, seq, itemKey: 'shared',
  kind: 'reasoning', data: { text: 'Final' }, at: new Date(seq).toISOString() });

it('snapshot and deltas preserve equal item keys across independent turns', () => {
  const { store, feed } = fixture();
  feed({ op: 'snapshot', sessionId: 's', items: [hot('a', 'A'), hot('b', 'B')] });
  expect(store.getHot('s')).toHaveLength(2);
  const delta = { op: 'delta' as const, sessionId: 's', turnId: 'a', itemKey: 'shared', field: 'text' as const, append: ' only' };
  feed(delta);
  expect(store.getHot('s').find(item => item.turnId === 'a')?.data).toEqual({ text: 'A only' });
  expect(store.getHot('s').find(item => item.turnId === 'b')?.data).toEqual({ text: 'B' });
});

it('started updates create a separate hot identity instead of overwriting an equal key in an earlier turn', () => {
  const { store, feed } = fixture();
  feed({ op: 'snapshot', sessionId: 's', items: [hot('a', 'A')] });
  feed({ op: 'update', sessionId: 's', turnId: 'b', itemKey: 'shared', data: { started: true, kind: 'reasoning', data: { text: 'B' } } });
  feed({ op: 'update', sessionId: 's', turnId: 'a', itemKey: 'shared', data: { text: 'A revised' } });
  expect(store.getHot('s')).toHaveLength(2);
  expect(store.getHot('s').find(item => item.turnId === 'a')?.data).toEqual({ text: 'A revised' });
  expect(store.getHot('s').find(item => item.turnId === 'b')?.data).toEqual({ text: 'B' });
});

it.each([false, true])('old complete (history=%s) removes only the old hot identity', historical => {
  const { store, feed } = fixture();
  feed({ op: 'snapshot', sessionId: 's', items: [hot('a', 'A'), hot('b', 'B')] });
  store.applyEvent(completed('a', 1), historical);
  expect(store.getHot('s')).toEqual([hot('b', 'B')]);
  expect(store.getEvents('s')).toHaveLength(1);
});

it('unscoped and unknown-turn updates cannot mutate scoped current hot data', () => {
  const { store, feed } = fixture();
  feed({ op: 'snapshot', sessionId: 's', items: [hot('b', 'B')] });
  feed({ op: 'update', sessionId: 's', itemKey: 'shared', data: { text: 'unscoped stale' } });
  feed({ op: 'update', sessionId: 's', turnId: 'foreign', itemKey: 'shared', data: { text: 'foreign stale' } });
  feed({ op: 'delta', sessionId: 's', itemKey: 'shared', field: 'text', append: 'unscoped' });
  const foreign = { op: 'delta' as const, sessionId: 's', turnId: 'foreign', itemKey: 'shared', field: 'text' as const, append: 'foreign' };
  feed(foreign);
  expect(store.getHot('s')).toEqual([hot('b', 'B')]);
});

it('persisted terminal turns can receive final historical data without reopening live hot items', () => {
  const { store, feed } = fixture();
  const terminal: StoredEvent = { sessionId: 's', seq: 1, turnId: 'a', itemKey: 'end-a', kind: 'turn.completed',
    data: { status: 'completed', durationMs: 1, answerItemKeys: [] }, at: new Date(0).toISOString() };
  store.applyEvent(terminal);
  feed({ op: 'update', sessionId: 's', turnId: 'a', itemKey: 'shared', data: { started: true, kind: 'reasoning', data: { text: 'stale' } } });
  expect(store.getHot('s')).toEqual([]);
  store.applyEvent(completed('a', 2), true);
  expect(store.getTurns('s')[0]?.state).toBe('completed');
  expect(store.getTurns('s')[0]?.hot).toEqual([]);
  expect(store.getTurns('s')[0]?.steps.some(step => step.kind === 'reasoning')).toBe(true);
});
