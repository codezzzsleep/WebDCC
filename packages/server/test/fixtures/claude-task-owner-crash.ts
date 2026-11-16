import { join } from 'node:path';
import type { StoredEvent } from '@webdcc/protocol';
import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';

/** Controlled original SDK envelopes; no query, native CLI or model is run. */
export function seedTaskRecoveryHistory(store: Store, sessionId: string, legacy = false): void {
  let sequence = 0;
  const append = (native: unknown) => store.appendEvent({ sessionId, turnId: null, itemKey: `controlled-task-${++sequence}`, kind: 'internal',
    data: { nativeType: 'controlled SDK task envelope' }, native });
  const message = (subtype: string, fields: Record<string, unknown>) => ({ type: 'system', subtype, session_id: 'controlled-native', uuid: `controlled-${sequence}`, ...fields });
  if (!legacy) store.appendEvent({ sessionId, turnId: null, itemKey: 'controlled-query-start', kind: 'internal',
    data: { nativeType: 'claude-query-runtime', claudeTaskRuntime: { id: 'controlled-query', state: 'started' } } });
  for (const task_id of ['background', 'paused', 'pending']) append(message('task_started', { task_id, run_id: '001', description: task_id,
    is_backgrounded: true, parent_task_id: 'parent', tool_use_id: `${task_id}-tool` }));
  append(message('task_updated', { task_id: 'paused', run_id: '001', patch: { status: 'paused' } }));
  append(message('task_updated', { task_id: 'pending', run_id: '001', patch: { status: 'pending' } }));
  for (const status of ['completed', 'failed', 'stopped']) append(message('task_notification', { task_id: status, run_id: '001', status,
    summary: `retained ${status} result`, output_file: `/tmp/controlled-${status}` }));
  append(message('background_tasks_changed', { tasks: ['background', 'paused', 'pending', 'snapshot-only'].map(task_id => ({ task_id,
    run_id: '001', task_type: 'local_agent', description: task_id })) }));
  store.appendEvent({ sessionId, turnId: null, itemKey: 'retained-child-output', kind: 'assistant.message', data: { text: 'Retained child output',
    claudeActor: { agent: 'claude-code', nativeSessionId: 'controlled-native', parentToolUseId: 'background-tool', taskId: 'background', runId: '001' } } });
}

if (process.argv[2] === '--writer') {
  const directory = process.argv[3]!;
  const db = openDb(join(directory, 'task.sqlite')); const store = new Store(db);
  const workspace = store.createWorkspace('task recovery fixture', directory);
  const session = store.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
  store.updateSession(session.id, { nativeId: 'controlled-native' });
  const identity = store.nativeOwners.acquire('controlled-writer', session.id, 'claude-code', 'controlled-native');
  store.nativeOwners.activate(session.id, identity, 'controlled-native');
  seedTaskRecoveryHistory(store, session.id);
  const events: StoredEvent[] = store.allEvents(session.id);
  process.send?.({ sessionId: session.id, workspaceId: workspace.id, identity, eventCount: events.length });
  setInterval(() => undefined, 1000);
}
