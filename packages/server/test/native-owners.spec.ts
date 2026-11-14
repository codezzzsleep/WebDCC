import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent, RuntimeIdentity } from '@webdcc/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';

it('NP-04 an expired lease cannot transfer a live native writer; a verified managed release advances the fence', () => {
  const db = openDb(':memory:');
  try {
    const store = new Store(db); const workspace = store.createWorkspace('owner', '/tmp');
    const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const first = store.nativeOwners.acquire('first', session.id, 'codex', 'native');
    store.nativeOwners.activate(session.id, first, 'native');
    db.prepare('UPDATE native_owners SET lease_until = 0 WHERE session_id = ?').run(session.id);
    expect(() => store.nativeOwners.acquire('second', session.id, 'codex', 'native')).toThrow('仍持有');
    expect(store.nativeOwners.recoverableSessions()).not.toContain(session.id);
    store.nativeOwners.close(session.id, first); store.nativeOwners.release(session.id, first, true);
    const second = store.nativeOwners.acquire('second', session.id, 'codex', 'native');
    expect(second.generation).toBe(first.generation + 1);
    expect(store.nativeOwners.current(session.id, first)).toBe(false);
    store.nativeOwners.release(session.id, first, true);
    expect(store.nativeOwners.current(session.id, second)).toBe(true);
  } finally { db.close(); }
});

it('NP-04 a second manager does not recover another live manager\'s running command or open a second native instance', async () => {
  const db = openDb(':memory:'); const store = new Store(db);
  const first = new SessionManager(store, { idleDisposeMin: 0 });
  const adapter = new FakeAdapter({ id: 'codex' });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  adapter.send = async () => { await gate; };
  first.registerAdapter(adapter);
  let second: SessionManager | undefined;
  try {
    const workspace = store.createWorkspace('owner', '/tmp');
    const session = await first.createSession({ workspaceId: workspace.id, agent: 'codex' });
    store.journal.claim({ op: 'send', clientCommandId: 'RUN', sessionId: session.id, text: 'kept' });
    const running = first.send(session.id, { text: 'kept' }, 'RUN');
    await expect.poll(() => store.journal.get('RUN')?.state).toBe('dispatching');
    second = new SessionManager(store, { idleDisposeMin: 0 });
    let resumes = 0; const other = new FakeAdapter({ id: 'codex' }); other.resume = async () => { resumes++; };
    second.registerAdapter(other);
    expect(store.journal.get('RUN')?.state).toBe('dispatching');
    expect(store.journal.queue(session.id)[0]?.state).toBe('dispatching');
    await expect(second.send(session.id, { text: 'competing' })).rejects.toMatchObject({ code: 'native-owner-conflict' });
    expect(resumes).toBe(0);
    release(); await running;
  } finally { release(); await first.disposeAll(); await second?.disposeAll(); db.close(); }
});

it('NP-04 concurrent resume is single-flight and stale callbacks cannot change the next generation', async () => {
  const db = openDb(':memory:'); const store = new Store(db); const manager = new SessionManager(store, { idleDisposeMin: 0 });
  const adapter = new FakeAdapter({ id: 'codex' });
  let callback!: (id: string, event: AdapterEvent) => void;
  adapter.onEvent = cb => { callback = cb; };
  let resumes = 0; adapter.resume = async () => { resumes++; await new Promise(resolve => setImmediate(resolve)); };
  manager.registerAdapter(adapter);
  try {
    const workspace = store.createWorkspace('owner', '/tmp');
    const session = await manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const old = manager.getRuntime(session.id)!.identity;
    await manager.dispose(session.id);
    await Promise.all(Array.from({ length: 100 }, () => manager.slashCommands(session.id)));
    expect(resumes).toBe(1);
    const current = manager.getRuntime(session.id)!.identity;
    expect(current.generation).toBe(old.generation + 1);
    callback(session.id, { type: 'item.complete', itemKey: 'late', kind: 'assistant.message', data: { text: 'old' }, runtime: old });
    callback(session.id, { type: 'permissions', observation: { effective: 'danger-full-access', source: 'old' }, runtime: old });
    callback(session.id, { type: 'native-id', nativeId: 'wrong-id', runtime: old });
    expect(store.allEvents(session.id)).toHaveLength(0);
    expect(store.getSession(session.id)?.nativeId).not.toBe('wrong-id');
    expect(store.getSession(session.id)?.permissions?.effective).not.toBe('danger-full-access');
    expect(store.nativeEvents.list(session.id).filter(row => row.disposition === 'stale-generation')).toHaveLength(3);
    callback(session.id, { type: 'item.complete', itemKey: 'current', kind: 'assistant.message', data: { text: 'new' }, runtime: current });
    expect(store.allEvents(session.id)).toHaveLength(1);
  } finally { await manager.disposeAll(); db.close(); }
});

it('NP-04 native transport loss retains an uncertain turn rather than fabricating user interruption or completion', async () => {
  const db = openDb(':memory:'); const store = new Store(db); const manager = new SessionManager(store, { idleDisposeMin: 0 });
  const adapter = new FakeAdapter({ id: 'codex' });
  let callback!: (id: string, event: AdapterEvent) => void; adapter.onEvent = cb => { callback = cb; }; adapter.send = async () => undefined;
  manager.registerAdapter(adapter);
  try {
    const workspace = store.createWorkspace('owner', '/tmp');
    const session = await manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const sent = await manager.send(session.id, { text: 'accepted' });
    callback(session.id, { type: 'transport.closed', reason: 'process-exited', activeWork: true });
    expect(store.allEvents(session.id).some(event => event.kind === 'turn.completed')).toBe(false);
    expect(store.journal.queue(session.id).find(row => row.turnId === sent.turnId)?.state).toBe('uncertain');
    expect(store.getSession(session.id)?.status).toBe('error');
    expect(store.nativeOwners.get(session.id)?.state).toBe('uncertain');
    await expect(manager.send(session.id, { text: 'retry' })).rejects.toMatchObject({ statusCode: 409 });
  } finally { await manager.disposeAll(); db.close(); }
});

it('NP-04 SIGKILL preserves native turn identity and marks abandoned ownership uncertain without claiming native exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-owner-crash-'));
  const child = fork(join(import.meta.dirname, 'fixtures/owner-crash.ts'), [directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let db: ReturnType<typeof openDb> | undefined;
  try {
    const [message] = await once(child, 'message');
    const { sessionId, identity } = message as { sessionId: string; identity: RuntimeIdentity };
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    db = openDb(join(directory, 'owner.sqlite')); const store = new Store(db);
    expect(store.nativeOwners.recoverableSessions()).toContain(sessionId);
    expect(store.nativeOwners.get(sessionId)).toMatchObject({ state: 'uncertain', activeNativeTurnId: 'active-native-turn', lastObservedSeq: 71, generation: identity.generation });
    expect(() => store.nativeOwners.acquire('new', sessionId, 'codex', 'native-crash')).toThrow('待核对');
    expect(store.allEvents(sessionId)).toHaveLength(1);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); db?.close(); await rm(directory, { recursive: true, force: true }); }
});
