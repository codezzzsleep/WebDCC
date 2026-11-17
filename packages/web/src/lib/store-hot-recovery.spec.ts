import { expect, it, vi } from 'vitest';
import type { SnapshotMessage } from '@webdcc/protocol';
import type { SyncConnectionOptions } from './connection.js';
const mocks = vi.hoisted(() => ({ options: [] as SyncConnectionOptions[] }));
vi.mock('./connection.js', () => ({ SyncConnection: class { constructor(options: SyncConnectionOptions) { mocks.options.push(options); } sendCommand() {} subscribe() {} } }));
vi.mock('./api.js', () => ({ api: {} }));
vi.mock('./db.js', () => ({ cache: { putSession: vi.fn(), putEvents: vi.fn(), setMeta: vi.fn(), deleteOutbox: vi.fn() } }));
import { AppStore } from './store.js';
const snapshot: SnapshotMessage = { op: 'snapshot', sessionId: 's', throughSeq: 1, items: [{ itemKey: 'original item', kind: 'assistant.message', data: { text: 'original partial' }, turnId: 'original public turn',
  observation: { state: 'lost', identity: { ownerId: 'original owner', generation: 1, hostId: 'original host' }, origins: [] } }],
  recovery: { formatVersion: 1, coverage: 'complete', throughEnvelopeId: 9, hasMore: false, issues: [], omittedIssues: 0 } };

it('snapshot preserves observation metadata, isolated refresh and original turn identity', () => {
  const store = new AppStore(); const receive = mocks.options.at(-1)!.onMessage;
  receive(structuredClone(snapshot)); expect(store.getHot('s')).toEqual(snapshot.items); expect(store.getTurns('s')[0]).toMatchObject({ turnId: 'original public turn', observation: 'lost', activity: null });
  receive(structuredClone(snapshot)); expect(store.getHot('s')).toHaveLength(1); expect(store.getHotRecovery('s')).toEqual(snapshot.recovery);
  receive({ ...snapshot, items: [], recovery: { ...snapshot.recovery!, coverage: 'partial', issues: [{ envelopeId: 10, reason: 'projection-context-not-recorded' }] } });
  expect(store.getHot('s')).toEqual([]); expect(store.getHotRecovery('s')?.coverage).toBe('partial');
  receive({ op: 'snapshot', sessionId: 's', throughSeq: 1, items: [] }); expect(store.getHotRecovery('s')).toBeUndefined();
});

it('unscoped/late deltas cannot append to recovered output; only a fresh start replaces observation loss', () => {
  const store = new AppStore(); const receive = mocks.options.at(-1)!.onMessage;
  receive(structuredClone(snapshot));
  receive({ op: 'delta', sessionId: 's', itemKey: 'original item', turnId: 'original public turn', field: 'text', append: 'late output' });
  receive({ op: 'update', sessionId: 's', itemKey: 'original item', turnId: 'original public turn', data: { text: 'late update' } });
  expect(store.getHot('s')[0]?.data).toEqual({ text: 'original partial' });
  receive({ op: 'update', sessionId: 's', itemKey: 'original item', turnId: 'original public turn', data: { started: true, kind: 'assistant.message', data: { text: 'fresh' } } });
  receive({ op: 'delta', sessionId: 's', itemKey: 'original item', turnId: 'original public turn', field: 'text', append: ' output' });
  expect(store.getHot('s')[0]?.data).toEqual({ text: 'fresh output' }); expect(store.getHot('s')[0]?.observation).toBeUndefined();
});
