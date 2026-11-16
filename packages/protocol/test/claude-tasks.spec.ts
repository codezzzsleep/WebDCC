import { expect, it } from 'vitest';
import { ClaudeTaskProjection, claudeTaskKey, currentClaudeTasks, type StoredEvent } from '../src/index.js';

const event = (seq: number, native: unknown): StoredEvent => ({ sessionId: 'web-session', seq, turnId: null, itemKey: `raw-${seq}`,
  at: new Date(seq).toISOString(), kind: 'internal', data: { nativeType: 'controlled SDK envelope' }, native });
const message = (subtype: string, fields: Record<string, unknown> = {}) => ({ type: 'system', subtype, session_id: 'native', uuid: `controlled-${subtype}`, ...fields });

it('rebuilds the same task state from all five stored SDK task message types', () => {
  const originals = [
    message('background_tasks_changed', { tasks: [{ task_id: 'parent', run_id: '001', task_type: 'local_agent', description: 'parent' }] }),
    message('task_started', { task_id: 'parent', run_id: '001', description: 'parent', is_backgrounded: true }),
    message('task_started', { task_id: 'child', run_id: '002', parent_task_id: 'parent', tool_use_id: 'child-tool', description: 'child', is_backgrounded: true }),
    message('task_progress', { task_id: 'child', run_id: '002', summary: 'work in progress', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 2 } }),
    message('task_updated', { task_id: 'child', run_id: '002', patch: { status: 'failed', error: 'native failure', end_time: 12 } }),
    message('task_notification', { task_id: 'child', run_id: '002', status: 'failed', summary: 'failed child', output_file: '/tmp/child-output' }),
    message('task_notification', { task_id: 'child', run_id: '001', status: 'completed', summary: 'old run', output_file: '/tmp/old-output' }),
  ];
  const live = new ClaudeTaskProjection();
  originals.forEach(native => live.system(native));
  const restored = currentClaudeTasks(originals.map((native, index) => event(index + 1, native)));
  expect(restored).toEqual([...live.tasks.values()]);
  expect(restored.find(task => task.taskId === 'child')).toMatchObject({ parentTaskId: 'parent', runId: '002', status: 'failed',
    summary: 'failed child', error: 'native failure', outputFile: '/tmp/child-output', toolUseId: 'child-tool' });
  expect(restored.find(task => task.taskId === 'parent')).toMatchObject({ status: 'running', backgroundPresence: 'present' });
});

it('keeps a concurrent sibling running when one task ends and is absent from the next snapshot', () => {
  const task = (task_id: string) => ({ task_id, run_id: 'run', task_type: 'local_agent', description: task_id });
  const events = [
    message('task_started', { task_id: 'first', run_id: 'run', description: 'first', is_backgrounded: true }),
    message('task_started', { task_id: 'second', run_id: 'run', description: 'second', is_backgrounded: true }),
    message('background_tasks_changed', { tasks: [task('first'), task('second')] }),
    message('task_notification', { task_id: 'first', run_id: 'run', status: 'stopped', summary: 'first stopped', output_file: '/tmp/first' }),
    message('background_tasks_changed', { tasks: [task('second')] }),
  ];
  const restored = currentClaudeTasks(events.map((native, i) => event(i, native)));
  expect(restored.find(task => task.taskId === 'first')).toMatchObject({ status: 'stopped', backgroundPresence: 'absent' });
  expect(restored.find(task => task.taskId === 'second')).toMatchObject({ status: 'running', backgroundPresence: 'present' });
});

it('marks a process restart as unknown and preserves completed evidence through an empty new level', () => {
  const events = [
    message('task_started', { task_id: 'running', run_id: 'run', description: 'work', is_backgrounded: true }),
    message('background_tasks_changed', { tasks: [{ task_id: 'running', run_id: 'run', task_type: 'local_bash', description: 'work' }] }),
    message('task_notification', { task_id: 'done', run_id: 'run', status: 'completed', summary: 'output', output_file: '/tmp/done' }),
    message('init'),
    message('background_tasks_changed', { tasks: [] }),
  ];
  const restored = currentClaudeTasks(events.map((native, i) => event(i, native)));
  expect(restored.find(task => task.taskId === 'running')).toMatchObject({ status: 'unknown', nativeStatus: 'running', backgroundPresence: 'absent' });
  expect(restored.find(task => task.taskId === 'done')).toMatchObject({ status: 'completed', outputFile: '/tmp/done' });
});

it('preserves unknown patch statuses and rejects malformed snapshots without deleting prior evidence', () => {
  const projection = new ClaudeTaskProjection();
  projection.system(message('task_updated', { task_id: 'task', run_id: 'run', patch: { status: 'future-status' } }));
  expect(projection.tasks.get('task')).toMatchObject({ status: 'unknown', nativeStatus: 'future-status' });
  expect(projection.system(message('background_tasks_changed', { tasks: [null] }))).toBe(false);
  expect(projection.tasks.size).toBe(1);
  expect(projection.system(message('task_started', { description: 'missing native ID' }))).toBe(false);
  expect(projection.tasks.has('undefined')).toBe(false);
});

it('uses the native session, opaque task ID and run ID as separate key components', () => {
  const task = { nativeSessionId: 'native', taskId: 'a-b', runId: 'c' };
  expect(claudeTaskKey(task)).not.toBe(claudeTaskKey({ ...task, taskId: 'a', runId: 'b-c' }));
  expect(claudeTaskKey(task)).not.toBe(claudeTaskKey({ ...task, nativeSessionId: 'other' }));
  expect(claudeTaskKey({ ...task, runId: undefined })).not.toBe(claudeTaskKey({ ...task, runId: 'legacy' }));
});
