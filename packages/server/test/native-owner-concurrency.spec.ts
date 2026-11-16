import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentId } from '@webdcc/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

interface Reply { trial: number; pid: number; identity?: unknown; code?: string; statusCode?: number; resumes: number;
  body?: { ok: boolean; code?: string; error?: string }; journal?: { state: string }; error?: string }
function message(child: ChildProcess, stderr: () => string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`owner writer message timeout: ${stderr()}`)); }, 10_000);
    const received = (value: unknown) => { cleanup(); resolve(value as Reply); };
    const exited = (code: number | null, signal: string | null) => { cleanup(); reject(new Error(`owner writer exit ${code}/${signal}: ${stderr()}`)); };
    const cleanup = () => { clearTimeout(timer); child.off('message', received); child.off('exit', exited); child.off('error', reject); };
    child.once('message', received); child.once('exit', exited); child.once('error', reject);
  });
}
async function evidence(name: string, value: unknown): Promise<void> {
  const directory = process.env['WDCC_OWNER_CONCURRENCY_EVIDENCE_DIR'];
  if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
}

it.each(['api', 'http'] as const)('%s concurrent owner acquisition reads the winner and rejects the loser before native resume', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-owner-concurrent-')); const db = openDb(join(directory, 'owners.sqlite')); const store = new Store(db);
  const workspace = store.createWorkspace('owner concurrency', directory);
  const requests = Array.from({ length: mode === 'api' ? 100 : 30 }, (_, trial) => {
    const agent = (['codex', 'claude-code', 'dsh'] as const)[trial % 3] as AgentId;
    const first = store.createSession({ workspaceId: workspace.id, agent });
    const second = trial % 2 === 0 ? first : store.createSession({ workspaceId: workspace.id, agent });
    const nativeId = `${mode}-native-${trial}`; store.updateSession(first.id, { nativeId }); store.updateSession(second.id, { nativeId });
    return { trial, agent, first: first.id, second: second.id, nativeId };
  });
  const children: ChildProcess[] = []; const stderr: string[] = []; const observations: { request: typeof requests[number]; replies: Reply[]; owners: unknown[] }[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const child = fork(join(import.meta.dirname, 'fixtures/owner-concurrency-writer.ts'), [directory],
        { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child); stderr.push(''); child.stderr!.setEncoding('utf8'); child.stderr!.on('data', chunk => { stderr[index] += String(chunk); });
      await message(child, () => stderr[index]!);
    }
    for (const request of requests) {
      const pending = children.map((child, index) => message(child, () => stderr[index]!)); const startAt = Date.now() + 10;
      children[0]!.send({ ...request, sessionId: request.first, mode, startAt, ownerId: `${mode}-first-${request.trial}` });
      children[1]!.send({ ...request, sessionId: request.second, mode, startAt, ownerId: `${mode}-second-${request.trial}` });
      const replies = await Promise.all(pending);
      const owners = db.prepare('SELECT * FROM native_owners WHERE native_id = ?').all(request.nativeId);
      observations.push({ request, replies, owners });
    }
    await evidence(mode, { observations, stderr, sqlite: db.prepare('SELECT sqlite_version() AS version').get(),
      classification: 'two actual Node processes / SQLite / production HTTP handlers with FakeAdapter and fixed read pause' });
    for (const observation of observations) {
      expect(observation.owners).toHaveLength(1);
      if (mode === 'api') {
        expect(observation.replies.filter(reply => reply.identity !== undefined)).toHaveLength(1);
        expect(observation.replies.find(reply => reply.identity === undefined)).toMatchObject({ code: 'native-owner-conflict', statusCode: 409, resumes: 0 });
      } else {
        expect(observation.replies.map(reply => reply.statusCode).sort()).toEqual([200, 409]);
        expect(observation.replies.find(reply => reply.statusCode === 409)).toMatchObject({ resumes: 0, body: { ok: false, code: 'conflict' }, journal: { state: 'failed' } });
        expect(observation.replies.find(reply => reply.statusCode === 200)?.resumes).toBe(1);
      }
    }
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.send({ stop: true }); await exited; }
    }
    db.close(); await rm(directory, { recursive: true, force: true });
  }
});

it('a genuine transaction failure remains its original error and rolls back acquisition', async () => {
  const db = openDb(':memory:');
  try {
    const store = new Store(db); const workspace = store.createWorkspace('owner rollback', '/tmp');
    const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    db.exec("CREATE TEMP TRIGGER refuse_owner BEFORE INSERT ON native_owners BEGIN SELECT RAISE(ABORT, 'controlled acquisition failure'); END");
    let rejected: unknown;
    try { store.nativeOwners.acquire('owner', session.id, 'codex', 'native'); } catch (error) { rejected = error; }
    await evidence('rollback', { error: String(rejected), code: (rejected as { code?: string }).code, owner: store.nativeOwners.get(session.id) ?? null });
    expect(String(rejected)).toContain('controlled acquisition failure'); expect(rejected).toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' });
    expect(store.nativeOwners.get(session.id)).toBeUndefined(); db.exec('DROP TRIGGER refuse_owner');
    store.nativeOwners.acquire('owner', session.id, 'codex', 'native'); expect(store.nativeOwners.get(session.id)?.generation).toBe(1);
  } finally { db.close(); }
});

it('a genuine write lock timeout remains SQLITE_BUSY and does not invent a conflicting owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-owner-lock-')); const path = join(directory, 'owners.sqlite');
  const db = openDb(path); const peer = openDb(path);
  try {
    const store = new Store(db); const workspace = store.createWorkspace('owner lock', directory);
    const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    db.pragma('busy_timeout = 1'); peer.exec('BEGIN IMMEDIATE');
    let rejected: unknown;
    try { store.nativeOwners.acquire('owner', session.id, 'codex', 'native'); } catch (error) { rejected = error; }
    await evidence('lock-timeout', { error: String(rejected), code: (rejected as { code?: string }).code, owner: store.nativeOwners.get(session.id) ?? null });
    expect(rejected).toMatchObject({ code: 'SQLITE_BUSY' }); expect(store.nativeOwners.get(session.id)).toBeUndefined();
    peer.exec('ROLLBACK'); store.nativeOwners.acquire('owner', session.id, 'codex', 'native');
    expect(store.nativeOwners.get(session.id)?.generation).toBe(1);
  } finally { if (peer.inTransaction) peer.exec('ROLLBACK'); peer.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});
