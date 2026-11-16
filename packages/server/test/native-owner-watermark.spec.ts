import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { CreateOpts, RuntimeIdentity } from '@webdcc/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

async function evidence(name: string, value: unknown): Promise<void> {
  const directory = process.env['WDCC_OWNER_WATERMARK_EVIDENCE_DIR'];
  if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
}

it('older, duplicate and invalid native frames retain their raw observations without lowering the owner watermark', async () => {
  const ctx = await createTestApp();
  try {
    const adapter = ctx.manager.adapter('dsh')!; let opts!: CreateOpts;
    const create = adapter.create.bind(adapter);
    adapter.create = async value => { opts = value; return create(value); };
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    const runtime = ctx.manager.getRuntime(sessionId)!;
    ctx.store.nativeOwners.observe(sessionId, runtime.identity, 'current-native-turn');
    const observed: { seq: number | undefined; receipt: { envelopeId: number; accepted: boolean };
      owner: ReturnType<Store['nativeOwners']['get']>; raw: ReturnType<Store['nativeEvents']['get']> }[] = [];
    for (const seq of [200, 40, 200, 199, 201, -1, undefined]) {
      const receipt = opts.nativeEvents!.record({ i: observed.length + 1, t: 0, dir: 'in', ch: 'dsh:event',
        frame: { value: { type: 'waterfall', agentId: runtime.nativeId, event: { seq } } } });
      observed.push({ seq, receipt, owner: ctx.store.nativeOwners.get(sessionId), raw: ctx.store.nativeEvents.get(receipt.envelopeId) });
    }
    await evidence('transport-observations', observed);
    expect(ctx.store.nativeOwners.get(sessionId)).toMatchObject({ lastObservedSeq: 201, activeNativeTurnId: 'current-native-turn' });
    const ids = new Set(observed.map(value => value.receipt.envelopeId));
    expect(ctx.store.nativeEvents.list(sessionId).filter(row => ids.has(row.id)).map(row => row.nativeSeq)).toEqual([200, 40, 200, 199, 201, -1, null]);
    expect(observed.every(value => value.receipt.accepted)).toBe(true);
    expect(ctx.store.allEvents(sessionId)).toEqual([]);
  } finally { await ctx.close(); }
});

it('the durable watermark survives a second SQLite connection, reopen and a rolled-back update', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-owner-watermark-')); const file = join(directory, 'db.sqlite');
  let db = openDb(file); const secondDb = openDb(file);
  try {
    let store = new Store(db); const peer = new Store(secondDb);
    const workspace = store.createWorkspace('watermark', directory); const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const identity = store.nativeOwners.acquire('owner', session.id, 'codex', 'native');
    store.nativeOwners.observe(session.id, identity, 'native-turn', 200);
    peer.nativeOwners.observe(session.id, identity, 'native-turn', 40);
    const afterPeer = store.nativeOwners.get(session.id);
    db.close(); db = openDb(file); store = new Store(db);
    const reopened = store.nativeOwners.get(session.id);
    expect(() => db.transaction(() => { store.nativeOwners.observe(session.id, identity, 'native-turn', 900); throw new Error('controlled rollback'); })()).toThrow('controlled rollback');
    const rolledBack = store.nativeOwners.get(session.id);
    for (const seq of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) store.nativeOwners.observe(session.id, identity, 'native-turn', seq);
    await evidence('sqlite-reopen-rollback', { afterPeer, reopened, rolledBack, afterInvalid: store.nativeOwners.get(session.id) });
    expect(afterPeer?.lastObservedSeq).toBe(200); expect(reopened).toEqual(afterPeer); expect(rolledBack).toEqual(reopened);
    expect(store.nativeOwners.get(session.id)?.lastObservedSeq).toBe(200);
    store.nativeOwners.observe(session.id, identity, null);
    expect(store.nativeOwners.get(session.id)).toMatchObject({ lastObservedSeq: 200, activeNativeTurnId: null });
  } finally { db.close(); secondDb.close(); await rm(directory, { recursive: true, force: true }); }
});

it('a new generation starts independently and old generation, Host and released observations cannot write it', async () => {
  const db = openDb(':memory:'); const store = new Store(db);
  try {
    const workspace = store.createWorkspace('generations', '/tmp'); const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const first = store.nativeOwners.acquire('first', session.id, 'codex', 'native');
    store.nativeOwners.observe(session.id, first, 'old-turn', 500);
    store.nativeOwners.release(session.id, first, true);
    const second = store.nativeOwners.acquire('second', session.id, 'codex', 'native');
    expect(store.nativeOwners.get(session.id)?.lastObservedSeq).toBeNull();
    store.nativeOwners.observe(session.id, second, 'new-turn', 0);
    for (const stale of [first, { ...second, hostId: 'other-host' }]) expect(() => store.nativeOwners.observe(session.id, stale, 'wrong-turn', 999)).toThrow('运行代际');
    expect(store.nativeOwners.get(session.id)).toMatchObject({ lastObservedSeq: 0, activeNativeTurnId: 'new-turn', generation: second.generation });
    store.nativeOwners.release(session.id, second, true);
    expect(() => store.nativeOwners.observe(session.id, second, 'wrong-turn', 999)).toThrow('运行代际');
    await evidence('generation-fence', store.nativeOwners.get(session.id));
    expect(store.nativeOwners.get(session.id)).toMatchObject({ lastObservedSeq: 0, activeNativeTurnId: 'new-turn', state: 'released' });
  } finally { db.close(); }
});

interface Samples { phase: 'ready' | 'finished'; samples: { seq: number; lastObservedSeq: number | null }[] }
async function writer(file: string, sessionId: string, identity: RuntimeIdentity, seqs: number[], children: ChildProcess[]): Promise<{ child: ChildProcess; result: Promise<Samples> }> {
  const child = fork(join(import.meta.dirname, 'fixtures/owner-watermark-writer.ts'), [file, sessionId, JSON.stringify(identity), JSON.stringify(seqs)],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
  const ready = new Promise<void>((resolve, reject) => {
    child.on('message', (message: Samples) => { if (message.phase === 'ready') resolve(); });
    child.on('error', reject);
    child.on('exit', code => { reject(new Error(`watermark writer exited ${code} before ready: ${stderr}`)); });
  });
  const result = new Promise<Samples>((resolve, reject) => {
    let finished: Samples | undefined;
    child.on('message', (message: Samples) => { if (message.phase === 'finished') finished = message; });
    child.on('error', reject); child.on('exit', code => {
      if (code === 0 && finished !== undefined) resolve(finished);
      else reject(new Error(`watermark writer exited ${code} without a complete result: ${stderr}`));
    });
  });
  // Startup may fail before the caller can await the finished result.
  void result.catch(() => undefined);
  await ready;
  return { child, result };
}

it('100 observations in two real concurrent SQLite writer processes preserve the highest confirmed sequence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-owner-writers-')); const file = join(directory, 'db.sqlite'); const db = openDb(file);
  const children: ChildProcess[] = [];
  try {
    const store = new Store(db); const workspace = store.createWorkspace('concurrent', directory); const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const identity = store.nativeOwners.acquire('owner', session.id, 'codex', 'native');
    store.nativeOwners.observe(session.id, identity, 'current-turn', 200);
    const writers = await Promise.all([writer(file, session.id, identity, Array.from({ length: 50 }, (_, i) => 201 + i), children),
      writer(file, session.id, identity, Array.from({ length: 50 }, (_, i) => i), children)]);
    for (const value of writers) value.child.send('start');
    const results = await Promise.all(writers.map(value => value.result));
    store.nativeOwners.observe(session.id, identity, 'current-turn', 1);
    const final = store.nativeOwners.get(session.id);
    await evidence('concurrent-processes', { results, final });
    expect(results.flatMap(value => value.samples)).toHaveLength(100);
    expect(final).toMatchObject({ lastObservedSeq: 250, activeNativeTurnId: 'current-turn', generation: identity.generation });
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    db.close(); await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
