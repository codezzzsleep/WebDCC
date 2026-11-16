import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import { openDb, type Db } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';

function setup(db: Db, path = '/tmp') {
  const store = new Store(db); const workspace = store.createWorkspace('owner target', path);
  const first = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
  const second = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
  const old = store.nativeOwners.acquire('old-owner', first.id, 'codex', 'old-native');
  store.nativeOwners.activate(first.id, old, 'old-native'); store.nativeOwners.observe(first.id, old, 'old-turn', 200);
  store.nativeOwners.release(first.id, old, true);
  return { store, first, second, old };
}
async function evidence(name: string, value: unknown): Promise<void> {
  const directory = process.env['WDCC_OWNER_TARGET_EVIDENCE_DIR'];
  if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
}

it('a released owner reserves the requested new native target before activation, blocking another session', async () => {
  const db = openDb(':memory:');
  try {
    const { store, first, second, old } = setup(db);
    const current = store.nativeOwners.acquire('new-owner', first.id, 'codex', 'new-native');
    const pending = store.nativeOwners.get(first.id);
    let rejected: unknown;
    try { store.nativeOwners.acquire('competing-owner', second.id, 'codex', 'new-native'); } catch (error) { rejected = error; }
    await evidence('new-target', { pending, second: store.nativeOwners.get(second.id), rejected: rejected === undefined ? null : String(rejected) });
    expect(pending).toMatchObject({ nativeId: 'new-native', state: 'opening', generation: old.generation + 1, activeNativeTurnId: null, lastObservedSeq: null });
    expect(rejected).toMatchObject({ code: 'native-owner-conflict' }); expect(store.nativeOwners.get(second.id)).toBeUndefined();
    expect(() => store.nativeOwners.activate(first.id, old, 'old-native')).toThrow('运行代际');
    store.nativeOwners.activate(first.id, current, 'new-native'); expect(store.nativeOwners.get(first.id)?.nativeId).toBe('new-native');
  } finally { db.close(); }
});

it.each([undefined, ''])('an unknown target %j clears the old reservation without inventing a native identity', async nativeId => {
  const db = openDb(':memory:');
  try {
    const { store, first, second } = setup(db); store.nativeOwners.acquire('new-owner', first.id, 'codex', nativeId);
    const current = store.nativeOwners.get(first.id);
    let acquired = false;
    try { store.nativeOwners.acquire('other-owner', second.id, 'codex', 'old-native'); acquired = true; } catch { /* Recorded below; assertion rejects a stale reservation. */ }
    await evidence(`unknown-${nativeId === undefined ? 'missing' : 'empty'}`, { current, acquired, second: store.nativeOwners.get(second.id) });
    expect(current).toMatchObject({ nativeId: null, state: 'opening' }); expect(acquired).toBe(true);
  } finally { db.close(); }
});

it('an update failure rolls back the complete released owner instead of partially advancing its generation', async () => {
  const db = openDb(':memory:');
  try {
    const { store, first } = setup(db); const original = store.nativeOwners.get(first.id);
    db.exec("CREATE TEMP TRIGGER refuse_target BEFORE UPDATE OF native_id ON native_owners BEGIN SELECT RAISE(ABORT,'controlled target failure'); END");
    let rejected: unknown;
    try { store.nativeOwners.acquire('new-owner', first.id, 'codex', 'new-native'); } catch (error) { rejected = error; }
    await evidence('trigger-rollback', { original, current: store.nativeOwners.get(first.id), rejected: rejected === undefined ? null : String(rejected) });
    expect(String(rejected)).toContain('controlled target failure');
    expect(store.nativeOwners.get(first.id)).toEqual(original); db.exec('DROP TRIGGER refuse_target');
    store.nativeOwners.acquire('new-owner', first.id, 'codex', 'new-native'); await evidence('rollback', { original, recovered: store.nativeOwners.get(first.id) });
    expect(store.nativeOwners.get(first.id)).toMatchObject({ nativeId: 'new-native', generation: original!.generation + 1 });
  } finally { db.close(); }
});

it('a unique target violation rolls back both the owner update and a competing row inserted inside the transaction', async () => {
  const db = openDb(':memory:');
  try {
    const { store, first, second } = setup(db); const original = store.nativeOwners.get(first.id);
    db.prepare(`CREATE TEMP TRIGGER competing_target BEFORE UPDATE OF native_id ON native_owners
      BEGIN INSERT INTO native_owners (session_id, agent, host_id, native_id, owner_id, generation, state,
        lease_until, observed_at, server_pid, server_boot, server_start)
      VALUES ('${second.id}', NEW.agent, NEW.host_id, 'new-native', 'competitor', 1, 'opening',
        NEW.lease_until, NEW.observed_at, NEW.server_pid, NEW.server_boot, NEW.server_start); END`).run();
    let rejected: unknown;
    try { store.nativeOwners.acquire('new-owner', first.id, 'codex', 'new-native'); } catch (error) { rejected = error; }
    await evidence('unique-rollback', { original, current: store.nativeOwners.get(first.id), competing: store.nativeOwners.get(second.id),
      rejected: rejected === undefined ? null : String(rejected), code: (rejected as { code?: string } | undefined)?.code });
    expect(rejected).toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
    expect(store.nativeOwners.get(first.id)).toEqual(original); expect(store.nativeOwners.get(second.id)).toBeUndefined();
    db.exec('DROP TRIGGER competing_target'); store.nativeOwners.acquire('new-owner', first.id, 'codex', 'new-native');
    expect(store.nativeOwners.get(first.id)?.nativeId).toBe('new-native');
  } finally { db.close(); }
});

it('another SQLite connection and a reopened database see the new target reservation while it is opening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-owner-target-')); const file = join(directory, 'db.sqlite'); let db = openDb(file); const otherDb = openDb(file);
  try {
    const { store, first, second } = setup(db, directory); store.nativeOwners.acquire('new-owner', first.id, 'codex', 'new-native');
    const peer = new Store(otherDb); let rejected: unknown;
    try { peer.nativeOwners.acquire('competing-owner', second.id, 'codex', 'new-native'); } catch (error) { rejected = error; }
    const seen = peer.nativeOwners.get(first.id); db.close(); db = openDb(file); const reopened = new Store(db).nativeOwners.get(first.id);
    await evidence('sqlite-reopen', { seen, reopened, second: peer.nativeOwners.get(second.id), rejected: rejected === undefined ? null : String(rejected) });
    expect(rejected).toMatchObject({ code: 'native-owner-conflict' }); expect(seen).toMatchObject({ nativeId: 'new-native', state: 'opening' }); expect(reopened).toEqual(seen);
  } finally { if (db.open) db.close(); otherDb.close(); await rm(directory, { recursive: true, force: true }); }
});

it('a second manager cannot start a competing resume while the released session opens its new native target', async () => {
  const db = openDb(':memory:'); const store = new Store(db); const firstManager = new SessionManager(store, { idleDisposeMin: 0 });
  const firstAdapter = new FakeAdapter({ id: 'codex' }); firstManager.registerAdapter(firstAdapter);
  let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
  const secondManager = new SessionManager(store, { idleDisposeMin: 0 }); const secondAdapter = new FakeAdapter({ id: 'codex' }); let competingResumes = 0;
  secondAdapter.resume = async () => { competingResumes++; }; secondManager.registerAdapter(secondAdapter);
  let pending: Promise<unknown> | undefined;
  try {
    const workspace = store.createWorkspace('manager target', '/tmp'); const session = await firstManager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    await firstManager.dispose(session.id); store.updateSession(session.id, { nativeId: 'new-native' });
    firstAdapter.resume = async () => { await gate; };
    pending = firstManager.slashCommands(session.id); void pending.catch(() => undefined);
    await expect.poll(() => store.nativeOwners.get(session.id)?.state).toBe('opening');
    const other = store.createSession({ workspaceId: workspace.id, agent: 'codex' }); store.updateSession(other.id, { nativeId: 'new-native' });
    let rejected: unknown;
    try { await secondManager.slashCommands(other.id); } catch (error) { rejected = error; }
    await evidence('manager-reservation', { current: store.nativeOwners.get(session.id), competing: store.nativeOwners.get(other.id), competingResumes,
      rejected: rejected === undefined ? null : String(rejected) });
    expect(rejected).toMatchObject({ code: 'native-owner-conflict' }); expect(competingResumes).toBe(0);
    open(); await pending;
  } finally { open(); await pending?.catch(() => undefined); await firstManager.disposeAll(); await secondManager.disposeAll(); db.close(); }
});
it('SIGKILL during opening preserves the requested target and recovery retains uncertain ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-opening-target-'));
  const child = fork(join(import.meta.dirname, 'fixtures/owner-target-opening.ts'), [directory],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.setEncoding('utf8'); child.stderr!.on('data', chunk => { stderr += String(chunk); });
  let db: Db | undefined;
  try {
    const ready = new Promise<{ sessionId: string; otherId: string; generation: number }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`opening fixture exited before ready (${code}/${signal}): ${stderr}`)));
      child.once('message', message => resolve(message as { sessionId: string; otherId: string; generation: number }));
    });
    const identity = await ready; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    db = openDb(join(directory, 'opening.sqlite')); const store = new Store(db);
    const beforeRecovery = store.nativeOwners.get(identity.sessionId); store.nativeOwners.recoverableSessions();
    const recovered = store.nativeOwners.get(identity.sessionId); let rejected: unknown;
    try { store.nativeOwners.acquire('competing', identity.otherId, 'codex', 'new-native'); } catch (error) { rejected = error; }
    await evidence('opening-sigkill', { identity, beforeRecovery, recovered, competing: store.nativeOwners.get(identity.otherId),
      rejected: rejected === undefined ? null : String(rejected), exitCode: child.exitCode, signalCode: child.signalCode, stderr });
    expect(beforeRecovery).toMatchObject({ nativeId: 'new-native', state: 'opening', generation: identity.generation });
    expect(recovered).toMatchObject({ nativeId: 'new-native', state: 'uncertain', generation: identity.generation });
    expect(rejected).toMatchObject({ code: 'native-owner-conflict' });
    expect(() => store.nativeOwners.acquire('new', identity.sessionId, 'codex', 'new-native')).toThrow('待核对');
    expect(store.allEvents(identity.sessionId)).toHaveLength(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    db?.close(); await rm(directory, { recursive: true, force: true });
  }
});
