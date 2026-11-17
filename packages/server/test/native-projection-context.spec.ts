import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent, AgentId } from '@webdcc/protocol';
import { openDb, type Db } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';

async function fixture(db: Db, agent: AgentId = 'codex') {
  const store = new Store(db); const manager = new SessionManager(store, { idleDisposeMin: 0 }); const adapter = new FakeAdapter({ id: agent });
  let callback!: (sessionId: string, event: AdapterEvent) => void; adapter.onEvent = cb => { callback = cb; }; adapter.send = async () => undefined; manager.registerAdapter(adapter);
  const workspace = store.createWorkspace('projection context', tmpdir()); const session = await manager.createSession({ workspaceId: workspace.id, agent });
  const sent = await manager.send(session.id, { text: 'original input' }); const identity = manager.getRuntime(session.id)!.identity;
  return { store, manager, session, sent, identity, emit: (event: AdapterEvent) => callback(session.id, { ...event, runtime: event.runtime ?? identity }) };
}
const start = (patch: object = {}): Extract<AdapterEvent, { type: 'item.start' }> => ({ type: 'item.start', itemKey: 'hot', kind: 'assistant.message', data: { text: '' }, ...patch });
const delta = (patch: object = {}): Extract<AdapterEvent, { type: 'item.delta' }> => ({ type: 'item.delta', itemKey: 'hot', field: 'text', append: 'original partial\n', ...patch });
const latest = (store: Store, sessionId: string) => store.nativeEvents.list(sessionId, 0, 500).at(-1)!;
async function evidence(name: string, value: unknown) {
  const directory = process.env['WDCC_PROJECTION_CONTEXT_EVIDENCE_DIR']; if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2));
}

it.each(['codex', 'claude-code', 'dsh'] as const)('%s actual anonymous context is committed before hot publication with original native identities', async agent => {
  const db = openDb(':memory:'); const ctx = await fixture(db, agent); const observed: unknown[] = [];
  ctx.manager.setHooks({ onFeed: () => undefined, onStatus: () => undefined, onEvent: () => undefined,
    onUpdate: () => observed.push(ctx.store.projectionContexts.get(latest(ctx.store, ctx.session.id).id)),
    onDelta: () => observed.push(ctx.store.projectionContexts.get(latest(ctx.store, ctx.session.id).id)) });
  try {
    ctx.emit(start({ native: { session_id: ctx.session.nativeId, agent_id: 'actor', parent_tool_use_id: 'parent', opaque: 'body remains in original raw' } }));
    ctx.emit(delta()); const raw = latest(ctx.store, ctx.session.id); const lookup = ctx.store.projectionContexts.get(raw.id);
    await evidence(agent, { lookup, observed, hot: ctx.manager.hotItems(ctx.session.id), raw: ctx.store.nativeEvents.get(raw.id) });
    expect(lookup.status).toBe('recorded'); if (lookup.status !== 'recorded') throw new Error(lookup.reason);
    expect(lookup.context).toMatchObject({ turnId: ctx.sent.turnId, identity: ctx.identity, late: false, turnEnded: false, hot: { present: true, kind: 'assistant.message', closed: false } });
    expect(lookup.context.source.nativeTurnId).toBeNull(); expect(lookup.context.source.nativeId).toBe(ctx.session.nativeId);
    expect(observed).toHaveLength(2); expect(observed.every(value => (value as { status: string }).status === 'recorded')).toBe(true);
    const original = ctx.store.nativeEvents.list(ctx.session.id).find(record => record.channel === 'item.start')!;
    const first = ctx.store.projectionContexts.get(original.id); expect(first.status).toBe('recorded');
    if (first.status === 'recorded') { expect(first.context.source).toMatchObject({ actorId: 'actor', parentToolUseId: 'parent' }); expect(JSON.stringify(first.context)).not.toContain('body remains in original raw'); }
  } finally { await ctx.manager.disposeAll(); db.close(); }
});

it('session-scope stays null and closed-item context prevents a late start from being interpreted as new hot state', async () => {
  const db = openDb(':memory:'); const ctx = await fixture(db);
  try {
    ctx.emit(start({ scope: 'session', itemKey: 'global' })); const global = ctx.store.projectionContexts.get(latest(ctx.store, ctx.session.id).id);
    expect(global.status).toBe('recorded'); if (global.status === 'recorded') expect(global.context.turnId).toBeNull();
    ctx.emit(start()); ctx.emit({ type: 'item.cancel', itemKey: 'hot' }); ctx.emit(start());
    const closed = ctx.store.projectionContexts.get(latest(ctx.store, ctx.session.id).id);
    expect(closed.status).toBe('recorded'); if (closed.status === 'recorded') expect(closed.context.hot).toMatchObject({ present: false, closed: true });
    expect(ctx.manager.hotItems(ctx.session.id).some(item => item.itemKey === 'hot')).toBe(false);
  } finally { await ctx.manager.disposeAll(); db.close(); }
});

it('actual SQL context failure preserves raw and the live native pump, with one explicit recovery warning', async () => {
  const db = openDb(':memory:'); const ctx = await fixture(db);
  try {
    db.exec("CREATE TRIGGER reject_context BEFORE INSERT ON app_settings WHEN NEW.key LIKE 'native-projection-context:%' BEGIN SELECT RAISE(ABORT, 'context failed'); END");
    ctx.emit(start()); ctx.emit(delta()); const raw = latest(ctx.store, ctx.session.id);
    await evidence('sql-abort', { lookup: ctx.store.projectionContexts.get(raw.id), hot: ctx.manager.hotItems(ctx.session.id), events: ctx.store.allEvents(ctx.session.id), raw: ctx.store.nativeEvents.get(raw.id), owner: ctx.store.nativeOwners.get(ctx.session.id) });
    expect(ctx.store.projectionContexts.get(raw.id)).toMatchObject({ status: 'missing' }); expect(ctx.manager.hotItems(ctx.session.id)[0]?.data).toMatchObject({ text: 'original partial\n' });
    expect(ctx.store.allEvents(ctx.session.id).filter(event => event.kind === 'notice' && (event.data as { nativeType?: string }).nativeType === 'projection-context-unavailable')).toHaveLength(1);
    expect(ctx.store.nativeOwners.get(ctx.session.id)?.state).toBe('active');
    db.exec('DROP TRIGGER reject_context'); ctx.emit({ ...delta(), append: 'after repair' }); expect(ctx.store.projectionContexts.get(latest(ctx.store, ctx.session.id).id).status).toBe('recorded');
  } finally { db.exec('DROP TRIGGER IF EXISTS reject_context'); await ctx.manager.disposeAll(); db.close(); }
});

it('stale generation cannot record a context or change the original hot state', async () => {
  const db = openDb(':memory:'); const ctx = await fixture(db);
  try {
    ctx.emit(start()); const before = ctx.manager.hotItems(ctx.session.id);
    ctx.emit({ ...delta(), runtime: { ...ctx.identity, generation: ctx.identity.generation - 1 } });
    const raw = latest(ctx.store, ctx.session.id); expect(raw.disposition).toBe('stale-generation');
    expect(ctx.store.projectionContexts.get(raw.id).status).toBe('missing'); expect(ctx.manager.hotItems(ctx.session.id)).toEqual(before);
  } finally { await ctx.manager.disposeAll(); db.close(); }
});

it('same recorded assignment is idempotent, another assignment conflicts without rewriting raw or the first context', async () => {
  const db = openDb(':memory:'); const ctx = await fixture(db);
  try {
    ctx.emit(start()); const raw = latest(ctx.store, ctx.session.id); const lookup = ctx.store.projectionContexts.get(raw.id);
    if (lookup.status !== 'recorded') throw new Error('missing recorded context'); const beforeRaw = ctx.store.nativeEvents.get(raw.id); const context = lookup.context;
    const assignment = { sessionId: ctx.session.id, identity: context.identity, turnId: context.turnId, late: context.late, turnEnded: context.turnEnded, hot: context.hot };
    for (let count = 0; count < 10; count++) ctx.store.projectionContexts.record(raw.id, assignment);
    expect(() => ctx.store.projectionContexts.record(raw.id, { ...assignment, late: true })).toThrow('发生冲突');
    expect(ctx.store.projectionContexts.get(raw.id)).toEqual(lookup); expect(ctx.store.nativeEvents.get(raw.id)).toEqual(beforeRaw);
  } finally { await ctx.manager.disposeAll(); db.close(); }
});

it.each(['bad-json', 'version', 'context-shape', 'context-digest', 'raw-digest', 'source-identity', 'source-schema'] as const)('%s stored evidence remains explicit rather than being guessed or repaired', async kind => {
  const db = openDb(':memory:'); const ctx = await fixture(db);
  try {
    ctx.emit(start()); const raw = latest(ctx.store, ctx.session.id); const key = `native-projection-context:${raw.id}`;
    if (kind === 'bad-json') db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('{invalid', key);
    if (kind === 'version') db.prepare("UPDATE app_settings SET value = json_set(value, '$.formatVersion', 99) WHERE key = ?").run(key);
    if (kind === 'context-shape') db.prepare("UPDATE app_settings SET value = json_set(value, '$.turnId', 42) WHERE key = ?").run(key);
    if (kind === 'context-digest') db.prepare("UPDATE app_settings SET value = json_set(value, '$.contextDigest', 'wrong digest') WHERE key = ?").run(key);
    if (kind === 'raw-digest') db.prepare("UPDATE native_event_envelopes SET payload = json_set(payload, '$.data.text', 'changed raw') WHERE id = ?").run(raw.id);
    if (kind === 'source-identity') db.prepare('UPDATE native_event_envelopes SET owner_id = ? WHERE id = ?').run('foreign', raw.id);
    if (kind === 'source-schema') db.prepare('UPDATE native_event_envelopes SET schema_hash = ? WHERE id = ?').run('unsupported', raw.id);
    const before = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key); const lookup = ctx.store.projectionContexts.get(raw.id);
    await evidence(kind, { lookup, before, raw: ctx.store.nativeEvents.get(raw.id) });
    expect(lookup.status).not.toBe('recorded'); expect(db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)).toEqual(before);
  } finally { await ctx.manager.disposeAll(); db.close(); }
});

it('unknown explicit native turn keeps raw and an ignored reason without publishing into the current turn', async () => {
  const db = openDb(':memory:'); const ctx = await fixture(db);
  try {
    ctx.emit({ type: 'turn.start', nativeTurnId: 'current' }); ctx.emit(start({ nativeTurnId: 'foreign' }));
    const raw = latest(ctx.store, ctx.session.id); const lookup = ctx.store.projectionContexts.get(raw.id);
    expect(lookup.status).toBe('recorded'); if (lookup.status === 'recorded') expect(lookup.context).toMatchObject({ turnId: null, ignoredReason: 'unknown-native-turn', source: { nativeTurnId: 'foreign' } });
    expect(ctx.manager.hotItems(ctx.session.id)).toEqual([]);
  } finally { await ctx.manager.disposeAll(); db.close(); }
});

it('late completed items keep their original public turn and ended observation after a new turn starts', async () => {
  const db = openDb(':memory:'); const ctx = await fixture(db);
  try {
    ctx.emit({ type: 'turn.start', nativeTurnId: 'first' }); ctx.emit({ type: 'turn.end', nativeTurnId: 'first', status: 'completed' });
    const next = await ctx.manager.send(ctx.session.id, { text: 'next input' }); ctx.emit({ type: 'turn.start', nativeTurnId: 'second' });
    const current = ctx.manager.getRuntime(ctx.session.id)?.turnId;
    ctx.emit({ type: 'item.complete', nativeTurnId: 'first', itemKey: 'late', kind: 'file.read', data: { path: 'original', text: 'late native output' } });
    const lookup = ctx.store.projectionContexts.get(latest(ctx.store, ctx.session.id).id);
    await evidence('late-turn', { next, current, after: ctx.manager.getRuntime(ctx.session.id)?.turnId, lookup });
    expect(lookup.status).toBe('recorded'); if (lookup.status === 'recorded') expect(lookup.context).toMatchObject({ turnId: ctx.sent.turnId, late: true, turnEnded: true, source: { nativeTurnId: 'first' } });
    expect(current).not.toBe(ctx.sent.turnId); expect(ctx.manager.getRuntime(ctx.session.id)?.turnId).toBe(current);
  } finally { await ctx.manager.disposeAll(); db.close(); }
});

it('privacy-restricted mapping stores only its source assignment, not a second copy of the secret data', async () => {
  const db = openDb(':memory:'); const ctx = await fixture(db);
  try {
    ctx.store.nativeEvents.restrictSession(ctx.session.id); ctx.emit(start({ data: { text: 'private original' } }));
    const raw = latest(ctx.store, ctx.session.id); const lookup = ctx.store.projectionContexts.get(raw.id);
    expect(raw.payloadCoverage).toBe('restricted'); expect(lookup.status).toBe('recorded'); expect(JSON.stringify(lookup)).not.toContain('private original');
  } finally { await ctx.manager.disposeAll(); db.close(); }
});

it('real SIGKILL and SQLite reopen preserve anonymous public identity while the original native outcome remains uncertain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-projection-context-kill-'));
  const child = fork(join(import.meta.dirname, 'fixtures/projection-context-crash.ts'), [directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', value => { stderr += String(value); }); let db: Db | undefined; let manager: SessionManager | undefined;
  try {
    const [value] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`worker exited ${code}: ${stderr}`); })]);
    const message = value as { sessionId: string; publicTurnId: string; rawId: number }; const exited = once(child, 'exit'); child.kill('SIGKILL'); const exit = await exited;
    db = openDb(join(directory, 'source.sqlite')); const store = new Store(db); manager = new SessionManager(store, { idleDisposeMin: 0 });
    const lookup = store.projectionContexts.get(message.rawId); await evidence('sigkill', { exit, stderr, message, lookup, queue: store.journal.queue(message.sessionId), raw: store.nativeEvents.get(message.rawId) });
    expect(exit[1]).toBe('SIGKILL'); expect(lookup.status).toBe('recorded'); if (lookup.status === 'recorded') expect(lookup.context).toMatchObject({ turnId: message.publicTurnId, source: { nativeTurnId: null } });
    expect(store.journal.queue(message.sessionId)[0]?.state).toBe('uncertain'); expect(store.allEvents(message.sessionId).some(event => event.kind === 'turn.completed')).toBe(false);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await manager?.disposeAll(); db?.close(); await rm(directory, { recursive: true, force: true }); }
});
