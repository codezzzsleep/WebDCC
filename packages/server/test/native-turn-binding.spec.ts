import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent, AgentId, NativeHistoryRecord } from '@webdcc/protocol';
import { openDb, type Db } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';

const answer = (nativeTurnId = 'early'): AdapterEvent => ({ type: 'item.complete', nativeTurnId,
  itemKey: 'answer', kind: 'assistant.message', data: { text: 'original answer' }, native: { source: 'controlled', turnId: nativeTurnId } });
const history = (nativeTurnId = 'early'): NativeHistoryRecord => ({ nativeSeq: 1, nativeTurnId, at: '2026-11-17T00:00:00Z',
  native: { source: 'controlled', turnId: nativeTurnId }, events: [answer(nativeTurnId), { type: 'turn.end', nativeTurnId, status: 'completed' }] });
async function rig(db: Db, agent: AgentId = 'codex') {
  const store = new Store(db); const manager = new SessionManager(store, { idleDisposeMin: 0 });
  const adapter = new FakeAdapter({ id: agent }); let callback!: (id: string, event: AdapterEvent) => void;
  adapter.onEvent = cb => { callback = cb; }; adapter.send = async () => undefined; manager.registerAdapter(adapter);
  const workspace = store.createWorkspace('early binding', tmpdir());
  const session = await manager.createSession({ workspaceId: workspace.id, agent });
  store.journal.claim({ op: 'send', sessionId: session.id, clientCommandId: 'INPUT', text: 'kept input' });
  const sent = await manager.send(session.id, { text: 'kept input' }, 'INPUT');
  return { store, manager, session, sent, emit: (event: AdapterEvent) => callback(session.id, event) };
}
async function evidence(name: string, value: unknown) {
  const directory = process.env['WDCC_TURN_BINDING_EVIDENCE_DIR'];
  if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2));
}

it.each(['codex', 'claude-code', 'dsh'] as const)('%s initial completion persists identity before hooks and reuses it after SQLite reopen', async agent => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-turn-binding-')); const path = join(directory, 'source.sqlite');
  let db = openDb(path); const initialDb = db; const ctx = await rig(db, agent); let hookBinding: string | undefined;
  ctx.manager.setHooks({ onFeed: () => undefined, onDelta: () => undefined, onUpdate: () => undefined, onStatus: () => undefined, onEvent: event => { if (event.kind === 'assistant.message') hookBinding = ctx.store.nativeHistory.turn(ctx.session.id, 'early'); } });
  try {
    ctx.emit(answer());
    const before = { binding: ctx.store.nativeHistory.turn(ctx.session.id, 'early') ?? null, owner: ctx.store.nativeOwners.get(ctx.session.id), hookBinding: hookBinding ?? null };
    await evidence(`live-${agent}`, before);
    expect(before.binding).toBe(ctx.sent.turnId); expect(hookBinding).toBe(ctx.sent.turnId);
    expect(before.owner?.activeNativeTurnId).toBe('early');
    ctx.emit({ type: 'turn.start', nativeTurnId: 'early' });
    expect(ctx.manager.getRuntime(ctx.session.id)?.turnId).toBe(ctx.sent.turnId);
    await ctx.manager.disposeAll(); db.close(); db = openDb(path); const store = new Store(db);
    const imported = store.nativeHistory.import(ctx.session.id, ctx.session.nativeId!, [history()]);
    await evidence(`reopen-${agent}`, { imported, events: store.allEvents(ctx.session.id), queue: store.journal.queue(ctx.session.id) });
    expect(store.allEvents(ctx.session.id).filter(event => event.kind === 'assistant.message')).toHaveLength(1);
    expect(imported.filter(event => event.kind === 'turn.completed').map(event => event.turnId)).toEqual([ctx.sent.turnId]);
    expect(store.journal.get('INPUT')?.state).toBe('uncertain');
    expect(store.nativeHistory.import(ctx.session.id, ctx.session.nativeId!, [history()])).toEqual([]);
  } finally { if (db.open) { if (db === initialDb) await ctx.manager.disposeAll(); db.close(); } await rm(directory, { recursive: true, force: true }); }
});

it.each([
  { type: 'item.start', nativeTurnId: 'early', itemKey: 'hot', kind: 'reasoning', data: { text: '' } },
  { type: 'item.delta', nativeTurnId: 'early', itemKey: 'hot', field: 'text', append: 'first' },
  { type: 'item.update', nativeTurnId: 'early', itemKey: 'hot', data: { text: 'updated' } },
  { type: 'item.cancel', nativeTurnId: 'early', itemKey: 'hot' },
  { type: 'turn.end', nativeTurnId: 'early', status: 'completed' },
] satisfies AdapterEvent[])('initial $type saves the accepted native identity even before turn.start', async event => {
  const db = openDb(':memory:'); const ctx = await rig(db);
  try {
    ctx.emit(event); const binding = ctx.store.nativeHistory.turn(ctx.session.id, 'early');
    await evidence(`initial-${event.type}`, { binding: binding ?? null, owner: ctx.store.nativeOwners.get(ctx.session.id) });
    expect(binding).toBe(ctx.sent.turnId);
    expect(ctx.store.nativeOwners.get(ctx.session.id)?.activeNativeTurnId).toBe('early');
  } finally { await ctx.manager.disposeAll(); db.close(); }
});

it('persisted old identities cannot bind a new active turn or overwrite its owner', async () => {
  const db = openDb(':memory:'); const ctx = await rig(db);
  try {
    ctx.store.nativeHistory.bind(ctx.session.id, 'old-native', 'old-public');
    ctx.emit(answer('old-native'));
    const old = ctx.store.allEvents(ctx.session.id).find(event => event.kind === 'assistant.message');
    await evidence('old-turn', { old, owner: ctx.store.nativeOwners.get(ctx.session.id), currentTurn: ctx.manager.getRuntime(ctx.session.id)?.turnId });
    expect(old).toMatchObject({ turnId: 'old-public', late: true });
    expect(ctx.store.nativeHistory.turn(ctx.session.id, 'early')).toBeUndefined();
    expect(ctx.store.nativeOwners.get(ctx.session.id)?.activeNativeTurnId).toBeNull();
    ctx.emit(answer()); expect(ctx.store.nativeHistory.turn(ctx.session.id, 'early')).toBe(ctx.sent.turnId);
    expect(ctx.store.nativeOwners.get(ctx.session.id)?.activeNativeTurnId).toBe('early');
  } finally { await ctx.manager.disposeAll(); db.close(); }
});

it('SQL binding failure retains raw but fences the runtime before semantic or hot publication', async () => {
  const db = openDb(':memory:'); const ctx = await rig(db); let published = 0;
  ctx.manager.setHooks({ onFeed: () => undefined, onDelta: () => undefined, onUpdate: () => undefined, onStatus: () => undefined, onEvent: event => { if (event.kind === 'assistant.message') published++; } });
  try {
    db.exec("CREATE TRIGGER reject_binding BEFORE INSERT ON native_turns BEGIN SELECT RAISE(ABORT, 'binding rejected'); END");
    let thrown: unknown; try { ctx.emit(answer()); } catch (error) { thrown = error; }
    const raw = ctx.store.nativeEvents.list(ctx.session.id).filter(record => record.channel === 'item.complete');
    await evidence('sql-failure', { thrown: thrown === undefined ? null : String(thrown), raw, owner: ctx.store.nativeOwners.get(ctx.session.id), queue: ctx.store.journal.queue(ctx.session.id), events: ctx.store.allEvents(ctx.session.id) });
    expect(thrown).toBeUndefined(); expect(raw).toHaveLength(1); expect(db.prepare('SELECT COUNT(*) AS n FROM events WHERE native_envelope_id = ?').get(raw[0]?.id)).toEqual({ n: 0 });
    expect(published).toBe(0); expect(ctx.store.nativeHistory.turn(ctx.session.id, 'early')).toBeUndefined();
    expect(ctx.store.nativeOwners.get(ctx.session.id)?.state).toBe('uncertain'); expect(ctx.store.journal.get('INPUT')?.state).toBe('uncertain');
    await expect(ctx.manager.send(ctx.session.id, { text: 'blind retry' })).rejects.toMatchObject({ statusCode: 409 });
  } finally { db.exec('DROP TRIGGER reject_binding'); await ctx.manager.disposeAll(); db.close(); }
});

it('session scope and stale generation frames cannot create an active turn binding', async () => {
  const db = openDb(':memory:'); const ctx = await rig(db);
  try {
    const identity = ctx.manager.getRuntime(ctx.session.id)!.identity;
    ctx.emit({ ...answer('session-native'), scope: 'session' });
    ctx.emit({ ...answer('stale-native'), runtime: { ...identity, generation: identity.generation - 1 } });
    expect(ctx.store.nativeHistory.turn(ctx.session.id, 'session-native')).toBeUndefined();
    expect(ctx.store.nativeHistory.turn(ctx.session.id, 'stale-native')).toBeUndefined();
    expect(ctx.store.nativeOwners.get(ctx.session.id)?.activeNativeTurnId).toBeNull();
  } finally { await ctx.manager.disposeAll(); db.close(); }
});

it('an already persisted active binding also prevents an unknown native turn from claiming its in-memory slot', async () => {
  const db = openDb(':memory:'); const ctx = await rig(db);
  try {
    ctx.store.nativeHistory.bind(ctx.session.id, 'early', ctx.sent.turnId);
    ctx.emit(answer()); ctx.emit({ ...answer('foreign'), itemKey: 'foreign-answer' });
    expect(ctx.store.nativeHistory.turn(ctx.session.id, 'foreign')).toBeUndefined();
    expect(ctx.store.allEvents(ctx.session.id).some(event => event.itemKey === 'foreign-answer')).toBe(false);
    expect(ctx.store.nativeOwners.get(ctx.session.id)?.activeNativeTurnId).toBe('early');
  } finally { await ctx.manager.disposeAll(); db.close(); }
});

it('the same native turn id in another session does not claim the current public turn', async () => {
  const db = openDb(':memory:'); const ctx = await rig(db);
  try {
    const other = ctx.store.createSession({ workspaceId: ctx.session.workspaceId, agent: 'codex' });
    ctx.store.nativeHistory.bind(other.id, 'early', 'other-public'); ctx.emit(answer());
    expect(ctx.store.nativeHistory.turn(ctx.session.id, 'early')).toBe(ctx.sent.turnId);
    expect(ctx.store.nativeHistory.turn(other.id, 'early')).toBe('other-public');
  } finally { await ctx.manager.disposeAll(); db.close(); }
});

it('actual Node SIGKILL after initial completion retains the original turn and unknown native outcome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-turn-kill-'));
  const child = fork(join(import.meta.dirname, 'fixtures/early-turn-crash.ts'), [directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); }); let db: Db | undefined;
  try {
    const [message] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`child exited ${code}: ${stderr}`); })]);
    const { sessionId, nativeId, turnId } = message as { sessionId: string; nativeId: string; turnId: string };
    const exited = once(child, 'exit'); child.kill('SIGKILL'); const exit = await exited;
    db = openDb(join(directory, 'source.sqlite')); const store = new Store(db); const manager = new SessionManager(store, { idleDisposeMin: 0 });
    try {
      const before = { binding: store.nativeHistory.turn(sessionId, 'early') ?? null, owner: store.nativeOwners.get(sessionId), command: store.journal.get('CRASH') };
      const imported = store.nativeHistory.import(sessionId, nativeId, [history()]);
      await evidence('sigkill', { exit, stderr, before, imported, events: store.allEvents(sessionId) });
      expect(exit[1]).toBe('SIGKILL'); expect(before.binding).toBe(turnId); expect(before.owner?.state).toBe('uncertain');
      expect(before.owner?.activeNativeTurnId).toBe('early'); expect(before.command?.state).toBe('uncertain');
      expect(store.allEvents(sessionId).filter(event => event.kind === 'assistant.message')).toHaveLength(1);
      expect(imported.filter(event => event.kind === 'turn.completed').map(event => event.turnId)).toEqual([turnId]);
    } finally { await manager.disposeAll(); }
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); db?.close(); await rm(directory, { recursive: true, force: true }); }
});
