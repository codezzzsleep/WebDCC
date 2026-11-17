import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { Command, ManagedProcessIdentity } from '@webdcc/protocol';
import { openDb, type Db } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import { FileStore } from '../src/files.js';
import { CommandDispatcher } from '../src/dispatcher.js';
import { createTestApp } from './helpers.js';

function command(store: Store, id = 'CREATE'): Command {
  const workspace = store.listWorkspaces()[0] ?? store.createWorkspace('sessionless command', tmpdir());
  return { op: 'create-session', workspaceId: workspace.id, agent: 'codex', clientCommandId: id };
}
async function evidence(name: string, value: unknown) {
  const path = process.env['WDCC_SESSIONLESS_EVIDENCE_DIR']; if (path !== undefined) await writeFile(join(path, `${name}.json`), JSON.stringify(value, null, 2));
}

it('another Manager preserves a live sessionless executor even before any native owner/session exists', async () => {
  const db = openDb(':memory:'); const store = new Store(db); const original = command(store); store.journal.claim(original);
  try {
    expect(store.journal.acquire(original.clientCommandId)).toBe(true);
    const witness = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(`command-execution:${original.clientCommandId}`) as { value: string } | undefined;
    const other = new SessionManager(store, { idleDisposeMin: 0 });
    try {
      await evidence('live-executor', { command: store.journal.get(original.clientCommandId), witness });
      expect(witness).toBeDefined(); expect(store.journal.get(original.clientCommandId)?.state).toBe('dispatching');
      expect(store.journal.acquire(original.clientCommandId)).toBe(false);
    } finally { await other.disposeAll(); }
  } finally { db.close(); }
});

it('executor identity and dispatching acquisition roll back together on a real SQL trigger failure', async () => {
  const db = openDb(':memory:'); const store = new Store(db); const original = command(store); store.journal.claim(original);
  try {
    db.exec("CREATE TRIGGER reject_execution BEFORE INSERT ON app_settings WHEN NEW.key LIKE 'command-execution:%' BEGIN SELECT RAISE(ABORT, 'execution rejected'); END");
    let rejected: unknown; try { store.journal.acquire(original.clientCommandId); } catch (error) { rejected = error; }
    await evidence('transaction-abort', { rejected: rejected === undefined ? null : String(rejected), record: store.journal.get(original.clientCommandId) });
    expect(String(rejected)).toContain('execution rejected'); expect(store.journal.get(original.clientCommandId)?.state).toBe('received');
    expect(db.prepare('SELECT value FROM app_settings WHERE key = ?').get(`command-execution:${original.clientCommandId}`)).toBeUndefined();
    db.exec('DROP TRIGGER reject_execution'); expect(store.journal.acquire(original.clientCommandId)).toBe(true);
  } finally { db.close(); }
});

it.each(['missing', 'bad-json', 'bad-shape', 'unknown-machine', 'reused-pid', 'old-boot'] as const)('%s execution witness leaves abandoned global dispatch explicitly uncertain', async kind => {
  const db = openDb(':memory:'); const store = new Store(db); const original = command(store); store.journal.claim(original); store.journal.acquire(original.clientCommandId);
  try {
    const key = `command-execution:${original.clientCommandId}`;
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    const witness = row === undefined ? undefined : JSON.parse(row.value) as { formatVersion: number; process: ManagedProcessIdentity };
    if (kind === 'missing') db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    else {
      if (witness !== undefined && kind === 'unknown-machine') witness.process.machineId = 'unverified-other-machine';
      if (witness !== undefined && kind === 'reused-pid') witness.process.startTicks = `${Number(witness.process.startTicks) + 1}`;
      if (witness !== undefined && kind === 'old-boot') witness.process.bootId = 'previous-boot';
      const value = kind === 'bad-json' ? '{invalid' : kind === 'bad-shape' ? JSON.stringify({ formatVersion: 1, process: { pid: 'invalid', startTicks: {} } }) : JSON.stringify(witness ?? { formatVersion: 1, process: null });
      db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
    }
    store.journal.recover([]); await evidence(kind, store.journal.get(original.clientCommandId));
    expect(store.journal.get(original.clientCommandId)?.state).toBe('uncertain'); expect(store.journal.acquire(original.clientCommandId)).toBe(false);
    expect(store.journal.get(original.clientCommandId)?.payload).toEqual(original);
  } finally { db.close(); }
});

it('received and terminal global commands retain their actual result and remain untouched by recovery', () => {
  const db = openDb(':memory:'); const store = new Store(db);
  try {
    for (const state of ['received', 'completed', 'failed', 'cancelled', 'uncertain'] as const) {
      const original = command(store, state); store.journal.claim(original); store.journal.state(state, state, { ok: state === 'completed', original: state });
    }
    const before = db.prepare('SELECT * FROM command_journal ORDER BY command_id').all(); store.journal.recover([]);
    expect(db.prepare('SELECT * FROM command_journal ORDER BY command_id').all()).toEqual(before);
  } finally { db.close(); }
});

it('100 concurrent actual HTTP session creations share one live executor and one native invocation', async () => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: 'codex' }); const create = adapter.create.bind(adapter);
  let calls = 0; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  adapter.create = async opts => { calls++; await gate; return create(opts); }; ctx.manager.registerAdapter(adapter);
  const original = command(ctx.store); const invoke = () => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: original } });
  let other: SessionManager | undefined;
  try {
    const pending = Array.from({ length: 100 }, invoke); await expect.poll(() => calls).toBe(1);
    other = new SessionManager(ctx.store, { idleDisposeMin: 0 }); expect(ctx.store.journal.get(original.clientCommandId)?.state).toBe('dispatching');
    release(); const results = await Promise.all(pending); await evidence('100-http', { calls, responses: results.map(response => ({ status: response.statusCode, body: response.json() })), record: ctx.store.journal.get(original.clientCommandId) });
    expect(calls).toBe(1); expect(new Set(results.map(response => response.body)).size).toBe(1);
    expect(ctx.store.journal.get(original.clientCommandId)?.state).toBe('completed');
    expect((await invoke()).json()).toEqual(results[0]!.json());
  } finally { release(); await other?.disposeAll(); await ctx.close(); }
});

it.each(['codex', 'claude-code', 'dsh'] as const)('%s actual SIGKILL during create returns uncertain after DB reopen without a new native invocation', async agent => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-sessionless-crash-'));
  const child = fork(join(import.meta.dirname, 'fixtures/session-create-crash.ts'), [directory, agent], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', value => { stderr += String(value); }); let db: Db | undefined; let manager: SessionManager | undefined;
  try {
    const [value] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`worker exited ${code}: ${stderr}`); })]);
    const message = value as { command: Command; sessionId: string }; const exited = once(child, 'exit'); child.kill('SIGKILL'); const exit = await exited;
    db = openDb(join(directory, 'source.sqlite')); const store = new Store(db); manager = new SessionManager(store, { idleDisposeMin: 0 });
    const files = new FileStore(directory, store); await files.init(); const adapter = new FakeAdapter({ id: agent }); let creates = 0;
    adapter.create = async () => { creates++; throw new Error('blind native resend'); }; manager.registerAdapter(adapter);
    const dispatcher = new CommandDispatcher(store, manager, files); const result = await dispatcher.dispatch(message.command);
    await evidence(`sigkill-${agent}`, { exit, stderr, message, record: store.journal.get(message.command.clientCommandId), result, creates, owner: store.nativeOwners.get(message.sessionId) });
    expect(exit[1]).toBe('SIGKILL'); expect(result).toMatchObject({ ok: false, code: 'uncertain' }); expect(creates).toBe(0);
    expect(store.journal.get(message.command.clientCommandId)?.state).toBe('uncertain');
    expect(await dispatcher.dispatch({ ...message.command, agent: agent === 'codex' ? 'dsh' : 'codex' } as Command)).toMatchObject({ ok: false, code: 'command-conflict' });
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await manager?.disposeAll(); db?.close(); await rm(directory, { recursive: true, force: true }); }
});

it('two actual Node processes recover an orphaned global command once without opening native work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-sessionless-concurrent-')); const path = join(directory, 'source.sqlite');
  let db: Db | undefined = openDb(path); const store = new Store(db); const original = command(store);
  store.journal.claim(original); store.journal.acquire(original.clientCommandId);
  // A recorded PID with different startTicks is a verifiably different process.
  const key = `command-execution:${original.clientCommandId}`;
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string };
  const witness = JSON.parse(row.value) as { process: ManagedProcessIdentity }; witness.process.startTicks = `${Number(witness.process.startTicks) + 1}`;
  db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(JSON.stringify(witness), key); db.close(); db = undefined;
  const children = Array.from({ length: 2 }, () => fork(join(import.meta.dirname, 'fixtures/session-create-recover.ts'), [path, original.clientCommandId],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  const stderr: string[] = ['', '']; children.forEach((child, index) => child.stderr?.on('data', value => { stderr[index] += String(value); }));
  try {
    const ready = children.map(child => Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`recover worker exited ${code}`); })]));
    await Promise.all(ready); const completed = children.map(child => once(child, 'message')); const exited = children.map(child => once(child, 'exit'));
    for (const child of children) child.send('recover'); const results = await Promise.all(completed); const exits = await Promise.all(exited);
    db = openDb(path); const record = new Store(db).journal.get(original.clientCommandId);
    await evidence('two-process-recovery', { results, exits, stderr, record });
    expect(results.every(([value]) => (value as { state: string }).state === 'uncertain')).toBe(true);
    expect(exits.every(([code]) => code === 0)).toBe(true); expect(record?.state).toBe('uncertain'); expect(record?.payload).toEqual(original);
  } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); db?.close(); await rm(directory, { recursive: true, force: true }); }
});

it('actual HTTP acquisition write failure keeps received, performs no native creation, and permits the original retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-sessionless-http-')); const path = join(directory, 'source.sqlite');
  const ctx = await createTestApp({}, undefined, {}, { dbPath: path }); const db = openDb(path);
  const adapter = new FakeAdapter({ id: 'codex' }); const create = adapter.create.bind(adapter); let calls = 0;
  adapter.create = async opts => { calls++; return create(opts); }; ctx.manager.registerAdapter(adapter); const original = command(ctx.store);
  const invoke = () => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: original } });
  try {
    db.exec("CREATE TRIGGER reject_execution BEFORE INSERT ON app_settings WHEN NEW.key LIKE 'command-execution:%' BEGIN SELECT RAISE(ABORT, 'execution rejected'); END");
    const failed = await invoke(); await evidence('http-write-failure', { status: failed.statusCode, calls, command: ctx.store.journal.get(original.clientCommandId) });
    expect(failed.statusCode).toBe(500); expect(calls).toBe(0); expect(ctx.store.journal.get(original.clientCommandId)?.state).toBe('received');
    db.exec('DROP TRIGGER reject_execution'); const retried = await invoke();
    expect(retried.statusCode).toBe(200); expect(retried.json()).toMatchObject({ ok: true, value: { sessionId: expect.any(String) } }); expect(calls).toBe(1);
  } finally { await ctx.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

it('another real Node recovery process preserves a currently live command executor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-sessionless-live-')); const path = join(directory, 'source.sqlite'); const db = openDb(path);
  const store = new Store(db); const original = command(store); store.journal.claim(original); store.journal.acquire(original.clientCommandId);
  const child = fork(join(import.meta.dirname, 'fixtures/session-create-recover.ts'), [path, original.clientCommandId], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', value => { stderr += String(value); });
  try {
    await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`worker exited ${code}: ${stderr}`); })]);
    const completed = once(child, 'message'); const exited = once(child, 'exit'); child.send('recover'); const [result] = await completed; const exit = await exited;
    await evidence('cross-process-live', { result, exit, stderr, command: store.journal.get(original.clientCommandId) });
    expect(result).toMatchObject({ state: 'dispatching' }); expect(exit[0]).toBe(0); expect(store.journal.get(original.clientCommandId)?.state).toBe('dispatching');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); db.close(); await rm(directory, { recursive: true, force: true }); }
});

it('unfiltered recovery preserves the live global executor and marks only the legacy orphan uncertain', () => {
  const db = openDb(':memory:'); const store = new Store(db);
  try {
    const live = command(store, 'LIVE'); const orphan = command(store, 'ORPHAN'); const accepted = command(store, 'LEGACY-ACCEPTED');
    store.journal.claim(live); store.journal.acquire(live.clientCommandId); store.journal.claim(orphan);
    db.prepare("UPDATE command_journal SET state = 'dispatching' WHERE command_id = ?").run(orphan.clientCommandId);
    store.journal.claim(accepted); store.journal.state(accepted.clientCommandId, 'native-accepted');
    store.journal.recover(); expect(store.journal.get(live.clientCommandId)?.state).toBe('dispatching'); expect(store.journal.get(orphan.clientCommandId)?.state).toBe('uncertain');
    expect(store.journal.get(accepted.clientCommandId)?.state).toBe('uncertain');
  } finally { db.close(); }
});
