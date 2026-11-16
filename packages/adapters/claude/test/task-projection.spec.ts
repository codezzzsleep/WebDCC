import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import { currentClaudeTasks, type StoredEvent, type TraceFrame } from '@webdcc/protocol';
import { expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/adapter.js';
import { ClaudeNativeState } from '../src/native-state.js';

type System = Extract<SDKMessage, { type: 'system' }>;
const system = <S extends System['subtype']>(subtype: S, fields: Record<string, unknown>): Extract<System, { subtype: S }> =>
  ({ type: 'system', subtype, session_id: 'native', uuid: `controlled-${subtype}`, ...fields }) as unknown as Extract<System, { subtype: S }>;
const started = (run = '002', fields: Record<string, unknown> = {}) => system('task_started', {
  task_id: 'child', run_id: run, description: 'Child task', is_backgrounded: true, task_type: 'local_agent', ...fields,
});
const snapshot = (tasks: Record<string, unknown>[]) => system('background_tasks_changed', { tasks });
const entry = (run = '002', fields: Record<string, unknown> = {}) => ({ task_id: 'child', run_id: run, description: 'Child task', task_type: 'local_agent', ...fields });
const notification = (status: string, run = '002') => system('task_notification', {
  task_id: 'child', run_id: run, status, summary: `${run} ${status}`, output_file: `/tmp/${run}.output`,
});

it('retains native session, parent and agent type when the only evidence is a background snapshot', () => {
  const state = new ClaudeNativeState();
  const message = snapshot([entry('002', { parent_task_id: 'parent', subagent_type: 'general-purpose', ambient: true })]);
  state.system(message);
  expect(state.tasks.get('child')).toMatchObject({ taskId: 'child', runId: '002', nativeSessionId: 'native', parentTaskId: 'parent',
    subagentType: 'general-purpose', background: true, backgroundPresence: 'present', ambient: true, status: 'unknown', native: message.tasks[0] });
});

it.each(['completed', 'failed', 'stopped'])('keeps the %s terminal state through late same-run level and edge deliveries', status => {
  const state = new ClaudeNativeState();
  state.system(started('002', { parent_task_id: 'parent', tool_use_id: 'spawn-tool' }));
  state.system(notification(status));
  state.system(snapshot([entry()]));
  state.system(started());
  state.system(system('task_progress', { task_id: 'child', run_id: '002', description: 'late progress', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } }));
  expect(state.tasks.get('child')).toMatchObject({ status, nativeStatus: status, summary: `002 ${status}`, outputFile: '/tmp/002.output',
    parentTaskId: 'parent', toolUseId: 'spawn-tool', terminalNotification: status });
});

it('starts a newer snapshot run without inheriting the old output, error or usage', () => {
  const state = new ClaudeNativeState();
  state.system(started('001', { parent_task_id: 'old-parent', tool_use_id: 'old-tool' }));
  state.system(system('task_updated', { task_id: 'child', run_id: '001', patch: { error: 'old error' } }));
  state.system(notification('failed', '001'));
  state.system(snapshot([entry('002', { parent_task_id: 'new-parent' })]));
  expect(state.tasks.get('child')).toMatchObject({ runId: '002', parentTaskId: 'new-parent', status: 'unknown', backgroundPresence: 'present' });
  for (const key of ['summary', 'outputFile', 'error', 'toolUseId', 'usage', 'terminalNotification']) expect(state.tasks.get('child')).not.toHaveProperty(key);
});

it('does not invent running from a description-only patch and keeps native killed distinct from a stop notification', () => {
  const state = new ClaudeNativeState();
  state.system(system('task_updated', { task_id: 'child', run_id: '002', patch: { description: 'known identity only' } }));
  expect(state.tasks.get('child')).toMatchObject({ description: 'known identity only', status: 'unknown' });
  state.system(system('task_updated', { task_id: 'child', run_id: '002', patch: { status: 'killed', end_time: 123, total_paused_ms: 12 } }));
  expect(state.tasks.get('child')).toMatchObject({ status: 'stopped', nativeStatus: 'killed', endTime: 123, totalPausedMs: 12 });
  expect(state.tasks.get('child')).not.toHaveProperty('terminalNotification');
});

it('keeps absent background tasks unknown without clearing their last native status or inventing completion', () => {
  const state = new ClaudeNativeState();
  state.system(started());
  state.system(snapshot([entry()]));
  state.system(snapshot([]));
  expect(state.tasks.get('child')).toMatchObject({ status: 'unknown', nativeStatus: 'running', backgroundPresence: 'absent' });
  state.system(started('002', { tool_use_id: 'spawn' }));
  expect(state.tasks.get('child')).toMatchObject({ status: 'unknown', toolUseId: 'spawn', backgroundPresence: 'absent' });
  state.system(notification('completed'));
  expect(state.tasks.get('child')).toMatchObject({ status: 'completed', terminalNotification: 'completed' });
});

it.each(['pending', 'paused'])('does not replace an explicit %s lifecycle with a snapshot membership assumption', status => {
  const state = new ClaudeNativeState();
  state.system(started());
  state.system(system('task_updated', { task_id: 'child', run_id: '002', patch: { status } }));
  state.system(snapshot([entry()]));
  expect(state.tasks.get('child')).toMatchObject({ status, nativeStatus: status, backgroundPresence: 'present' });
});

it('refuses old and unidentified runs in both task edges and background snapshots', () => {
  const state = new ClaudeNativeState();
  state.system(started());
  for (const message of [notification('completed', '001'), started('001'), system('task_updated', { task_id: 'child', patch: { status: 'completed' } })]) expect(state.system(message)).toBe(false);
  state.system(snapshot([entry('001')]));
  state.system(snapshot([{ task_id: 'child', description: 'legacy snapshot', task_type: 'local_agent' }]));
  expect(state.tasks.get('child')).toMatchObject({ runId: '002', description: 'Child task', status: 'running' });
});

it('retains optional progress summary and output origins rather than erasing them on omitted fields', () => {
  const state = new ClaudeNativeState();
  state.system(started('002', { tool_use_id: 'spawn', parent_task_id: 'parent', subagent_type: 'general-purpose' }));
  state.system(system('task_progress', { task_id: 'child', run_id: '002', description: 'work', summary: 'half done',
    last_tool_name: 'Read', usage: { total_tokens: 10, tool_uses: 2, duration_ms: 20 } }));
  state.system(system('task_progress', { task_id: 'child', run_id: '002', description: 'work', usage: { total_tokens: 11, tool_uses: 2, duration_ms: 30 } }));
  expect(state.tasks.get('child')).toMatchObject({ summary: 'half done', toolUseId: 'spawn', parentTaskId: 'parent', subagentType: 'general-purpose', lastToolName: 'Read' });
  const message = system('task_notification', { task_id: 'child', run_id: '002', status: 'stopped', reason: 'worker_restart',
    output_file: '/tmp/native-output', summary: 'worker restarted', resource_links: [{ type: 'resource_link', uri: 'ui://test/file', name: 'file' }] });
  state.system(message);
  expect(state.tasks.get('child')).toMatchObject({ toolUseId: 'spawn', outputFile: '/tmp/native-output', reason: 'worker_restart',
    resourceLinks: message.resource_links, terminalNotification: 'stopped' });
});

it('preserves a late run as raw evidence while excluding it from the production task presentation', () => {
  const replay = ClaudeAdapter.replay('local');
  replay.feed({ i: 1, t: 1, dir: 'in', ch: 'sdk', frame: started() });
  const stale = notification('stopped', '001');
  const events = replay.feed({ i: 2, t: 2, dir: 'in', ch: 'sdk', frame: stale });
  expect(events).toContainEqual(expect.objectContaining({ type: 'item.complete', kind: 'internal', scope: 'session', native: stale,
    data: { nativeType: 'system/task_notification/stale-run' } }));
  expect(events.some(event => event.type === 'item.complete' && event.kind === 'tool.call')).toBe(false);
  expect(replay.adapter.nativeState('local').tasks[0]).toMatchObject({ runId: '002', status: 'running' });
});

it('presents native stopped as its own task outcome rather than a failed tool', () => {
  const replay = ClaudeAdapter.replay('local');
  replay.feed({ i: 1, t: 1, dir: 'in', ch: 'sdk', frame: started() });
  const events = replay.feed({ i: 2, t: 2, dir: 'in', ch: 'sdk', frame: notification('stopped') });
  expect(events).toContainEqual(expect.objectContaining({ type: 'item.complete', kind: 'tool.call', scope: 'session',
    data: expect.objectContaining({ name: 'claude-task', status: 'stopped', input: expect.objectContaining({ taskId: 'child', runId: '002', nativeStatus: 'stopped' }) }) }));
});

it('reuses the captured official SDK level/bookend without inventing a terminal task from its parent turn result', () => {
  const path = new URL('../../../../fixtures/traces/claude-code/default/S06/native.jsonl', import.meta.url);
  const frames = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as TraceFrame);
  const replay = ClaudeAdapter.replay('cached-task-capture');
  const stored: StoredEvent[] = [];
  let seq = 0;
  for (const frame of frames) for (const mapped of replay.feed(frame)) {
    if (mapped.type !== 'item.start' && mapped.type !== 'item.complete') continue;
    stored.push({ sessionId: 'cached-task-capture', seq: ++seq, turnId: null, at: new Date(frame.t).toISOString(),
      itemKey: mapped.itemKey, kind: mapped.kind, data: mapped.data, native: mapped.native });
  }
  const tasks = replay.adapter.nativeState('cached-task-capture').tasks;
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ taskId: 'b1avilice', runId: '0mwcram8t-5fd1d416',
    nativeSessionId: '301baaca-39fb-4f36-b15b-d6ce69cb40ed', taskType: 'local_bash', background: true,
    toolUseId: 'toolu_0123dK7uoKJos8yvVLap13D4', status: 'running' });
  expect(tasks[0]).not.toHaveProperty('terminalNotification');
  expect(currentClaudeTasks(stored)).toEqual(tasks);
});
