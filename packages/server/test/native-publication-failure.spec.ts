import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent, AgentId } from '@webdcc/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';

async function fixture(agent: AgentId = 'codex') {
  const db = openDb(':memory:'); const store = new Store(db); const manager = new SessionManager(store, { idleDisposeMin: 0 }); const adapter = new FakeAdapter({ id: agent });
  let callback!: (id: string, event: AdapterEvent) => void; const disposed = vi.fn(async () => undefined); const send = vi.fn(async () => undefined);
  adapter.onEvent = cb => { callback = cb; }; adapter.send = send; adapter.dispose = disposed; manager.registerAdapter(adapter);
  const workspace = store.createWorkspace('publication failure', tmpdir()); const session = await manager.createSession({ workspaceId: workspace.id, agent });
  const commandId = 'original-input-command'; store.journal.claim({ op: 'send', clientCommandId: commandId, sessionId: session.id, text: 'original input' }); store.journal.acquire(commandId);
  const sent = await manager.send(session.id, { text: 'original input' }, commandId); const runtime = manager.getRuntime(session.id)!;
  return { db, store, manager, adapter, session, sent, commandId, runtime, send, disposed,
    emit: (event: AdapterEvent) => callback(session.id, { ...event, runtime: event.runtime ?? runtime.identity }),
    close: async () => { db.exec('DROP TRIGGER IF EXISTS reject_publication'); await manager.disposeAll(); db.close(); } };
}
const complete: Extract<AdapterEvent, { type: 'item.complete' }> = { type: 'item.complete', itemKey: 'original answer', kind: 'assistant.message', data: { text: 'original completed answer' }, native: { message_id: 'original message', agent_id: 'original actor', parent_tool_use_id: 'original parent' } };
async function evidence(name: string, report: unknown) {
  const directory = process.env['WDCC_PUBLICATION_FAILURE_EVIDENCE_DIR']; if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify(report, null, 2));
}

it.each(['codex', 'claude-code', 'dsh'] as const)('%s real SQLite publication failure retains raw, isolates current owner/input and never becomes a native callback error', async agent => {
  const ctx = await fixture(agent);
  try {
    const queued = await ctx.manager.send(ctx.session.id, { text: 'keep queued' });
    const before = ctx.store.journal.queue(ctx.session.id);
    ctx.db.exec("CREATE TRIGGER reject_publication BEFORE INSERT ON events WHEN NEW.kind = 'assistant.message' BEGIN SELECT RAISE(ABORT, 'publication failed'); END");
    let escaped: unknown; try { ctx.emit(complete); } catch (error) { escaped = error; }
    const raw = ctx.store.nativeEvents.list(ctx.session.id, 0, 500).at(-1)!;
    await evidence(agent, { escaped: escaped === undefined ? null : String(escaped), before, after: ctx.store.journal.queue(ctx.session.id), raw: ctx.store.nativeEvents.get(raw.id), owner: ctx.store.nativeOwners.get(ctx.session.id), runtime: { status: ctx.runtime.status, disposing: ctx.runtime.disposing }, events: ctx.store.allEvents(ctx.session.id), calls: { send: ctx.send.mock.calls.length, disposed: ctx.disposed.mock.calls.length } });
    expect(escaped).toBeUndefined(); expect(ctx.runtime).toMatchObject({ disposing: true, status: 'error' }); expect(ctx.store.nativeOwners.get(ctx.session.id)?.state).toBe('uncertain');
    expect(ctx.store.journal.queue(ctx.session.id)).toEqual([expect.objectContaining({ turnId: ctx.sent.turnId, state: 'uncertain', input: { text: 'original input' } }), expect.objectContaining({ turnId: queued.turnId, state: 'queued', input: { text: 'keep queued' } })]);
    expect(ctx.store.nativeEvents.get(raw.id)?.payload).toMatchObject(complete); expect(ctx.send).toHaveBeenCalledTimes(1); expect(ctx.disposed).toHaveBeenCalledTimes(1);
    expect(ctx.store.allEvents(ctx.session.id).some(event => event.kind === 'assistant.message' || event.kind === 'turn.completed')).toBe(false);
    expect(ctx.store.allEvents(ctx.session.id).some(event => event.kind === 'notice' && (event.data as { nativeType?: string }).nativeType === 'runtime-unobserved')).toBe(true);
  } finally { await ctx.close(); }
});

it('pending settle action is cancelled by a later SQLite failure and cannot finish or resend the uncertain input', async () => {
  const ctx = await fixture();
  try {
    ctx.emit({ type: 'turn.end', status: 'completed' }); expect(ctx.runtime.finishAction).not.toBeNull();
    ctx.db.exec("CREATE TRIGGER reject_publication BEFORE INSERT ON events WHEN NEW.kind = 'assistant.message' BEGIN SELECT RAISE(ABORT, 'publication failed'); END");
    let escaped: unknown; try { ctx.emit(complete); } catch (error) { escaped = error; }
    await evidence('settle-cancel', { escaped: escaped === undefined ? null : String(escaped), timer: ctx.runtime.finishTimer !== null, action: ctx.runtime.finishAction !== null, queue: ctx.store.journal.queue(ctx.session.id) });
    expect(escaped).toBeUndefined(); expect(ctx.runtime.finishAction).toBeNull(); expect(ctx.runtime.finishTimer).toBeNull();
    expect(ctx.store.journal.queue(ctx.session.id)[0]?.state).toBe('uncertain'); expect(ctx.store.allEvents(ctx.session.id).some(event => event.kind === 'turn.completed')).toBe(false);
  } finally { await ctx.close(); }
});

it('a SQLite error inside the actual deferred completion action is isolated at the same boundary', async () => {
  const ctx = await fixture();
  try {
    ctx.db.exec("CREATE TRIGGER reject_publication BEFORE INSERT ON events WHEN NEW.kind = 'turn.completed' BEGIN SELECT RAISE(ABORT, 'terminal publication failed'); END");
    ctx.emit({ type: 'turn.end', status: 'completed' }); const action = ctx.runtime.finishAction!;
    let escaped: unknown; try { action(); } catch (error) { escaped = error; }
    await evidence('deferred-terminal', { escaped: escaped === undefined ? null : String(escaped), queue: ctx.store.journal.queue(ctx.session.id), owner: ctx.store.nativeOwners.get(ctx.session.id), events: ctx.store.allEvents(ctx.session.id) });
    expect(escaped).toBeUndefined(); expect(ctx.runtime.disposing).toBe(true); expect(ctx.store.journal.queue(ctx.session.id)[0]?.state).toBe('uncertain');
    expect(ctx.store.allEvents(ctx.session.id).some(event => event.kind === 'turn.completed')).toBe(false);
  } finally { await ctx.close(); }
});

it('non-SQLite failures keep the existing Adapter error path', async () => {
  const ctx = await fixture(); const error = new Error('original non-storage error');
  try {
    ctx.manager.setHooks({ onFeed: () => undefined, onStatus: () => undefined, onDelta: () => undefined, onUpdate: () => undefined, onEvent: () => { throw error; } });
    expect(() => ctx.emit(complete)).toThrow(error); expect(ctx.runtime.disposing).toBe(false); expect(ctx.disposed).not.toHaveBeenCalled();
  } finally { ctx.manager.setHooks({ onFeed: () => undefined, onStatus: () => undefined, onDelta: () => undefined, onUpdate: () => undefined, onEvent: () => undefined }); await ctx.close(); }
});

it.each(['stale-generation', 'other-adapter'] as const)('%s raw write failure cannot fence the current native writer', async kind => {
  const ctx = await fixture(); let otherCallback!: (id: string, event: AdapterEvent) => void;
  try {
    const other = new FakeAdapter({ id: 'dsh' }); other.onEvent = cb => { otherCallback = cb; }; ctx.manager.registerAdapter(other);
    const before = { owner: ctx.store.nativeOwners.get(ctx.session.id), queue: ctx.store.journal.queue(ctx.session.id) };
    ctx.db.exec("CREATE TRIGGER reject_publication BEFORE INSERT ON native_event_envelopes BEGIN SELECT RAISE(ABORT, 'raw unavailable'); END");
    if (kind === 'stale-generation') ctx.emit({ ...complete, runtime: { ...ctx.runtime.identity, generation: ctx.runtime.identity.generation - 1 } });
    else otherCallback(ctx.session.id, complete);
    const after = { owner: ctx.store.nativeOwners.get(ctx.session.id), queue: ctx.store.journal.queue(ctx.session.id) };
    await evidence(kind, { before, after, disposing: ctx.runtime.disposing, disposed: ctx.disposed.mock.calls.length, rawNotRecorded: true });
    expect(after).toEqual(before); expect(ctx.runtime.disposing).toBe(false); expect(ctx.disposed).not.toHaveBeenCalled();
  } finally { await ctx.close(); }
});

it.each(['cancelled', 'completed'] as const)('%s input cannot be overwritten uncertain by a later publication failure', async state => {
  const ctx = await fixture();
  try {
    ctx.store.journal.inputState(ctx.sent.turnId, state);
    ctx.db.exec("CREATE TRIGGER reject_publication BEFORE INSERT ON events WHEN NEW.kind = 'assistant.message' BEGIN SELECT RAISE(ABORT, 'publication failed'); END");
    ctx.emit(complete); expect(ctx.db.prepare('SELECT state FROM input_queue WHERE turn_id = ?').get(ctx.sent.turnId)).toEqual({ state });
    expect(ctx.store.journal.get(ctx.commandId)?.state).toBe(state);
    expect(ctx.runtime.disposing).toBe(true);
  } finally { await ctx.close(); }
});

it('late native admission cannot change an input back from uncertain after its output publication failed', async () => {
  const db = openDb(':memory:'); const store = new Store(db); const manager = new SessionManager(store, { idleDisposeMin: 0 }); const adapter = new FakeAdapter({ id: 'claude-code' });
  let callback!: (id: string, event: AdapterEvent) => void; let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); adapter.onEvent = cb => { callback = cb; }; adapter.dispose = async () => undefined;
  adapter.send = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); }; manager.registerAdapter(adapter);
  const workspace = store.createWorkspace('late admission', tmpdir()); const session = await manager.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
  const commandId = 'original-pending-command'; store.journal.claim({ op: 'send', clientCommandId: commandId, sessionId: session.id, text: 'original pending input' }); store.journal.acquire(commandId);
  const pending = manager.send(session.id, { text: 'original pending input' }, commandId).then(value => ({ value }), error => ({ error: String(error) }));
  try {
    await started; const runtime = manager.getRuntime(session.id)!; const turnId = runtime.turnId!;
    db.exec("CREATE TRIGGER reject_publication BEFORE INSERT ON events WHEN NEW.kind = 'assistant.message' BEGIN SELECT RAISE(ABORT, 'publication failed'); END");
    callback(session.id, complete); expect(store.journal.queue(session.id)[0]?.state).toBe('uncertain'); release(); const result = await pending;
    await evidence('late-admission', { result, queue: store.journal.queue(session.id), owner: store.nativeOwners.get(session.id), turnId });
    expect(store.journal.queue(session.id)[0]?.state).toBe('uncertain'); expect(store.journal.get(commandId)?.state).toBe('uncertain');
  } finally { release?.(); await pending; db.exec('DROP TRIGGER IF EXISTS reject_publication'); await manager.disposeAll(); db.close(); }
});

it('real SIGKILL and SQLite reopen preserve raw output and both explicit uncertain states after the publication fence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-publication-kill-'));
  const child = fork(join(import.meta.dirname, 'fixtures/publication-failure-crash.ts'), [directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', value => { stderr += String(value); });
  try {
    const [value] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`worker exited ${code}: ${stderr}`); })]);
    const message = value as { sessionId: string; turnId: string; escaped: string | null; rawId: number }; const exited = once(child, 'exit'); child.kill('SIGKILL'); const exit = await exited;
    const db = openDb(join(directory, 'source.sqlite')); const store = new Store(db); const manager = new SessionManager(store, { idleDisposeMin: 0 });
    try {
      const report = { message, exit, stderr, sqlite: db.prepare('SELECT sqlite_version() AS version').get(), raw: store.nativeEvents.get(message.rawId), queue: store.journal.queue(message.sessionId), owner: store.nativeOwners.get(message.sessionId), events: store.allEvents(message.sessionId) };
      await evidence('sigkill', report); expect(message.escaped).toBeNull(); expect(exit[1]).toBe('SIGKILL'); expect(report.queue[0]?.state).toBe('uncertain'); expect(report.owner?.state).toBe('uncertain');
      expect(report.raw?.payload).toMatchObject({ type: 'item.complete', itemKey: 'original answer', data: { text: 'original completed answer' } });
      expect(report.events.some(event => event.kind === 'turn.completed' || event.kind === 'assistant.message')).toBe(false);
      await manager.disposeAll(); db.close(); const output = process.env['WDCC_PUBLICATION_FAILURE_EVIDENCE_DIR']; if (output !== undefined) await copyFile(join(directory, 'source.sqlite'), join(output, 'sigkill-source.sqlite'));
    } catch (error) { await manager.disposeAll(); if (db.open) db.close(); throw error; }
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});

it('an obsolete settle callback cannot complete a later turn in the same runtime', async () => {
  const ctx = await fixture();
  try {
    ctx.emit({ type: 'turn.start', nativeTurnId: 'first' }); ctx.emit({ type: 'turn.end', status: 'completed', nativeTurnId: 'first' }); const oldAction = ctx.runtime.finishAction!;
    ctx.emit({ type: 'turn.start', nativeTurnId: 'second' }); const nextTurn = ctx.runtime.turnId; const before = ctx.store.allEvents(ctx.session.id);
    oldAction(); expect(ctx.runtime.turnId).toBe(nextTurn); expect(ctx.store.allEvents(ctx.session.id)).toEqual(before); expect(ctx.runtime.disposing).toBe(false);
  } finally { await ctx.close(); }
});

it('continued DB write failure retains an in-memory fence without claiming durable uncertain or a saved notice', async () => {
  const ctx = await fixture();
  try {
    ctx.db.exec("CREATE TRIGGER reject_publication BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'all semantic writes unavailable'); END");
    ctx.db.exec("CREATE TRIGGER reject_queue_update BEFORE UPDATE ON input_queue BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END");
    ctx.db.exec("CREATE TRIGGER reject_owner_update BEFORE UPDATE ON native_owners BEGIN SELECT RAISE(ABORT, 'owner unavailable'); END");
    const before = { owner: ctx.store.nativeOwners.get(ctx.session.id), queue: ctx.store.journal.queue(ctx.session.id) };
    ctx.emit(complete); const after = { owner: ctx.store.nativeOwners.get(ctx.session.id), queue: ctx.store.journal.queue(ctx.session.id) };
    await evidence('continued-db-failure', { before, after, runtime: { disposing: ctx.runtime.disposing, status: ctx.runtime.status }, events: ctx.store.allEvents(ctx.session.id) });
    expect(after).toEqual(before); expect(ctx.runtime).toMatchObject({ disposing: true, status: 'error' });
    await expect(ctx.manager.send(ctx.session.id, { text: 'must not resend' })).rejects.toThrow(); expect(ctx.send).toHaveBeenCalledTimes(1);
  } finally { ctx.db.exec('DROP TRIGGER IF EXISTS reject_queue_update; DROP TRIGGER IF EXISTS reject_owner_update'); await ctx.close(); }
});
