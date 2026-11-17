import { expect, it, vi } from 'vitest';
import type { RecoveredCompletion, SnapshotMessage, StoredEvent } from '@webdcc/protocol';
import type { SyncConnectionOptions } from './connection.js';
const mocks = vi.hoisted(() => ({ options: [] as SyncConnectionOptions[] }));
vi.mock('./connection.js', () => ({ SyncConnection: class { constructor(options: SyncConnectionOptions) { mocks.options.push(options); } sendCommand() {} subscribe() {} } }));
vi.mock('./api.js', () => ({ api: {} }));
vi.mock('./db.js', () => ({ cache: { putSession: vi.fn(), putEvents: vi.fn(), setMeta: vi.fn(), deleteOutbox: vi.fn() } }));
import { AppStore } from './store.js';
const item: RecoveredCompletion = { projectionId: 'original projection', scopeId: 'original scope', sessionId: 's', turnId: 'original public turn', itemKey: 'original item', kind: 'assistant.message', data: { text: 'original final output' },
  identity: { ownerId: 'original owner', generation: 1, hostId: 'original host' }, late: false, turnEnded: false, origins: [{ id: 50 } as never], assignments: [{ envelopeId: 50, contextDigest: 'original digest', late: false, turnEnded: false }] };
const snapshot: SnapshotMessage = { op: 'snapshot', sessionId: 's', throughSeq: 3, items: [], completed: [item], completedRecovery: { formatVersion: 1, scope: 'immutable-completed-items', coverage: 'complete', throughEnvelopeId: 50, hasMore: false, issues: [], omittedIssues: 0, conflicts: [] } };

it('received completions preserve original identity without becoming semantic events, a cursor advance or a native terminal', () => {
  const store = new AppStore(); const receive = mocks.options.at(-1)!.onMessage;
  receive(structuredClone(snapshot)); const turn = store.getTurns('s')[0]!;
  expect(turn).toMatchObject({ turnId: item.turnId, observation: 'lost', activity: null, recovered: [item], answer: [] }); expect(turn.state).toBe('starting');
  expect(store.getEvents('s')).toEqual([]); expect(store.maxSeq('s')).toBe(0); receive(structuredClone(snapshot)); expect(store.getCompletedProjection('s')).toHaveLength(1);
});

it('same item keys in distinct public turns remain separate and session scoped recovery stays null', () => {
  const store = new AppStore(); const receive = mocks.options.at(-1)!.onMessage;
  receive({ ...snapshot, completed: [item, { ...item, projectionId: 'another projection', turnId: 'another public turn' }, { ...item, projectionId: 'session projection', turnId: null }] });
  expect(store.getTurns('s').map(turn => turn.turnId)).toEqual(['original public turn', 'another public turn']); expect(store.getCompletedProjection('s')[2]?.turnId).toBeNull();
});

it('unrelated and late semantic events cannot erase retained output; its actual committed origin retires it', () => {
  const store = new AppStore(); const receive = mocks.options.at(-1)!.onMessage; receive(structuredClone(snapshot));
  const event: StoredEvent = { sessionId: 's', turnId: item.turnId, seq: 4, itemKey: item.itemKey, kind: item.kind, data: { text: 'different original output' }, at: '2026-11-17T00:00:00Z', nativeEnvelopeId: 99 };
  store.applyEvent(event, true); expect(store.getCompletedProjection('s')).toHaveLength(1);
  store.applyEvent({ ...event, seq: 5, data: item.data, nativeEnvelopeId: 50 }, true); expect(store.getCompletedProjection('s')).toEqual([]);
});

it('authoritative replacement and legacy snapshots clear completed recovery metadata', () => {
  const store = new AppStore(); const receive = mocks.options.at(-1)!.onMessage; receive(structuredClone(snapshot));
  expect(store.getCompletedRecovery('s')?.throughEnvelopeId).toBe(50); receive({ op: 'snapshot', sessionId: 's', throughSeq: 3, items: [] });
  expect(store.getCompletedProjection('s')).toEqual([]); expect(store.getCompletedRecovery('s')).toBeUndefined();
});
