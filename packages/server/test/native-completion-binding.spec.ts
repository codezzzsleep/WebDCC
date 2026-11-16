import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent } from '@webdcc/protocol';
import { openDb, type Db } from '../src/db.js';
import { Store } from '../src/store.js';
import { payloadHash } from '../src/command-journal.js';
import { createTestApp } from './helpers.js';

type Completion = Extract<AdapterEvent, { type: 'item.complete' }>;
const event = (nativeId = 'native-A', text = 'original completion'): Completion => ({
  type: 'item.complete', itemKey: 'shared-item', kind: 'assistant.message', data: { text },
  native: { type: 'assistant', session_id: nativeId, uuid: '00000000-0000-4000-8000-000000000001', parent_tool_use_id: null,
    message: { id: 'shared-item', content: [{ type: 'text', text }] } },
});
function setup(db: Db): { store: Store; sessionId: string } {
  const store = new Store(db); const workspace = store.createWorkspace('scope', '/tmp');
  return { store, sessionId: store.createSession({ workspaceId: workspace.id, agent: 'claude-code' }).id };
}
function context(sessionId: string, nativeId?: string, agent = 'claude-code') { return { sessionId, agent, nativeId }; }
function project(store: Store, sessionId: string, nativeId: string | undefined, value = event(), agent = 'claude-code') {
  const result = store.nativeEvents.mapping(context(sessionId, nativeId, agent), value, 'accepted');
  if (!result.duplicate) store.appendEvent({ sessionId, turnId: null, itemKey: value.itemKey, kind: value.kind, data: value.data, native: value.native, nativeEnvelopeId: result.id });
  return result;
}
function legacyKey(sessionId: string, nativeId: string | undefined, value: Completion): string {
  return payloadHash({ sessionId, nativeId, seq: value.nativeSeq, kind: value.kind, itemKey: value.itemKey, turnId: value.nativeTurnId, data: value.data });
}
function seedLegacy(db: Db, store: Store, sessionId: string, value: Completion, nativeId?: string): { id: number; key: string } {
  const id = store.nativeEvents.mapping(context(sessionId, nativeId), value, 'accepted').id;
  db.prepare('DELETE FROM native_event_projections WHERE envelope_id = ?').run(id);
  const key = legacyKey(sessionId, nativeId, value);
  db.prepare('INSERT INTO native_event_projections (projection_version,event_key,envelope_id) VALUES (1,?,?)').run(key, id);
  store.appendEvent({ sessionId, turnId: null, itemKey: value.itemKey, kind: value.kind, data: value.data, native: value.native, nativeEnvelopeId: id });
  return { id, key };
}
async function evidence(name: string, store: Store, sessionId: string): Promise<void> {
  const directory = process.env['WDCC_BINDING_DEDUPE_EVIDENCE_DIR'];
  if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify({ events: store.allEvents(sessionId),
    observations: store.nativeEvents.list(sessionId).map(row => store.nativeEvents.get(row.id)) }, null, 2));
}

it('the same explicit native completion before and after binding has one semantic event and all ten observations', async () => {
  const db = openDb(':memory:');
  try {
    const { store, sessionId } = setup(db);
    for (let index = 0; index < 10; index++) project(store, sessionId, index === 0 ? '' : 'native-A');
    await evidence('binding', store, sessionId);
    expect(store.allEvents(sessionId)).toHaveLength(1); expect(store.nativeEvents.list(sessionId)).toHaveLength(10);
    expect(store.nativeEvents.list(sessionId).filter(row => row.disposition === 'duplicate-projection')).toHaveLength(9);
  } finally { db.close(); }
});

it('different observed native scopes cannot collide while the runtime binding is empty', async () => {
  const db = openDb(':memory:');
  try {
    const { store, sessionId } = setup(db); project(store, sessionId, '', event('native-A')); project(store, sessionId, '', event('native-B'));
    await evidence('distinct-scopes', store, sessionId);
    expect(store.allEvents(sessionId)).toHaveLength(2);
    expect(store.nativeEvents.list(sessionId).map(row => row.nativeId)).toEqual(['native-A', 'native-B']);
  } finally { db.close(); }
});

it.each(['', undefined, 'native-A'])('a committed legacy runtime key %j is reused only through its real event association', async nativeId => {
  const db = openDb(':memory:');
  try {
    const { store, sessionId } = setup(db); const original = seedLegacy(db, store, sessionId, event(), nativeId);
    const result = project(store, sessionId, 'native-A'); await evidence(`legacy-${nativeId ?? 'missing'}`, store, sessionId);
    expect(result.duplicate).toBe(true); expect(store.allEvents(sessionId)).toHaveLength(1);
    expect(db.prepare('SELECT event_seq FROM native_event_projections WHERE event_key = ?').get(original.key)).toEqual({ event_seq: 1 });
  } finally { db.close(); }
});

it('legacy aliasing cannot merge another scope or another content despite equal item keys', () => {
  const db = openDb(':memory:');
  try {
    const { store, sessionId } = setup(db); seedLegacy(db, store, sessionId, event('native-A'), '');
    expect(project(store, sessionId, '', event('native-B')).duplicate).toBe(false);
    expect(project(store, sessionId, 'native-A', event('native-A', 'different original')).duplicate).toBe(false);
    expect(store.allEvents(sessionId)).toHaveLength(3);
  } finally { db.close(); }
});

it('different declared source Agents cannot inherit the same native scope legacy key', () => {
  const db = openDb(':memory:');
  try {
    const { store, sessionId } = setup(db); seedLegacy(db, store, sessionId, event(), 'native-A');
    const value: Completion = { ...event(), native: { method: 'item/completed', params: { threadId: 'native-A' } } };
    expect(project(store, sessionId, 'native-A', value, 'codex').duplicate).toBe(false);
    expect(store.allEvents(sessionId)).toHaveLength(2);
  } finally { db.close(); }
});

it('a legacy marker without its committed event is not proof of a duplicate', () => {
  const db = openDb(':memory:');
  try {
    const { store, sessionId } = setup(db); seedLegacy(db, store, sessionId, event(), '');
    db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
    expect(project(store, sessionId, 'native-A').duplicate).toBe(false); expect(store.allEvents(sessionId)).toHaveLength(1);
  } finally { db.close(); }
});

it('a scope absent from an old envelope cannot be inferred from a later binding', () => {
  const db = openDb(':memory:');
  try {
    const { store, sessionId } = setup(db); const missing = { ...event(), native: { id: 'shared-item' } };
    seedLegacy(db, store, sessionId, missing, '');
    expect(project(store, sessionId, 'native-A').duplicate).toBe(false); expect(store.allEvents(sessionId)).toHaveLength(2);
  } finally { db.close(); }
});

it('an empty native scope cannot certify identity across a runtime binding change', () => {
  const db = openDb(':memory:');
  try {
    const { store, sessionId } = setup(db); project(store, sessionId, '', event(''));
    expect(project(store, sessionId, 'native-A', event('')).duplicate).toBe(false);
    expect(store.allEvents(sessionId)).toHaveLength(2);
  } finally { db.close(); }
});

it('an uncommitted mapping remains recoverable after binding rather than being silently discarded', () => {
  const db = openDb(':memory:');
  try {
    const { store, sessionId } = setup(db); store.nativeEvents.mapping(context(sessionId, ''), event(), 'accepted');
    expect(project(store, sessionId, 'native-A').duplicate).toBe(false); expect(store.allEvents(sessionId)).toHaveLength(1);
    expect(project(store, sessionId, 'native-A').duplicate).toBe(true);
  } finally { db.close(); }
});

it('an alias transaction failure retains the legacy event and retry can still reuse it', () => {
  const db = openDb(':memory:');
  try {
    const { store, sessionId } = setup(db); const original = seedLegacy(db, store, sessionId, event(), '');
    db.exec(`CREATE TEMP TRIGGER fail_alias BEFORE INSERT ON native_event_projections BEGIN SELECT RAISE(ABORT,'controlled alias failure'); END`);
    expect(() => project(store, sessionId, 'native-A')).toThrow('controlled alias failure');
    expect(store.allEvents(sessionId)).toHaveLength(1);
    expect(db.prepare('SELECT envelope_id,event_seq FROM native_event_projections WHERE event_key = ?').get(original.key)).toEqual({ envelope_id: original.id, event_seq: 1 });
    db.exec('DROP TRIGGER fail_alias'); expect(project(store, sessionId, 'native-A').duplicate).toBe(true);
  } finally { db.close(); }
});

it('binding and legacy key reuse survive reopening a real SQLite file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wdcc-binding-dedupe-')); const path = join(dir, 'db.sqlite'); let db = openDb(path);
  try {
    const initial = setup(db); const sessionId = initial.sessionId; let store = initial.store;
    seedLegacy(db, store, sessionId, event(), '');
    db.close(); db = openDb(path); store = new Store(db);
    expect(project(store, sessionId, 'native-A').duplicate).toBe(true);
    await evidence('database-reopen', store, sessionId); expect(store.allEvents(sessionId)).toHaveLength(1);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

it('actual manager callbacks emitted during create and after create retain one completion', async () => {
  const ctx = await createTestApp();
  try {
    const adapter = new FakeAdapter({ id: 'claude-code' }); let receive!: (id: string, event: AdapterEvent) => void;
    adapter.onEvent = callback => { receive = callback; };
    adapter.create = async opts => { receive(opts.sessionId, { ...event(), runtime: opts.runtime }); return { nativeId: 'native-A' }; };
    ctx.manager.registerAdapter(adapter); const workspace = ctx.store.createWorkspace('controlled create', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    receive(session.id, event()); await evidence('manager-callback', ctx.store, session.id);
    expect(ctx.store.allEvents(session.id).filter(row => row.kind === 'assistant.message')).toHaveLength(1);
    expect(ctx.store.nativeEvents.list(session.id).filter(row => row.channel === 'item.complete')).toHaveLength(2);
  } finally { await ctx.close(); }
});
