import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { currentClaudeTasks, currentClaudeTaskViews } from '@webdcc/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import { captureProcess, processState } from '../src/process-identity.js';
import { seedTaskRecoveryHistory } from './fixtures/claude-task-owner-crash.js';

it('recovers tasks after an actual own dispatcher SIGKILL without claiming native task completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-claude-task-owner-'));
  const child = fork(join(import.meta.dirname, 'fixtures/claude-task-owner-crash.ts'), ['--writer', directory],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let db: ReturnType<typeof openDb> | undefined;
  try {
    const [value] = await once(child, 'message'); const { sessionId } = value as { sessionId: string };
    const identity = captureProcess(child.pid!); expect(identity).toBeDefined(); expect(processState(identity!)).toBe('running');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    db = openDb(join(directory, 'task.sqlite')); const store = new Store(db);
    const before = currentClaudeTasks(store.allEvents(sessionId)); expect(before.find(task => task.taskId === 'background')?.status).toBe('running');
    const manager = new SessionManager(store, { idleDisposeMin: 0 });
    const recovered = currentClaudeTaskViews(store.allEvents(sessionId));
    expect(store.nativeOwners.get(sessionId)?.state).toBe('uncertain');
    for (const taskId of ['background', 'paused', 'pending', 'snapshot-only']) expect(recovered.tasks.find(task => task.taskId === taskId)).toMatchObject({ status: 'unknown', backgroundPresence: 'unknown' });
    expect(recovered.tasks.find(task => task.taskId === 'background')).toMatchObject({ nativeStatus: 'running', parentTaskId: 'parent', toolUseId: 'background-tool', runId: '001', outputs: [expect.objectContaining({ text: 'Retained child output' })] });
    for (const status of ['completed', 'failed', 'stopped']) expect(recovered.tasks.find(task => task.taskId === status)).toMatchObject({ status, terminalNotification: status, summary: `retained ${status} result`, outputFile: `/tmp/controlled-${status}` });
    const count = store.allEvents(sessionId).length; const second = new SessionManager(store, { idleDisposeMin: 0 });
    expect(store.allEvents(sessionId)).toHaveLength(count);
    await second.disposeAll(); await manager.disposeAll();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    db?.close(); await rm(directory, { recursive: true, force: true });
  }
});

it('does not rewrite another live Claude owner even after its lease expires', async () => {
  const db = openDb(':memory:'); const store = new Store(db);
  try {
    const workspace = store.createWorkspace('live task owner', '/tmp'); const session = store.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    const identity = store.nativeOwners.acquire('live-other-manager', session.id, 'claude-code', 'controlled-native');
    store.nativeOwners.activate(session.id, identity, 'controlled-native'); seedTaskRecoveryHistory(store, session.id);
    db.prepare('UPDATE native_owners SET lease_until = 0 WHERE session_id = ?').run(session.id);
    const before = store.allEvents(session.id); const second = new SessionManager(store, { idleDisposeMin: 0 });
    expect(store.allEvents(session.id)).toEqual(before);
    expect(currentClaudeTasks(store.allEvents(session.id)).find(task => task.taskId === 'background')?.status).toBe('running');
    expect(store.nativeOwners.current(session.id, identity)).toBe(true); await second.disposeAll();
  } finally { db.close(); }
});

it('keeps legacy task observations unknown and lets a new query confirm a new run', async () => {
  const db = openDb(':memory:'); const store = new Store(db);
  try {
    const workspace = store.createWorkspace('legacy task', '/tmp'); const session = store.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    seedTaskRecoveryHistory(store, session.id, true);
    const manager = new SessionManager(store, { idleDisposeMin: 0 });
    expect(currentClaudeTasks(store.allEvents(session.id)).find(task => task.taskId === 'background')).toMatchObject({ status: 'unknown', nativeStatus: 'running', backgroundPresence: 'unknown' });
    store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'new-query', kind: 'internal', data: { nativeType: 'claude-query-runtime', claudeTaskRuntime: { id: 'new-query', state: 'started' } } });
    store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'new-run', kind: 'internal', data: { nativeType: 'task_started' },
      native: { type: 'system', subtype: 'task_started', session_id: 'controlled-native', task_id: 'background', run_id: '002', description: 'new task run' } });
    store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'late-old-unavailable', kind: 'internal', data: { nativeType: 'claude-query-runtime', claudeTaskRuntime: { id: 'old-query', state: 'unavailable' } } });
    expect(currentClaudeTasks(store.allEvents(session.id)).find(task => task.taskId === 'background')).toMatchObject({ status: 'running', runId: '002' });
    await manager.disposeAll();
  } finally { db.close(); }
});

it('recovers the current query when an older unavailable observation arrived last', async () => {
  const db = openDb(':memory:'); const store = new Store(db);
  let manager: SessionManager | undefined;
  let second: SessionManager | undefined;
  try {
    const workspace = store.createWorkspace('late old query observation', '/tmp');
    const session = store.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    seedTaskRecoveryHistory(store, session.id);
    store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'new-query', kind: 'internal',
      data: { nativeType: 'claude-query-runtime', claudeTaskRuntime: { id: 'new-query', state: 'started' } } });
    store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'new-run', kind: 'internal', data: { nativeType: 'task_started' },
      native: { type: 'system', subtype: 'task_started', session_id: 'controlled-native', task_id: 'background', run_id: '002', description: 'current task' } });
    store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'late-old-unavailable', kind: 'internal',
      data: { nativeType: 'claude-query-runtime', claudeTaskRuntime: { id: 'controlled-query', state: 'unavailable' } } });
    const before = store.allEvents(session.id);
    expect(currentClaudeTasks(before).find(task => task.taskId === 'background')).toMatchObject({ status: 'running', runId: '002' });
    manager = new SessionManager(store, { idleDisposeMin: 0 });
    const recovered = store.allEvents(session.id);
    expect(recovered.slice(0, before.length)).toEqual(before);
    expect(recovered.slice(before.length)).toEqual([expect.objectContaining({ kind: 'internal',
      data: { nativeType: 'claude-server-recovery', claudeTaskRuntime: { id: 'new-query', state: 'unavailable' } } })]);
    expect(currentClaudeTasks(recovered).find(task => task.taskId === 'background')).toMatchObject({ status: 'unknown', nativeStatus: 'running', runId: '002' });
    for (const status of ['completed', 'failed', 'stopped']) expect(currentClaudeTasks(recovered).find(task => task.taskId === status)?.status).toBe(status);
    second = new SessionManager(store, { idleDisposeMin: 0 });
    expect(store.allEvents(session.id)).toEqual(recovered);
  } finally { await second?.disposeAll(); await manager?.disposeAll(); db.close(); }
});
