import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StoredEvent } from '@webdcc/protocol';
import type { SyncConnectionOptions } from './connection.js';

const mocks = vi.hoisted(() => ({ options: [] as SyncConnectionOptions[], events: vi.fn(), detail: vi.fn(), interaction: vi.fn(), cached: vi.fn(), putEvents: vi.fn(), putOutbox: vi.fn(), deleteOutbox: vi.fn(), getOutbox: vi.fn(), send: vi.fn(), subscribe: vi.fn() }));
vi.mock('./connection.js', () => ({ SyncConnection: class {
  constructor(options: SyncConnectionOptions) { mocks.options.push(options); }
  subscribe = mocks.subscribe;
  sendCommand = mocks.send;
} }));
vi.mock('./api.js', () => ({ api: { queue: vi.fn().mockResolvedValue({ inputs: [], revision: 0 }), session: mocks.detail, events: mocks.events, interaction: mocks.interaction } }));
vi.mock('./db.js', () => ({ cache: { getEvents: mocks.cached, getMeta: vi.fn().mockResolvedValue(undefined), putSession: vi.fn().mockResolvedValue(undefined), putEvents: mocks.putEvents, setMeta: vi.fn().mockResolvedValue(undefined), putOutbox: mocks.putOutbox, deleteOutbox: mocks.deleteOutbox, getOutbox: mocks.getOutbox } }));
import { AppStore } from './store.js';

const question = (seq = 1, status?: 'answered' | 'skipped'): StoredEvent => ({ sessionId: 's', seq, turnId: null, itemKey: status === undefined ? 'question-q' : 'resolved-q', kind: 'question', data: { questionId: 'q', prompt: 'Question', ...(status === undefined ? {} : { status }) }, at: new Date(0).toISOString() });
const event = (seq: number): StoredEvent => ({ sessionId: 's', seq, turnId: 't', itemKey: `item-${seq}`, kind: 'assistant.message', data: { text: 'text' }, at: new Date(0).toISOString() });
const approval: StoredEvent = { sessionId: 's', seq: 2, turnId: null, itemKey: 'approval-a', kind: 'approval.request', data: { approvalId: 'a', title: 'Approval', detail: '', options: [] }, at: new Date(0).toISOString() };
const connection = () => mocks.options.at(-1)!;
const snapshot = (throughSeq: number) => connection().onMessage({ op: 'snapshot', sessionId: 's', throughSeq, items: [] });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.options.length = 0;
  mocks.cached.mockResolvedValue([]); mocks.detail.mockResolvedValue({ id: 's', lastSeq: 1 });
  mocks.events.mockResolvedValue({ events: [question()], hasMore: false });
  mocks.interaction.mockRejectedValue(new Error('lookup unavailable'));
  mocks.putEvents.mockResolvedValue(undefined); mocks.putOutbox.mockResolvedValue(undefined); mocks.deleteOutbox.mockResolvedValue(undefined); mocks.getOutbox.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

async function ready(): Promise<AppStore> {
  const store = new AppStore(); connection().onState('online', 0); await store.ensureSession('s'); snapshot(1); return store;
}

it('cached questions and approvals cannot dispatch before history and the WS coverage boundary complete', async () => {
  const store = new AppStore(); connection().onState('online', 0);
  mocks.cached.mockResolvedValue([question(), approval]); mocks.detail.mockResolvedValue({ id: 's', lastSeq: 3 });
  let release!: (value: unknown) => void; let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  mocks.events.mockImplementation(() => { begin(); return new Promise(resolve => { release = resolve; }); });
  const opening = store.ensureSession('s'); await started;
  store.answer('s', 'q', { custom: 'stale answer' }); store.approve('s', 'a', 'allow'); await flush();
  expect(mocks.putOutbox).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  release({ events: [question(), approval, question(3, 'answered')], hasMore: false }); await opening;
  expect(store.isSessionSynced('s')).toBe(false); store.approve('s', 'a', 'allow'); expect(mocks.putOutbox).not.toHaveBeenCalled();
  snapshot(3); expect(store.isSessionSynced('s')).toBe(true);
  store.answer('s', 'q', { custom: 'already ended' }); expect(mocks.putOutbox).not.toHaveBeenCalled();
  store.approve('s', 'a', 'allow'); await flush(); expect(mocks.send).toHaveBeenCalledOnce();
});

it('concurrent opens share history hydration and a snapshot cannot cover missing event sequences', async () => {
  const store = new AppStore(); connection().onState('online', 0);
  const first = store.ensureSession('s'); const second = store.ensureSession('s'); expect(first).toBe(second); await first;
  expect(mocks.events).toHaveBeenCalledOnce(); snapshot(3); expect(store.isSessionSynced('s')).toBe(false);
  connection().onMessage({ op: 'event', event: event(3) }); expect(store.isSessionSynced('s')).toBe(false);
  connection().onMessage({ op: 'event', event: event(2) }); expect(store.isSessionSynced('s')).toBe(true);
});

it('a legacy snapshot without an end marker cannot enable cached interactions', async () => {
  const store = new AppStore(); connection().onState('online', 0); await store.ensureSession('s');
  connection().onMessage({ op: 'snapshot', sessionId: 's', items: [] });
  store.answer('s', 'q', { custom: 'not verified' }); expect(mocks.putOutbox).not.toHaveBeenCalled();
});

it('a smaller WS end cannot certify a higher cached cursor when HTTP detail is unavailable', async () => {
  const store = new AppStore(); connection().onState('online', 0);
  for (let seq = 1; seq < 10; seq++) store.applyEvent(event(seq)); store.applyEvent(question(10));
  mocks.detail.mockRejectedValueOnce(new Error('detail unavailable')); await store.ensureSession('s'); snapshot(5);
  expect(store.getSessionSync('s')).toMatchObject({ phase: 'replaying', throughSeq: 10, cursor: 10 });
  store.answer('s', 'q', { custom: 'higher stale cache' }); expect(mocks.putOutbox).not.toHaveBeenCalled();
});

it('an answer admitted before disconnect waits for current native state, then discards an ended interaction', async () => {
  const store = await ready(); let persist!: () => void;
  mocks.putOutbox.mockImplementationOnce(() => new Promise<void>(resolve => { persist = resolve; }));
  store.answer('s', 'q', { custom: 'exact answer' });
  connection().onState('reconnecting', 1); persist(); await flush(); expect(mocks.send).not.toHaveBeenCalled();
  connection().onState('online', 0); connection().onOpen?.(); expect(mocks.send).not.toHaveBeenCalled();
  connection().onMessage({ op: 'event', event: question(2, 'answered') }); snapshot(2); await flush();
  expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.deleteOutbox).toHaveBeenCalledOnce();
});

it('an unanswered durable interaction replays its same command ID once after the new sync boundary', async () => {
  const store = await ready(); store.answer('s', 'q', { custom: 'exact answer' }); await flush();
  expect(mocks.send).toHaveBeenCalledOnce(); const original = mocks.send.mock.calls[0]![0];
  connection().onState('reconnecting', 1); connection().onState('online', 0); connection().onOpen?.();
  expect(mocks.send).toHaveBeenCalledOnce(); snapshot(1); snapshot(1); await flush();
  expect(mocks.send).toHaveBeenCalledTimes(2); expect(mocks.send.mock.calls[1]![0]).toEqual(original);
});

async function gapped(): Promise<AppStore> {
  const store = new AppStore(); connection().onState('online', 0);
  mocks.cached.mockResolvedValue([question()]); mocks.detail.mockResolvedValue({ id: 's', lastSeq: 10 });
  mocks.events.mockResolvedValue({ events: [event(9), event(10)], hasMore: true });
  await store.ensureSession('s'); snapshot(10); return store;
}

it('a cached request across a history gap needs a real per-ID lookup; missing state stays unknown and can be retried', async () => {
  mocks.interaction.mockResolvedValue({ event: null, throughSeq: 10 }); const store = await gapped(); await flush();
  expect(store.isSessionSynced('s')).toBe(true); expect(store.isInteractionSynced('s', 'answer', 'q')).toBe(false);
  expect(mocks.interaction).toHaveBeenCalledWith('s', 'answer', 'q'); expect(mocks.interaction).toHaveBeenCalledOnce();
  store.answer('s', 'q', { custom: 'unknown request' }); expect(mocks.putOutbox).not.toHaveBeenCalled();
  mocks.interaction.mockResolvedValue({ event: question(5, 'answered'), throughSeq: 10 });
  await store.refreshInteraction('s', 'answer', 'q');
  expect(store.getEvents('s').findLast(value => value.kind === 'question')).toMatchObject({ seq: 5, data: { status: 'answered' } });
  expect(store.isInteractionSynced('s', 'answer', 'q')).toBe(true);
});

it('a failed automatic lookup stays finite and an explicit read-only retry reports its network failure', async () => {
  const store = await gapped(); await flush(); expect(mocks.interaction).toHaveBeenCalledOnce();
  await expect(store.refreshInteraction('s', 'answer', 'q')).rejects.toThrow('lookup unavailable');
  await flush(); expect(mocks.interaction).toHaveBeenCalledTimes(2); expect(store.isInteractionSynced('s', 'answer', 'q')).toBe(false);
});

it('a current per-ID response can enable a genuinely pending old request while preserving newer WS resolution', async () => {
  let release!: (value: { event: StoredEvent; throughSeq: number }) => void;
  mocks.interaction.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const store = await gapped(); expect(store.isInteractionSynced('s', 'answer', 'q')).toBe(false);
  connection().onMessage({ op: 'event', event: question(11, 'answered') });
  release({ event: question(), throughSeq: 10 }); await flush();
  expect(store.getEvents('s').findLast(value => value.kind === 'question')).toMatchObject({ seq: 11, data: { status: 'answered' } });
  expect(store.isSessionSynced('s')).toBe(true); store.answer('s', 'q', { custom: 'stale GET cannot reopen' }); expect(mocks.putOutbox).not.toHaveBeenCalled();
});

it('a lookup whose end predates the known cache blocks replay instead of accepting a rolled-back server', async () => {
  mocks.interaction.mockResolvedValue({ event: question(), throughSeq: 9 }); const store = await gapped(); await flush();
  expect(store.isSessionSynced('s')).toBe(false); expect(store.isInteractionSynced('s', 'answer', 'q')).toBe(false);
  store.answer('s', 'q', { custom: 'rolled back' }); expect(mocks.putOutbox).not.toHaveBeenCalled(); expect(mocks.interaction).toHaveBeenCalledOnce();
});

it('a delayed detail response cannot mistake a later live event for a server rollback', async () => {
  const store = await ready();
  mocks.detail.mockImplementationOnce(async () => {
    connection().onMessage({ op: 'event', event: event(2) });
    return { id: 's', lastSeq: 1 };
  });
  await store.ensureSession('s'); expect(store.isSessionSynced('s')).toBe(true);
});

it('a restored durable answer across a history gap is checked by ID before replay and discarded when native ended it', async () => {
  mocks.getOutbox.mockResolvedValue([{ clientCommandId: 'old-command', command: { op: 'answer', sessionId: 's', questionId: 'q', clientCommandId: 'old-command', answer: { custom: 'old answer' } }, status: 'pending', createdAt: 1 }]);
  mocks.interaction.mockResolvedValue({ event: question(5, 'answered'), throughSeq: 10 });
  const store = new AppStore(); connection().onState('online', 0);
  mocks.detail.mockResolvedValue({ id: 's', lastSeq: 10 }); mocks.events.mockResolvedValue({ events: [event(9), event(10)], hasMore: true });
  await store.restoreOutbox(); await store.ensureSession('s'); connection().onOpen?.(); expect(mocks.send).not.toHaveBeenCalled();
  snapshot(10); await flush();
  expect(mocks.interaction).toHaveBeenCalledWith('s', 'answer', 'q'); expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.deleteOutbox).toHaveBeenCalledWith('old-command');
});

it('automatic lookup covers known unresolved requests with at most four concurrent reads and no polling loop', async () => {
  const pending = Array.from({ length: 6 }, (_, index) => ({ ...question(index + 1), data: { questionId: `q${index}`, prompt: 'Question' } }));
  mocks.cached.mockResolvedValue(pending); mocks.detail.mockResolvedValue({ id: 's', lastSeq: 10 }); mocks.events.mockResolvedValue({ events: [event(9), event(10)], hasMore: true });
  const reads = new Map<string, (value: { event: null; throughSeq: number }) => void>(); let peak = 0;
  mocks.interaction.mockImplementation((_session: string, _op: string, id: string) => new Promise(resolve => { reads.set(id, resolve); peak = Math.max(peak, reads.size); }));
  const store = new AppStore(); connection().onState('online', 0); await store.ensureSession('s'); snapshot(10); await flush();
  expect(mocks.interaction).toHaveBeenCalledTimes(4);
  for (const [id, resolve] of [...reads]) { reads.delete(id); resolve({ event: null, throughSeq: 10 }); } await flush();
  expect(mocks.interaction).toHaveBeenCalledTimes(6);
  for (const [id, resolve] of [...reads]) { reads.delete(id); resolve({ event: null, throughSeq: 10 }); } await flush(); snapshot(10); await flush();
  expect(peak).toBeLessThanOrEqual(4); expect(mocks.interaction).toHaveBeenCalledTimes(6);
});

it('HTTP lookup truth waits for the current WS watermark before enabling a pending interaction', async () => {
  mocks.interaction.mockResolvedValue({ event: question(), throughSeq: 11 }); const store = await gapped(); await flush();
  expect(store.isSessionSynced('s')).toBe(false); expect(store.isInteractionSynced('s', 'answer', 'q')).toBe(false);
  connection().onMessage({ op: 'event', event: event(11) });
  expect(store.isInteractionSynced('s', 'answer', 'q')).toBe(true);
  store.answer('s', 'q', { custom: 'verified answer' }); await flush(); expect(mocks.send).toHaveBeenCalledOnce();
});

it('older paging bridges a partial cached history instead of stopping at an unrelated cached seq one', async () => {
  const store = await gapped(); mocks.events.mockResolvedValueOnce({ events: Array.from({ length: 7 }, (_, index) => event(index + 2)), hasMore: false });
  expect(await store.loadOlder('s')).toBe(true); expect(mocks.events).toHaveBeenLastCalledWith('s', { before: 9, limit: 200 });
  expect(store.isInteractionSynced('s', 'answer', 'q')).toBe(true);
});
