import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import type { AdapterEvent, AgentId, NativeHistoryRecord } from '@webdcc/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

type HistoryEvent = NativeHistoryRecord['events'][number];
const record = (nativeSeq: number, nativeTurnId: string | undefined, event: HistoryEvent): NativeHistoryRecord => ({
  nativeSeq, ...(nativeTurnId === undefined ? {} : { nativeTurnId }), at: new Date(1000 + nativeSeq * 1000).toISOString(), native: { nativeSeq, nativeTurnId, event }, events: [event],
});
const agents: AgentId[] = ['codex', 'claude-code', 'dsh'];
const cases = agents.flatMap(agent => ['turn', 'kind', 'echo'].map(scope => ({ agent, scope })));

it.each(cases)('$agent history preserves a shared key across distinct $scope identities', async ({ agent, scope }) => {
  const db = openDb(':memory:');
  try {
    const store = new Store(db); const workspace = store.createWorkspace('history identity', '/tmp'); const session = store.createSession({ workspaceId: workspace.id, agent });
    store.updateSession(session.id, { nativeId: 'native' });
    let records: NativeHistoryRecord[];
    if (scope === 'echo') {
      store.appendEvent({ sessionId: session.id, turnId: 'local-turn', itemKey: 'local-user', kind: 'user.message', data: { text: 'local input', clientCommandId: 'local-request' } });
      records = [
        record(1, 'A', { type: 'item.complete', itemKey: 'shared', kind: 'user.message', data: { text: 'local input', clientCommandId: 'local-request' } }),
        record(2, 'B', { type: 'item.complete', itemKey: 'shared', kind: 'user.message', data: { text: 'external input', clientCommandId: 'external-request' } }),
      ];
    } else records = [
      record(1, 'B', { type: 'item.complete', itemKey: 'shared', kind: 'command', data: { command: 'old command', status: 'completed', outputTail: 'done' } }),
      record(2, scope === 'turn' ? 'A' : 'B', { type: 'item.start', itemKey: 'shared', kind: scope === 'kind' ? 'file.read' : 'command',
        data: scope === 'kind' ? { path: '/tmp/current' } : { command: 'current command', status: 'running' } }),
    ];
    const emitted = store.nativeHistory.import(session.id, 'native', records); const events = store.allEvents(session.id);
    const directory = process.env['WDCC_HISTORY_IDENTITY_EVIDENCE_DIR'];
    if (directory !== undefined) await writeFile(join(directory, `${agent}-${scope}.json`), JSON.stringify({ agent, scope, records, emitted, events, nativeRecords: db.prepare('SELECT * FROM native_history_records').all() }, null, 2));
    if (scope === 'echo') {
      expect(events.filter(event => event.kind === 'user.message')).toHaveLength(2);
      expect(emitted).toHaveLength(1); expect(emitted[0]?.data).toMatchObject({ text: 'external input', clientCommandId: 'external-request' });
      expect(emitted[0]?.turnId).toBe(store.nativeHistory.turn(session.id, 'B'));
      expect(store.nativeHistory.turn(session.id, 'A')).toBe('local-turn');
    } else {
      expect(emitted).toHaveLength(2);
      expect(emitted[1]?.data).toMatchObject(scope === 'kind' ? { path: '/tmp/current' } : { command: 'current command', status: 'running' });
      expect(emitted[1]?.turnId).toBe(store.nativeHistory.turn(session.id, scope === 'turn' ? 'A' : 'B'));
    }
    expect(store.nativeHistory.import(session.id, 'native', records)).toEqual([]);
    expect(store.allEvents(session.id)).toEqual(events);
    expect(db.prepare('SELECT COUNT(*) AS count FROM native_history_records').get()).toEqual({ count: 2 });
  } finally { db.close(); }
});

it('same turn/kind completion still suppresses its start, including an explicitly absent native turn', () => {
  const db = openDb(':memory:');
  try {
    const store = new Store(db); const workspace = store.createWorkspace('same history identity', '/tmp'); const session = store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    store.updateSession(session.id, { nativeId: 'native' });
    const start: AdapterEvent = { type: 'item.start', itemKey: 'shared', kind: 'command', data: { command: 'kept', status: 'running' } };
    const complete: AdapterEvent = { type: 'item.complete', itemKey: 'shared', kind: 'command', data: { command: 'kept', status: 'failed', outputTail: 'native failure' } };
    const records = [record(1, undefined, start), record(2, undefined, complete), record(3, 'turn', start), record(4, 'turn', complete)];
    const imported = store.nativeHistory.import(session.id, 'native', records);
    expect(imported).toHaveLength(2); expect(imported.map(event => event.data)).toEqual([complete.data, complete.data]);
    expect(imported[0]?.turnId).toBeNull(); expect(imported[1]?.turnId).not.toBeNull();
    expect(store.nativeHistory.import(session.id, 'native', records)).toEqual([]);
  } finally { db.close(); }
});

it('item identities survive SQLite reopen and an event write error rolls back both raw records and turn bindings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-history-identity-')); const path = join(directory, 'state.db');
  let db = openDb(path); const other = openDb(path);
  try {
    let store = new Store(db); const workspace = store.createWorkspace('durable history identity', directory); const session = store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    store.updateSession(session.id, { nativeId: 'native' });
    const records = [record(1, 'B', { type: 'item.complete', itemKey: 'shared', kind: 'command', data: { command: 'B', status: 'completed' } }),
      record(2, 'A', { type: 'item.start', itemKey: 'shared', kind: 'command', data: { command: 'A', status: 'running' } })];
    const imported = store.nativeHistory.import(session.id, 'native', records);
    expect(imported).toHaveLength(2);
    expect(new Store(other).allEvents(session.id)).toEqual(imported);
    db.close(); db = openDb(path); store = new Store(db);
    expect(store.nativeHistory.import(session.id, 'native', records)).toEqual([]); expect(store.allEvents(session.id)).toEqual(imported);
    db.exec("CREATE TRIGGER reject_history_event BEFORE INSERT ON events WHEN NEW.item_key = 'reject' BEGIN SELECT RAISE(ABORT, 'controlled-history-write-failure'); END");
    const failing = record(3, 'C', { type: 'item.start', itemKey: 'reject', kind: 'command', data: { command: 'C', status: 'running' } });
    expect(() => store.nativeHistory.import(session.id, 'native', [failing])).toThrow('controlled-history-write-failure');
    expect(new Store(other).allEvents(session.id)).toEqual(imported); expect(store.nativeHistory.turn(session.id, 'C')).toBeUndefined();
    expect(other.prepare('SELECT COUNT(*) AS count FROM native_history_records').get()).toEqual({ count: 2 });
  } finally { other.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});
