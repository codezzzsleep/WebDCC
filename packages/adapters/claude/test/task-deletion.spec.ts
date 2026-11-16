import type { TaskUpdateOutput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import { expect, it } from 'vitest';
import { ClaudeNativeState } from '../src/native-state.js';
import { ClaudeAdapter } from '../src/adapter.js';

const deletion: TaskUpdateOutput = { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'deleted' } };

function populated() {
  const state = new ClaudeNativeState();
  for (const id of ['1', '2']) state.toolResult('TaskCreate', {}, { task: { id, subject: `Native task ${id}` } }, false);
  return state;
}

it('removes only the task named by a successful native deleted result and handles repeat/unknown deletion without a phantom task', () => {
  const state = populated();
  expect(state.toolResult('TaskUpdate', { taskId: 'wrong-request-target', status: 'completed' }, deletion, false)).toBe(true);
  expect([...state.plans.keys()]).toEqual(['2']);
  expect(state.toolResult('TaskUpdate', {}, deletion, false)).toBe(false);
  expect(state.toolResult('TaskUpdate', {}, { ...deletion, taskId: 'unknown' }, false)).toBe(false);
  expect([...state.plans.keys()]).toEqual(['2']);
});

it.each([{ failed: false, success: false }, { failed: true, success: true }])('retains a failed native deletion (%j) and trusts the actual status over the requested deletion', ({ failed, success }) => {
  const state = populated();
  expect(state.toolResult('TaskUpdate', { status: 'deleted' }, { ...deletion, success }, failed)).toBe(false);
  expect([...state.plans.keys()]).toEqual(['1', '2']);
  expect(state.toolResult('TaskUpdate', { status: 'deleted' }, { ...deletion, success: false }, false)).toBe(false);
  expect(state.toolResult('TaskUpdate', { status: 'deleted' }, { ...deletion, statusChange: { from: 'pending', to: 'in_progress' } }, false)).toBe(true);
  expect(state.plans.get('1')?.status).toBe('in_progress');
  const changedOwner: TaskUpdateOutput = { success: true, taskId: '1', updatedFields: ['owner'] };
  expect(state.toolResult('TaskUpdate', { status: 'deleted' }, changedOwner, false)).toBe(true);
  expect(state.plans.get('1')?.status).toBe('in_progress');
});

it('the common SDK handler emits a new empty plan after the last deletion while preserving the original result', () => {
  const replay = ClaudeAdapter.replay('controlled-task-session');
  let i = 0;
  const tool = (id: string, name: string, input: unknown, result: unknown) => {
    replay.feed({ i: ++i, t: i, dir: 'in', ch: 'sdk', frame: { type: 'assistant', session_id: 'native', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } } });
    const native = { type: 'user', session_id: 'native', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) }] }, tool_use_result: result };
    return { native, events: replay.feed({ i: ++i, t: i, dir: 'in', ch: 'sdk', frame: native }) };
  };
  tool('create', 'TaskCreate', { subject: 'Native task 1' }, { task: { id: '1', subject: 'Native task 1' } });
  const deleted = tool('delete', 'TaskUpdate', { taskId: '1', status: 'deleted' }, deletion);
  expect(deleted.events).toContainEqual(expect.objectContaining({ type: 'item.complete', kind: 'plan', data: { items: [] } }));
  expect(deleted.events).toContainEqual(expect.objectContaining({ type: 'item.complete', kind: 'tool.call', native: deleted.native,
    data: expect.objectContaining({ status: 'completed' }) }));
  expect(replay.adapter.nativeState('controlled-task-session').planTasks).toEqual([]);
});
