import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import type { NativeObservation, AgentAdapter } from '@webdcc/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { captureProcess, processState } from '../src/process-identity.js';
import { SessionManager } from '../src/manager.js';
import { FakeAdapter } from '@webdcc/fake-adapter';
import { createTestApp } from './helpers.js';
import { FileStore } from '../src/files.js';

async function setup() {
  const db = openDb(':memory:'); const store = new Store(db);
  const dataDir = await mkdtemp(join(tmpdir(), 'wdcc-native-reconcile-')); const files = new FileStore(dataDir, store); await files.init();
  const workspace = store.createWorkspace('recovery', '/tmp');
  const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
  store.updateSession(session.id, { nativeId: 'thread' });
  const identity = store.nativeOwners.acquire('abandoned', session.id, 'codex', 'thread');
  store.nativeOwners.activate(session.id, identity, 'thread');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  store.nativeOwners.bindProcess(session.id, identity, child.pid!, '/tmp/native-profile', '0.167.0');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  store.nativeOwners.release(session.id, identity, false);
  store.journal.claim({ op: 'send', sessionId: session.id, clientCommandId: 'accepted', text: 'accepted text' });
  store.journal.enqueue('accepted', session.id, 'web-turn', { text: 'accepted text' });
  store.journal.inputState('web-turn', 'uncertain');
  const image = await files.putBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==', 'base64'), 'queue.png', 'image/png'); await files.attachToSession(session.id, image.id);
  store.journal.enqueue('queued', session.id, 'queued-turn', { text: 'kept queue', images: [{ fileId: image.id, path: '/old/derived/a.png', mime: 'image/png' }] });
  store.nativeHistory.bind(session.id, 'native-turn', 'web-turn');
  store.appendEvent({ sessionId: session.id, turnId: 'web-turn', itemKey: 'start', kind: 'turn.started', data: {} });
  store.appendEvent({ sessionId: session.id, turnId: 'web-turn', itemKey: 'user', kind: 'user.message', data: { text: 'accepted text', clientCommandId: 'accepted' } });
  const observation: NativeObservation = { nativeId: 'thread', agent: 'codex', cwd: '/tmp', profilePath: '/tmp/native-profile', version: '0.167.0', capturedAt: new Date().toISOString(),
    state: 'unknown', authority: 'history-only', releasePolicy: 'managed-process', notes: ['notLoaded is observer-local'],
    turns: [{ nativeTurnId: 'native-turn', status: 'completed', itemsComplete: true, startedAt: '2026-11-14T00:00:00Z', completedAt: '2026-11-14T00:01:00Z', clientCommandIds: ['accepted'],
      items: [{ itemKey: 'answer', kind: 'assistant.message', data: { text: 'native final', phase: 'final' }, native: { type: 'agentMessage', id: 'answer', text: 'native final' } }] }] };
  return { db, store, session, identity, observation, image, files, async close() { db.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

it('NP-04 tracks a real child by boot and start time; PID reuse and invalid identity cannot authorize a live writer', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const identity = captureProcess(child.pid!);
    expect(identity).toBeDefined(); expect(processState(identity!)).toBe('running');
    expect(processState({ ...identity!, startTicks: `${identity!.startTicks}0` })).toBe('exited');
    expect(processState({ ...identity!, pid: -1 })).toBe('unknown'); expect(processState(null)).toBe('unknown');
    expect(processState({ ...identity!, machineId: 'another-machine' })).toBe('unknown');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    expect(processState(identity!)).toBe('exited');
  } finally { child.kill('SIGKILL'); }
});

it('NP-04/06 only applies a unique terminal native outcome, closes unknown response cards and preserves queued input', async () => {
  const { store, session, observation, image, close } = await setup();
  try {
    store.appendEvent({ sessionId: session.id, turnId: 'web-turn', itemKey: 'q', kind: 'question', data: { questionId: 'question', prompt: 'native question', status: 'pending', submission: 'uncertain' } });
    store.appendEvent({ sessionId: session.id, turnId: 'web-turn', itemKey: 'a', kind: 'approval.request', data: { approvalId: 'approval', title: 'native approval', detail: 'approval detail', options: [{ id: 'allow', label: 'allow' }] } });
    const preview = store.reconciliations.capture(session.id, observation);
    expect(preview.canApply).toBe(true);
    const result = store.reconciliations.apply(session.id, preview.revision, observation);
    expect(result.view.applied).toBe(true);
    expect(store.journal.get('accepted')?.state).toBe('completed');
    expect(store.journal.queue(session.id)).toEqual([expect.objectContaining({ commandId: 'queued', state: 'queued', input: { text: 'kept queue', images: [{ fileId: image.id, path: '/old/derived/a.png', mime: 'image/png' }] } })]);
    expect(store.allEvents(session.id).findLast(event => event.kind === 'question')?.data).toMatchObject({ status: 'skipped', resolution: 'outcome-unknown' });
    expect(store.allEvents(session.id).findLast(event => event.kind === 'approval.resolved')?.data).toMatchObject({ optionId: 'outcome-unknown', by: 'system' });
    expect(store.allEvents(session.id).findLast(event => event.kind === 'turn.completed')?.data).toMatchObject({ status: 'completed', durationMs: 60_000, answerItemKeys: ['answer'] });
    expect(store.reconciliations.get(session.id)).toMatchObject({ applied: true, canApply: false });
    expect(() => store.reconciliations.apply(session.id, preview.revision, observation)).toThrow('不可恢复');
    expect(store.allEvents(session.id).filter(event => event.kind === 'turn.completed')).toHaveLength(1);
  } finally { await close(); }
});

it('NP-04 notLoaded history cannot release a running or unknown old writer, nor missing/incomplete native turns', async () => {
  const { db, store, session, identity, observation, close } = await setup();
  try {
    expect(store.reconciliations.capture(session.id, { ...observation, turns: [] }).canApply).toBe(false);
    expect(store.reconciliations.capture(session.id, { ...observation, turns: observation.turns.map(turn => ({ ...turn, itemsComplete: false })) }).canApply).toBe(false);
    expect(store.reconciliations.capture(session.id, { ...observation, turns: observation.turns.map(turn => ({ ...turn, status: 'inProgress' })) }).canApply).toBe(false);
    expect(store.reconciliations.capture(session.id, { ...observation, nativeId: 'wrong' }).canApply).toBe(false);
    expect(store.reconciliations.capture(session.id, { ...observation, cwd: '/different' }).canApply).toBe(false);
    expect(store.reconciliations.capture(session.id, { ...observation, profilePath: '/different-profile' }).canApply).toBe(false);
    expect(store.reconciliations.capture(session.id, { ...observation, version: '0.168.0' }).canApply).toBe(false);
    const processIdentity = store.nativeOwners.managedProcess(session.id)!;
    const { nativeVersion: _version, ...legacyIdentity } = processIdentity; void _version;
    db.prepare('UPDATE native_owners SET managed_process = ? WHERE session_id = ?').run(JSON.stringify(legacyIdentity), session.id);
    expect(store.reconciliations.capture(session.id, observation)).toMatchObject({ writer: 'exited', canApply: false });
    db.prepare('UPDATE native_owners SET managed_process = ? WHERE session_id = ?').run(JSON.stringify(processIdentity), session.id);
    db.prepare("UPDATE native_owners SET managed_process = NULL WHERE session_id = ?").run(session.id);
    expect(store.reconciliations.capture(session.id, observation)).toMatchObject({ writer: 'unknown', canApply: false });
    db.prepare("UPDATE native_owners SET state = 'active' WHERE session_id = ?").run(session.id);
    store.nativeOwners.bindProcess(session.id, identity, process.pid);
    store.nativeOwners.release(session.id, identity, false);
    expect(store.reconciliations.capture(session.id, observation)).toMatchObject({ writer: 'running', canApply: false });
    store.nativeOwners.release(session.id, identity, true);
    expect(store.reconciliations.capture(session.id, observation)).toMatchObject({ writer: 'running', canApply: false });
    expect(store.journal.queue(session.id)[0]?.state).toBe('uncertain');
  } finally { await close(); }
});

it('NP-04 stale previews and changed native content fail before changing commands, cards or owner; failed commits roll back', async () => {
  const { db, store, session, observation, close } = await setup();
  try {
    const first = store.reconciliations.capture(session.id, observation);
    store.updateSession(session.id, { title: 'changed' });
    expect(() => store.reconciliations.apply(session.id, first.revision, observation)).toThrow('不可恢复');
    const second = store.reconciliations.capture(session.id, observation);
    const changed = structuredClone(observation); changed.turns[0]!.items[0]!.data = { text: 'changed final', phase: 'final' };
    expect(() => store.reconciliations.apply(session.id, second.revision, changed)).toThrow('内容已变化');
    db.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON events WHEN NEW.kind = 'turn.completed' BEGIN SELECT RAISE(ABORT, 'fault injected'); END;");
    expect(() => store.reconciliations.apply(session.id, second.revision, observation)).toThrow('fault injected');
    expect(store.allEvents(session.id).some(event => event.itemKey === 'answer')).toBe(false);
    expect(store.journal.get('accepted')?.state).toBe('uncertain'); expect(store.reconciliations.get(session.id)?.applied).toBe(false);
    db.exec('DROP TRIGGER fail_recovery');
    expect(store.reconciliations.apply(session.id, second.revision, observation).view.applied).toBe(true);
  } finally { await close(); }
});

it('NP-04 a recovered manager reads native state twice and resumes queued work only on a later user send', async () => {
  const { store, session, observation, files, close } = await setup();
  const manager = new SessionManager(store, { idleDisposeMin: 0, files });
  const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' }); let reads = 0; let sends = 0;
  adapter.observe = async () => { reads++; return observation; };
  adapter.send = async () => { sends++; }; manager.registerAdapter(adapter);
  try {
    await expect(manager.send(session.id, { text: 'too soon' })).rejects.toMatchObject({ statusCode: 409 });
    const preview = await manager.reconcile(session.id);
    const results = await Promise.allSettled([manager.applyReconciliation(session.id, preview.revision), manager.applyReconciliation(session.id, preview.revision)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(reads).toBe(2); expect(sends).toBe(0); expect(manager.getRuntime(session.id)).toBeUndefined();
    await manager.send(session.id, { text: 'new user input' });
    expect(sends).toBe(1); expect(store.journal.queue(session.id)).toContainEqual(expect.objectContaining({ input: { text: 'new user input' }, state: 'queued' }));
  } finally { await manager.disposeAll(); await close(); }
});

it('NP-04 reconciliation routes require authentication, a preview revision and a native observation implementation', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('recover', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const path = `/api/sessions/${session.id}/reconciliation`;
    expect((await ctx.app.inject({ method: 'POST', url: path, payload: {} })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: `${path}/apply`, payload: {}, headers: { cookie: ctx.cookie } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: path, payload: {}, headers: { cookie: ctx.cookie } })).statusCode).toBe(501);
  } finally { await ctx.close(); }
});

it('NP-19 requires the steer UUID in the actual native target turn before settling an uncertain admission', async () => {
  const { store, session, observation, close } = await setup();
  try {
    store.journal.claim({ op: 'send', sessionId: session.id, clientCommandId: 'uncertain-steer', text: 'steer text', intent: 'steer', expectedTurnId: 'web-turn' });
    store.journal.enqueue('uncertain-steer', session.id, 'steer-admission', { text: 'steer text', delivery: 'steer', expectedTurnId: 'web-turn' });
    expect(store.journal.beginInput('steer-admission', 'web-turn')).toBe(true); store.journal.inputState('steer-admission', 'uncertain');
    const requestId = store.journal.nativeRequestId('steer-admission');
    const missing = store.reconciliations.capture(session.id, observation); expect(missing.canApply).toBe(false); expect(missing.reasons.join(' ')).toContain('真实接收身份'); expect(store.journal.get('uncertain-steer')?.state).toBe('uncertain');
    const confirmed = structuredClone(observation); confirmed.turns[0]!.clientCommandIds.push(requestId);
    const preview = store.reconciliations.capture(session.id, confirmed); expect(preview.canApply).toBe(true); store.reconciliations.apply(session.id, preview.revision, confirmed);
    expect(store.journal.get('uncertain-steer')?.state).toBe('completed'); expect(store.journal.nativeInput(session.id, requestId)).toEqual({ commandId: 'uncertain-steer', turnId: 'web-turn' });
  } finally { await close(); }
});
