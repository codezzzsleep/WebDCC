import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { Store } from '../src/store.js';
import { captureProcess } from '../src/process-identity.js';
const indexes = ['events_native_publication','events_semantic_witness','events_terminal_witness'];
it('defers optional covering-index DDL while another native executor is alive and creates it after verified process exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recovery-index-live-')); const file = join(directory, 'source.sqlite');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); let db: Db | undefined;
  try {
    await once(child, 'spawn'); const nativeProcess = captureProcess(child.pid!)!;
    db = openDb(file); const store = new Store(db); const workspace = store.createWorkspace('fixture', directory); const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const identity = store.nativeOwners.acquire('fixture-live-owner', session.id, 'codex', 'original-native'); store.nativeOwners.activate(session.id, identity, 'original-native');
    db.prepare('UPDATE native_owners SET server_pid=?,server_boot=?,server_start=? WHERE session_id=?').run(nativeProcess.pid, nativeProcess.bootId, nativeProcess.startTicks, session.id);
    store.appendEvent({ sessionId: session.id, turnId: 'original-turn', itemKey: 'original-message', kind: 'assistant.message', data: { text: 'original' } });
    const before = db.prepare('SELECT * FROM native_owners').all(); for (const name of indexes) db.exec(`DROP INDEX ${name}`); db.close();
    db = openDb(file); expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN (?,?,?)").all(...indexes)).toEqual([]);
    expect(db.prepare('SELECT * FROM native_owners').all()).toEqual(before); expect(db.prepare('SELECT data FROM events').get()).toEqual({ data: JSON.stringify({ text: 'original' }) }); db.close();
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    db = openDb(file); expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN (?,?,?)").all(...indexes)).toHaveLength(3);
  } finally { db?.close(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await rm(directory, { recursive: true, force: true }); }
});
