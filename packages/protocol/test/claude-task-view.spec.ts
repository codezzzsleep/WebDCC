import { expect, it } from 'vitest';
import { claudeTaskTree, currentClaudeTaskViews, type OpenItem, type StoredEvent } from '../src/index.js';
import { ClaudeAdapter } from '../../adapters/claude/src/adapter.js';

function capture() {
  const replay = ClaudeAdapter.replay('web');
  const events: StoredEvent[] = [];
  let i = 0;
  return { events, push(frame: unknown) {
    for (const event of replay.feed({ i: ++i, t: i, dir: 'in', ch: 'sdk', frame })) {
      if (event.type !== 'item.start' && event.type !== 'item.complete') continue;
      events.push({ sessionId: 'web', seq: events.length + 1, turnId: null, itemKey: event.itemKey, kind: event.kind, data: event.data as StoredEvent['data'],
        native: event.native, at: new Date(i).toISOString() });
    }
  } };
}
const start = (task_id: string, run_id = '001', tool_use_id = `${task_id}-tool`, parent_task_id?: string) => ({ type: 'system',
  subtype: 'task_started', session_id: 'native', uuid: `${task_id}-${run_id}`, task_id, run_id, tool_use_id, parent_task_id, description: task_id, is_backgrounded: true });
const output = (parent: string, id: string, text: string) => ({ type: 'assistant', uuid: id, parent_tool_use_id: parent, session_id: 'native',
  message: { id, stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

it('rebuilds nested tasks and two interleaved child outputs with their original tool/message identities', () => {
  const c = capture();
  c.push(start('parent'));
  c.push(start('first', '001', 'first-tool', 'parent'));
  c.push(start('second', '001', 'second-tool', 'parent'));
  c.push(output('first-tool', 'same-model-id', 'FIRST'));
  c.push(output('second-tool', 'same-model-id', 'SECOND'));
  const view = currentClaudeTaskViews(c.events);
  expect(view.unassignedOutputs).toEqual([]);
  expect(view.tasks.find(task => task.taskId === 'first')?.outputs).toEqual([expect.objectContaining({ text: 'FIRST',
    origin: { agent: 'claude-code', nativeSessionId: 'native', parentToolUseId: 'first-tool', nativeMessageId: 'same-model-id', blockIndex: 0, taskId: 'first', runId: '001' } })]);
  expect(view.tasks.find(task => task.taskId === 'second')?.outputs[0]?.text).toBe('SECOND');
  const tree = claudeTaskTree(view.tasks);
  expect(tree.map(node => node.task.taskId)).toEqual(['parent']);
  expect(tree[0]?.children.map(node => node.task.taskId)).toEqual(['first', 'second']);
});

it('retains prior run output separately and leaves a reused tool ID ambiguous instead of assigning the newest run', () => {
  const c = capture();
  c.push(start('task', '001', 'reused-tool'));
  c.push(output('reused-tool', 'old-message', 'OLD OUTPUT'));
  c.push({ type: 'system', subtype: 'task_notification', session_id: 'native', task_id: 'task', run_id: '001', status: 'completed',
    summary: 'old summary', output_file: '/tmp/old' });
  c.push(start('task', '002', 'reused-tool'));
  c.push(output('reused-tool', 'unidentified-run-message', 'RUN UNKNOWN'));
  const view = currentClaudeTaskViews(c.events);
  expect(view.tasks[0]).toMatchObject({ runId: '002', outputs: [], previousRuns: [expect.objectContaining({ runId: '001',
    status: 'completed', outputs: [expect.objectContaining({ text: 'OLD OUTPUT' })] })] });
  expect(view.unassignedOutputs).toEqual([expect.objectContaining({ text: 'RUN UNKNOWN', origin: expect.objectContaining({ parentToolUseId: 'reused-tool' }) })]);
  expect(view.unassignedOutputs[0]?.origin).not.toHaveProperty('runId');
});

it('preserves unknown parent IDs and makes a cyclic native parent relation inspectable without recursion', () => {
  const c = capture();
  c.push(start('orphan', '001', 'orphan-tool', 'unseen-parent'));
  c.push(start('first', '001', 'first-tool', 'second'));
  c.push(start('second', '001', 'second-tool', 'first'));
  const tree = claudeTaskTree(currentClaudeTaskViews(c.events).tasks);
  expect(tree).toHaveLength(3);
  expect(tree.every(node => node.children.length === 0)).toBe(true);
  expect(tree.find(node => node.task.taskId === 'orphan')?.task.parentTaskId).toBe('unseen-parent');
  expect(tree.some(node => node.task.taskId === 'unseen-parent')).toBe(false);
});

it('replaces one keyed persisted block with its live snapshot without duplicating it or losing its source', () => {
  const c = capture();
  c.push(start('task'));
  c.push(output('task-tool', 'message', 'STORED'));
  const stored = c.events.find(event => event.kind === 'assistant.message')!;
  const live: OpenItem = { itemKey: stored.itemKey, kind: stored.kind, turnId: null, data: { ...stored.data, text: 'LIVE' } as OpenItem['data'] };
  const view = currentClaudeTaskViews(c.events, [live]);
  expect(view.tasks[0]?.outputs).toEqual([expect.objectContaining({ text: 'LIVE', live: true, origin: expect.objectContaining({ taskId: 'task', runId: '001' }) })]);
});
