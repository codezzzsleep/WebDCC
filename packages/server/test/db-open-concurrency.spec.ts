import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, openDb } from '../src/db.js';
import { Store } from '../src/store.js';

async function evidence(name: string, value: unknown): Promise<void> {
  const directory = process.env['WDCC_DB_STARTUP_EVIDENCE_DIR'];
  if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
}

interface Sample { ok: boolean; version?: number; code?: string }
interface Finished { phase: string; pid: number; samples: Sample[] }
function writer(file: string, children: ChildProcess[]): { ready: Promise<void>; result: Promise<Finished>; start: () => void } {
  const child = fork(join(import.meta.dirname, 'fixtures/db-open-writer.ts'), [file],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child); let stderr = '';
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
  const ready = new Promise<void>((resolve, reject) => {
    child.on('message', (message: Finished) => { if (message.phase === 'ready') resolve(); });
    child.on('error', reject); child.on('exit', code => { reject(new Error(`database writer exited ${code} before ready: ${stderr}`)); });
  });
  const result = new Promise<Finished>((resolve, reject) => {
    let finished: Finished | undefined;
    child.on('message', (message: Finished) => { if (message.phase === 'finished') finished = message; });
    child.on('error', reject); child.on('exit', code => {
      if (code === 0 && finished !== undefined) resolve(finished);
      else reject(new Error(`database writer exited ${code} without results: ${stderr}`));
    });
  });
  void result.catch(() => undefined);
  return { ready, result, start: () => { child.send('start'); } };
}

it('two real concurrent Node processes reopen the initialized SQLite without losing commands, queue, owners or native evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-db-open-')); const file = join(directory, 'db.sqlite'); const children: ChildProcess[] = [];
  let db = openDb(file);
  try {
    const store = new Store(db); const workspace = store.createWorkspace('preserved', directory); const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const identity = store.nativeOwners.acquire('owner', session.id, 'codex', 'native-preserved');
    store.nativeOwners.activate(session.id, identity, 'native-preserved'); store.nativeOwners.observe(session.id, identity, 'native-turn', 200);
    store.journal.claim({ op: 'send', clientCommandId: 'db-open-command', sessionId: session.id, text: 'original\r\ntext' });
    store.journal.enqueue('db-open-command', session.id, 'queue-turn', { text: 'original\r\ntext', images: [{ fileId: 'preserved-reference' }] });
    store.journal.state('db-open-command', 'queued', { ok: true, value: { turnId: 'queue-turn', queued: true } });
    store.appendEvent({ sessionId: session.id, turnId: 'old-turn', itemKey: 'old-item', kind: 'user.message', data: { text: 'existing native input' }, native: { threadId: 'native-preserved' } });
    const snapshot = () => Object.fromEntries(['workspaces', 'sessions', 'command_journal', 'input_queue', 'native_owners', 'events', 'feed']
      .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    const before = snapshot(); db.close();
    const writers = [writer(file, children), writer(file, children)]; await Promise.all(writers.map(value => value.ready));
    writers.forEach(value => value.start()); const results = await Promise.all(writers.map(value => value.result));
    db = openDb(file); const after = snapshot();
    await evidence('concurrent-open', { results, before, after });
    const samples = results.flatMap(value => value.samples);
    expect(samples).toHaveLength(40); expect(samples.filter(sample => !sample.ok)).toEqual([]);
    expect(samples.every(sample => sample.version === CURRENT_SCHEMA_VERSION)).toBe(true);
    expect(after).toEqual(before); expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (db.open) db.close(); await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('future or incomplete schemas remain refused without rewriting the original database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-db-refusal-')); const file = join(directory, 'db.sqlite');
  try {
    const db = openDb(file); db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`); db.close();
    const digest = async () => createHash('sha256').update(await readFile(file)).digest('hex');
    const beforeFuture = await digest(); expect(() => openDb(file)).toThrow('高于支持'); expect(await digest()).toBe(beforeFuture);
    const old = new Database(file); old.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`); old.exec('DROP TABLE native_history_partial_items'); old.close();
    const beforeIncomplete = await digest(); expect(() => openDb(file)).toThrow('历史部分阶段证据不完整'); expect(await digest()).toBe(beforeIncomplete);
    await evidence('schema-refusal', { futureUnchanged: true, incompleteUnchanged: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('an initialization write failure rolls back and preserves the original session and queued command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-db-rollback-')); const file = join(directory, 'db.sqlite');
  try {
    const db = openDb(file); const store = new Store(db); const workspace = store.createWorkspace('rollback', directory); const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    store.journal.claim({ op: 'send', clientCommandId: 'rollback-command', sessionId: session.id, text: 'kept' });
    db.prepare('UPDATE sessions SET permission_state = NULL WHERE id = ?').run(session.id);
    db.exec("CREATE TRIGGER refuse_initialization BEFORE UPDATE OF permission_state ON sessions BEGIN SELECT RAISE(ABORT, 'controlled initialization failure'); END");
    const before = db.prepare('SELECT * FROM sessions').all(); const command = store.journal.get('rollback-command'); db.close();
    expect(() => openDb(file)).toThrow('controlled initialization failure');
    const reopened = new Database(file);
    try {
      expect(reopened.prepare('SELECT * FROM sessions').all()).toEqual(before);
      expect(new Store(reopened).journal.get('rollback-command')).toEqual(command);
      expect(reopened.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      await evidence('initialization-rollback', { before, after: reopened.prepare('SELECT * FROM sessions').all(), command });
    } finally { reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
