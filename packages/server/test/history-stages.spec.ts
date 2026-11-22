import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import type { AgentId, NativeHistoryRecord } from '@webdcc/protocol';
import { CURRENT_SCHEMA_VERSION, openDb } from '../src/db.js';
import { Store } from '../src/store.js';

const cases = (['codex', 'claude-code', 'dsh'] as AgentId[]).flatMap(agent =>
  (['completed', 'failed'] as const).flatMap(status => [false, true].map(reopen => ({ agent, status, reopen }))));

it.each(cases)('$agent staged $status result updates its partial item (reopen=$reopen)', async ({ agent, status, reopen }) => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-history-stages-')); const path = join(directory, 'state.db');
  let db = openDb(path);
  try {
    let store = new Store(db); const workspace = store.createWorkspace('history stage', directory); const session = store.createSession({ workspaceId: workspace.id, agent });
    store.updateSession(session.id, { nativeId: 'native' });
    const call = { type: 'tool/call', seq: 1, time: 1000, data: { callId: 'shared', name: 'bash', arguments: '{"command":"pwd"}' } };
    const result = { type: 'tool/result', seq: 2, time: 2000, data: { toolCallId: 'shared', message: { isError: status === 'failed', content: [{ type: 'text', text: 'native output' }] } } };
    const start: NativeHistoryRecord = { nativeSeq: 1, nativeTurnId: 'native-turn', at: new Date(1000).toISOString(), native: call,
      events: [{ type: 'item.start', itemKey: 'tool-shared', kind: 'command', data: { command: 'pwd', status: 'running' } }] };
    const end: NativeHistoryRecord = { nativeSeq: 2, nativeTurnId: 'native-turn', at: new Date(2000).toISOString(), native: result,
      events: [{ type: 'item.complete', itemKey: 'tool-shared', kind: 'command', data: { command: 'pwd', status, outputTail: 'native output' } }] };
    const partial = store.nativeHistory.import(session.id, 'native', [start]);
    expect(partial).toHaveLength(1); expect(partial[0]?.data).toMatchObject({ status: 'running' });
    if (reopen) { db.close(); db = openDb(path); store = new Store(db); }
    const completed = store.nativeHistory.import(session.id, 'native', [end]);
    const evidence = process.env['WDCC_HISTORY_STAGES_EVIDENCE_DIR'];
    if (evidence !== undefined) await writeFile(join(evidence, `${agent}-${status}-${reopen}.json`), JSON.stringify({ agent, status, reopen, start, end, partial, completed,
      events: store.allEvents(session.id), raw: db.prepare('SELECT * FROM native_history_records WHERE session_id = ?').all(session.id) }, null, 2));
    expect(completed).toHaveLength(1); expect(completed[0]?.data).toMatchObject({ status, outputTail: 'native output' });
    expect(completed[0]?.turnId).toBe(partial[0]?.turnId); expect(completed[0]?.itemKey).toBe(partial[0]?.itemKey);
    expect(store.allEvents(session.id)).toEqual([...partial, ...completed]);
    expect(store.nativeHistory.import(session.id, 'native', [start, end])).toEqual([]);
    expect(store.allEvents(session.id).some(event => event.kind === 'turn.completed')).toBe(false);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

const record = (nativeSeq: number, nativeTurnId: string | undefined, event: NativeHistoryRecord['events'][number], native: unknown = { nativeSeq, event }): NativeHistoryRecord => ({
  nativeSeq, ...(nativeTurnId === undefined ? {} : { nativeTurnId }), at: new Date(nativeSeq * 1000).toISOString(), native, events: [event],
});

it('v14 DSH source-backed read start upgrades after migration without guessing from a missing status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-legacy-history-stage-')); const path = join(directory, 'state.db'); let db = openDb(path);
  try {
    let store = new Store(db); const workspace = store.createWorkspace('legacy stage', directory); const session = store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    store.updateSession(session.id, { nativeId: 'native' });
    const raw = { type: 'tool/call', seq: 1, time: 1000, data: { callId: 'read', name: 'read', arguments: '{"file_path":"/tmp/input"}' } };
    const start = record(1, 'turn', { type: 'item.start', itemKey: 'tool-read', kind: 'file.read', data: { path: '/tmp/input' } }, raw);
    const partial = store.nativeHistory.import(session.id, 'native', [start]);
    // Construct the v14 database layout, which retained raw/start but no stage
    // index. This is a controlled schema fixture, not a legacy binary run.
    db.exec('DROP TABLE native_history_partial_items'); db.pragma('user_version = 14');
    const before = { events: store.allEvents(session.id), raw: db.prepare('SELECT * FROM native_history_records').all() };
    db.close(); db = openDb(path); store = new Store(db);
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(store.allEvents(session.id)).toEqual(before.events); expect(db.prepare('SELECT * FROM native_history_records').all()).toEqual(before.raw);
    const end = record(2, 'turn', { type: 'item.complete', itemKey: 'tool-read', kind: 'file.read', data: { path: '/tmp/input', status: 'failed', error: 'actual failure' } },
      { type: 'tool/result', seq: 2, time: 2000, data: { toolCallId: 'read', message: { isError: true, content: [{ type: 'text', text: 'actual failure' }] } } });
    const complete = store.nativeHistory.import(session.id, 'native', [end]);
    expect(complete).toHaveLength(1); expect(complete[0]?.data).toMatchObject({ status: 'failed', error: 'actual failure' });
    expect(complete[0]?.turnId).toBe(partial[0]?.turnId); expect(store.nativeHistory.import(session.id, 'native', [end])).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

it('unclassified legacy data is not relabeled as a partial stage based only on running status', () => {
  const db = openDb(':memory:');
  try {
    const store = new Store(db); const workspace = store.createWorkspace('unknown stage', '/tmp'); const session = store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    store.updateSession(session.id, { nativeId: 'native' });
    const start = record(1, 'turn', { type: 'item.start', itemKey: 'tool-unknown', kind: 'command', data: { command: 'kept', status: 'running' } }, { opaqueLegacy: true });
    const partial = store.nativeHistory.import(session.id, 'native', [start]);
    db.exec('DELETE FROM native_history_partial_items');
    const end = record(2, 'turn', { type: 'item.complete', itemKey: 'tool-unknown', kind: 'command', data: { command: 'kept', status: 'completed' } });
    expect(store.nativeHistory.import(session.id, 'native', [end])).toEqual([]); expect(store.allEvents(session.id)).toEqual(partial);
    expect(db.prepare('SELECT COUNT(*) AS count FROM native_history_records').get()).toEqual({ count: 2 });
  } finally { db.close(); }
});

it('later complete updates only its turn/kind partial, including an absent native turn', () => {
  const db = openDb(':memory:');
  try {
    const store = new Store(db); const workspace = store.createWorkspace('scope stages', '/tmp'); const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    store.updateSession(session.id, { nativeId: 'native' });
    const starts = [record(1, 'A', { type: 'item.start', itemKey: 'shared', kind: 'command', data: { command: 'A', status: 'running' } }),
      record(2, 'B', { type: 'item.start', itemKey: 'shared', kind: 'command', data: { command: 'B', status: 'running' } }),
      record(3, 'A', { type: 'item.start', itemKey: 'shared', kind: 'file.change', data: { changes: [], status: 'running' } }),
      record(4, undefined, { type: 'item.start', itemKey: 'shared', kind: 'tool.call', data: { name: 'tool', input: {}, status: 'running' } })];
    const before = store.nativeHistory.import(session.id, 'native', starts);
    const end = record(5, 'A', { type: 'item.complete', itemKey: 'shared', kind: 'command', data: { command: 'A', status: 'completed' } });
    const after = store.nativeHistory.import(session.id, 'native', [end]);
    expect(after).toHaveLength(1); expect(after[0]?.turnId).toBe(before[0]?.turnId);
    expect(db.prepare('SELECT COUNT(*) AS count FROM native_history_partial_items').get()).toEqual({ count: 3 });
    const orphan = record(6, undefined, { type: 'item.complete', itemKey: 'shared', kind: 'tool.call', data: { name: 'tool', input: {}, status: 'failed', output: 'failure' } });
    expect(store.nativeHistory.import(session.id, 'native', [orphan])[0]).toMatchObject({ turnId: null, data: { status: 'failed' } });
    expect(store.allEvents(session.id).some(event => event.kind === 'turn.completed')).toBe(false);
  } finally { db.close(); }
});

it('older source results and a later already persisted terminal cannot replace current item state', () => {
  const db = openDb(':memory:');
  try {
    const store = new Store(db); const workspace = store.createWorkspace('ordered stage', '/tmp'); const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    store.updateSession(session.id, { nativeId: 'native' });
    const start = record(3, 'turn', { type: 'item.start', itemKey: 'item', kind: 'command', data: { command: 'kept', status: 'running' } });
    const [partial] = store.nativeHistory.import(session.id, 'native', [start]);
    expect(store.nativeHistory.import(session.id, 'native', [record(2, 'turn', { type: 'item.complete', itemKey: 'item', kind: 'command', data: { command: 'old', status: 'failed' } })])).toEqual([]);
    const terminal = store.appendEvent({ sessionId: session.id, turnId: partial!.turnId, itemKey: 'item', kind: 'command', data: { command: 'kept', status: 'completed', outputTail: 'observed terminal' } });
    expect(store.nativeHistory.import(session.id, 'native', [record(4, 'turn', { type: 'item.complete', itemKey: 'item', kind: 'command', data: { command: 'kept', status: 'failed', outputTail: 'older history' } })])).toEqual([]);
    expect(store.allEvents(session.id)).toEqual([partial, terminal]);
  } finally { db.close(); }
});

it('stage insert failure rolls back raw records, event, cursor and turn binding for a second connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-history-stage-write-')); const path = join(directory, 'state.db'); const db = openDb(path); const second = openDb(path);
  try {
    const store = new Store(db); const workspace = store.createWorkspace('failed stage write', directory); const session = store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    store.updateSession(session.id, { nativeId: 'native' });
    db.exec("CREATE TRIGGER reject_partial_stage BEFORE INSERT ON native_history_partial_items BEGIN SELECT RAISE(ABORT, 'controlled-stage-write-failure'); END");
    const start = record(1, 'turn', { type: 'item.start', itemKey: 'item', kind: 'command', data: { command: 'kept', status: 'running' } });
    expect(() => store.nativeHistory.import(session.id, 'native', [start])).toThrow('controlled-stage-write-failure');
    expect(new Store(second).allEvents(session.id)).toEqual([]); expect(new Store(second).getSession(session.id)?.lastSeq).toBe(0);
    expect(store.nativeHistory.turn(session.id, 'turn')).toBeUndefined();
    expect(second.prepare('SELECT COUNT(*) AS count FROM native_history_records').get()).toEqual({ count: 0 });
    expect(second.prepare('SELECT COUNT(*) AS count FROM native_history_partial_items').get()).toEqual({ count: 0 });
  } finally { second.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

it('claimed v15 missing its stage table is rejected without modifying retained events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-history-stage-schema-')); const path = join(directory, 'state.db'); const db = openDb(path);
  try {
    const store = new Store(db); const workspace = store.createWorkspace('missing stage schema', directory); const session = store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    const before = store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'kept', kind: 'notice', data: { level: 'info', text: 'kept' } });
    db.pragma('user_version = 15');
    db.exec('DROP TABLE native_history_partial_items');
    expect(() => openDb(path)).toThrow('v15'); expect(store.allEvents(session.id)).toEqual([before]);
    expect(db.pragma('user_version', { simple: true })).toBe(15);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

it('completion stage cleanup failure rolls back result and raw source, then retry commits exactly once', () => {
  const db = openDb(':memory:');
  try {
    const store = new Store(db); const workspace = store.createWorkspace('completion rollback', '/tmp'); const session = store.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    store.updateSession(session.id, { nativeId: 'native' });
    const start = record(1, 'turn', { type: 'item.start', itemKey: 'item', kind: 'command', data: { command: 'kept', status: 'running' } });
    const end = record(2, 'turn', { type: 'item.complete', itemKey: 'item', kind: 'command', data: { command: 'kept', status: 'completed', outputTail: 'native final' } });
    const before = store.nativeHistory.import(session.id, 'native', [start]);
    db.exec("CREATE TRIGGER reject_stage_cleanup BEFORE DELETE ON native_history_partial_items BEGIN SELECT RAISE(ABORT, 'controlled-stage-cleanup-failure'); END");
    expect(() => store.nativeHistory.import(session.id, 'native', [end])).toThrow('controlled-stage-cleanup-failure');
    expect(store.allEvents(session.id)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS count FROM native_history_records').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM native_history_partial_items').get()).toEqual({ count: 1 });
    db.exec('DROP TRIGGER reject_stage_cleanup');
    const result = store.nativeHistory.import(session.id, 'native', [end]); expect(result).toHaveLength(1);
    expect(store.nativeHistory.import(session.id, 'native', [end])).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM native_history_partial_items').get()).toEqual({ count: 0 });
  } finally { db.close(); }
});

it('deleting a session cleans the stage pointers with its source and event rows', () => {
  const db = openDb(':memory:');
  try {
    const store = new Store(db); const workspace = store.createWorkspace('stage cascade', '/tmp'); const session = store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    store.updateSession(session.id, { nativeId: 'native' });
    store.nativeHistory.import(session.id, 'native', [record(1, 'turn', { type: 'item.start', itemKey: 'item', kind: 'command', data: { command: 'kept', status: 'running' } })]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM native_history_partial_items').get()).toEqual({ count: 1 });
    store.deleteSession(session.id);
    expect(db.prepare('SELECT COUNT(*) AS count FROM native_history_partial_items').get()).toEqual({ count: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally { db.close(); }
});
