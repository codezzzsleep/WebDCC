import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent, AgentId, NativeHistoryRecord } from '@webdcc/protocol';
import { openDb, type Db } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';

const execute = promisify(execFile);
const original: NativeHistoryRecord = { nativeSeq: 1, nativeTurnId: 'past', at: '2026-11-16T00:00:01.000Z',
  native: { seq: 1, type: 'message', data: { role: 'assistant', content: 'first', values: [1, 2], optional: null, 'ä': { z: 2, a: 1 } } },
  events: [{ type: 'item.complete', itemKey: 'first', kind: 'assistant.message', data: { text: 'first' } }] };
const next: NativeHistoryRecord = { nativeSeq: 2, nativeTurnId: 'past', at: '2026-11-16T00:00:02.000Z',
  native: { seq: 2, type: 'message', data: { role: 'assistant', content: 'second' } },
  events: [{ type: 'item.complete', itemKey: 'second', kind: 'assistant.message', data: { text: 'second' } }] };
function reverse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverse);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverse(child)]));
}
function setup(db: Db, agent: AgentId = 'dsh', nativeId = 'native') {
  const store = new Store(db); const workspace = store.createWorkspace('history JSON', '/tmp');
  const session = store.createSession({ workspaceId: workspace.id, agent }); store.updateSession(session.id, { nativeId });
  return { store, session };
}
const rows = (db: Db) => db.prepare('SELECT * FROM native_history_records ORDER BY native_seq').all();
async function evidence(name: string, value: unknown): Promise<void> {
  const directory = process.env['WDCC_HISTORY_JSON_EVIDENCE_DIR'];
  if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
}

it.each(['codex', 'claude-code', 'dsh'] as const)('%s repeated JSON values ignore object order and allow new records in the same atomic page', async agent => {
  const db = openDb(':memory:');
  try {
    const { store, session } = setup(db, agent); store.nativeHistory.import(session.id, 'native', [original]);
    const before = rows(db); const reordered = { ...original, native: reverse(original.native) }; let rejected: unknown;
    try { store.nativeHistory.import(session.id, 'native', [next, reordered]); } catch (error) { rejected = error; }
    await evidence(`same-${agent}`, { original, reordered, next, before, after: rows(db), events: store.allEvents(session.id), rejected: rejected === undefined ? null : String(rejected) });
    expect(rejected).toBeUndefined(); expect(rows(db)).toHaveLength(2);
    expect(rows(db)[0]).toEqual(before[0]); expect(store.allEvents(session.id).map(event => event.itemKey)).toEqual(['first', 'second']);
    for (let count = 0; count < 10; count++) expect(store.nativeHistory.import(session.id, 'native', [reordered, { ...next, native: reverse(next.native) }])).toEqual([]);
    expect(rows(db)).toHaveLength(2); expect(store.allEvents(session.id)).toHaveLength(2);
  } finally { db.close(); }
});

it.each([
  ['different-text', { role: 'assistant', content: 'changed', values: [1, 2], optional: null, 'ä': { z: 2, a: 1 } }],
  ['array-order', { role: 'assistant', content: 'first', values: [2, 1], optional: null, 'ä': { z: 2, a: 1 } }],
  ['missing-field', { role: 'assistant', content: 'first', values: [1, 2], 'ä': { z: 2, a: 1 } }],
  ['null-is-value', { role: 'assistant', content: 'first', values: [1, 2], optional: false, 'ä': { z: 2, a: 1 } }],
  ['number-is-not-text', { role: 'assistant', content: 'first', values: ['1', 2], optional: null, 'ä': { z: 2, a: 1 } }],
  ['unicode-key-is-not-normalized', { role: 'assistant', content: 'first', values: [1, 2], optional: null, 'ä': { z: 2, a: 1 } }],
] as const)('%s remains a source collision and rolls back the complete page', async (name, data) => {
  const db = openDb(':memory:');
  try {
    const { store, session } = setup(db); store.nativeHistory.import(session.id, 'native', [original]);
    const before = rows(db); const events = store.allEvents(session.id);
    const conflicting = { ...original, native: { seq: 1, type: 'message', data } }; let rejected: unknown;
    try { store.nativeHistory.import(session.id, 'native', [next, conflicting]); } catch (error) { rejected = error; }
    await evidence(name, { original, conflicting, before, after: rows(db), rejected: rejected === undefined ? null : String(rejected) });
    expect(String(rejected)).toContain('内容发生冲突'); expect(rows(db)).toEqual(before); expect(store.allEvents(session.id)).toEqual(events);
  } finally { db.close(); }
});

it('malformed saved JSON remains an explicit collision without rewriting evidence', async () => {
  const db = openDb(':memory:');
  try {
    const { store, session } = setup(db); store.nativeHistory.import(session.id, 'native', [original]);
    db.prepare('UPDATE native_history_records SET native = ? WHERE session_id = ?').run('{invalid', session.id);
    const before = rows(db); let rejected: unknown;
    try { store.nativeHistory.import(session.id, 'native', [next, original]); } catch (error) { rejected = error; }
    await evidence('malformed', { before, after: rows(db), rejected: rejected === undefined ? null : String(rejected) });
    expect(String(rejected)).toContain('内容发生冲突'); expect(rows(db)).toEqual(before); expect(store.allEvents(session.id)).toHaveLength(1);
  } finally { db.close(); }
});

it('separate Node serializers reopen SQLite and preserve original raw bytes while extending history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-history-json-')); const path = join(directory, 'history.sqlite');
  const seed = openDb(path); const { session } = setup(seed); seed.close(); let db: Db | undefined;
  try {
    await writeFile(join(directory, 'inputs.json'), JSON.stringify({ sessionId: session.id, nativeId: 'native', original, next }));
    const fixture = join(import.meta.dirname, 'fixtures/history-json-writer.ts');
    const first = await execute(process.execPath, ['--import', 'tsx', fixture, directory, 'seed']);
    const second = await execute(process.execPath, ['--import', 'tsx', fixture, directory, 'replay']);
    db = openDb(path); const store = new Store(db); const replay = JSON.parse(second.stdout) as { rejected: string | null };
    await evidence('node-reopen', { first: JSON.parse(first.stdout), second: replay, firstStderr: first.stderr, secondStderr: second.stderr,
      raw: rows(db), events: store.allEvents(session.id) });
    expect(replay.rejected).toBeNull(); expect(rows(db)).toHaveLength(2);
    expect((rows(db)[0] as { native: string }).native).toBe(JSON.stringify(original.native));
    expect(store.allEvents(session.id).map(event => event.itemKey)).toEqual(['first', 'second']);
  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
});

it('manager history replay extends the past turn while retaining the current native-accepted input and generation', async () => {
  const db = openDb(':memory:'); const store = new Store(db); const manager = new SessionManager(store, { idleDisposeMin: 0 });
  const adapter = new FakeAdapter({ id: 'dsh' }); let callback!: (id: string, event: AdapterEvent) => void;
  adapter.onEvent = cb => { callback = cb; }; adapter.send = async () => undefined; manager.registerAdapter(adapter);
  try {
    const workspace = store.createWorkspace('manager history JSON', '/tmp'); const session = await manager.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    const current = await manager.send(session.id, { text: 'current' }, 'current-input'); const runtime = manager.getRuntime(session.id)!;
    callback(session.id, { type: 'history', nativeId: runtime.nativeId, records: [original] }); let rejected: unknown;
    try { callback(session.id, { type: 'history', nativeId: runtime.nativeId, records: [next, { ...original, native: reverse(original.native) }] }); } catch (error) { rejected = error; }
    await evidence('manager', { raw: rows(db), events: store.allEvents(session.id), current, identity: runtime.identity,
      owner: store.nativeOwners.get(session.id), queue: store.journal.queue(session.id), rejected: rejected === undefined ? null : String(rejected) });
    expect(rejected).toBeUndefined(); expect(rows(db)).toHaveLength(2); expect(manager.getRuntime(session.id)).toBe(runtime);
    expect(runtime.turnId).toBe(current.turnId); expect(store.journal.queue(session.id)[0]?.state).toBe('native-accepted');
    expect(store.allEvents(session.id).filter(event => event.kind === 'assistant.message')).toHaveLength(2);
  } finally { await manager.disposeAll(); db.close(); }
});
