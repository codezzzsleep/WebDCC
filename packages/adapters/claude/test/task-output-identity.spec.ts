import { expect, it } from 'vitest';
import { reduceTurn, resolveAnswer, type AdapterEvent, type StoredEvent, type TraceFrame } from '@webdcc/protocol';
import { ClaudeAdapter } from '../src/adapter.js';

const frame = (i: number, value: unknown): TraceFrame => ({ i, t: i, dir: 'in', ch: 'sdk', frame: value });
const assistant = (parent: string | null, text: string, id = 'message') => ({ type: 'assistant', uuid: `${parent ?? 'main'}-${id}`,
  session_id: 'native', parent_tool_use_id: parent, message: { id, stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
function stored(events: AdapterEvent[]): StoredEvent[] {
  return events.flatMap((event, seq) => event.type === 'item.start' || event.type === 'item.complete'
    ? [{ sessionId: 'web', seq: seq + 1, turnId: 'turn', at: new Date(seq).toISOString(), itemKey: event.itemKey, kind: event.kind, data: event.data as StoredEvent['data'], native: event.native }] : []);
}
const firstKey = (events: AdapterEvent[]) => events.find((event): event is Extract<AdapterEvent, { type: 'item.start' | 'item.complete' }> => event.type === 'item.start' || event.type === 'item.complete')?.itemKey;

it('preserves stream/message/block/parent identities for interleaved child output and keeps the parent independent', () => {
  const replay = ClaudeAdapter.replay('web');
  replay.feed(frame(1, { type: 'system', subtype: 'task_started', session_id: 'native', task_id: 'child', run_id: 'run',
    tool_use_id: 'spawn', description: 'child', is_backgrounded: true }));
  replay.feed(frame(2, { type: 'stream_event', session_id: 'native', parent_tool_use_id: 'spawn', event: { type: 'message_start', message: { id: 'same-message' } } }));
  const start = replay.feed(frame(3, { type: 'stream_event', session_id: 'native', parent_tool_use_id: 'spawn',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }));
  const delta = replay.feed(frame(4, { type: 'stream_event', session_id: 'native', parent_tool_use_id: 'spawn',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'CHILD' } } }));
  const parent = replay.feed(frame(5, assistant(null, 'PARENT', 'same-message')));
  const child = replay.feed(frame(6, assistant('spawn', 'CHILD', 'same-message')));
  const origin = { agent: 'claude-code', nativeSessionId: 'native', parentToolUseId: 'spawn', nativeMessageId: 'same-message', blockIndex: 0, taskId: 'child', runId: 'run' };
  expect(start).toContainEqual(expect.objectContaining({ type: 'item.start', kind: 'assistant.message', scope: 'session', data: expect.objectContaining({ text: '', claudeActor: origin }) }));
  expect(child).toContainEqual(expect.objectContaining({ type: 'item.complete', kind: 'assistant.message', scope: 'session', data: expect.objectContaining({ text: 'CHILD', claudeActor: origin }) }));
  expect(delta).toContainEqual(expect.objectContaining({ type: 'item.delta', scope: 'session', append: 'CHILD' }));
  expect(firstKey(child)).toBe(firstKey(start));
  expect(firstKey(child)).not.toBe(firstKey(parent));
});

it('excludes child native end_turn blocks from parent answers, including old persisted rows', () => {
  const replay = ClaudeAdapter.replay('web');
  const events = stored([...replay.feed(frame(1, assistant(null, 'PARENT'))), ...replay.feed(frame(2, assistant('spawn', 'CHILD')))]);
  expect(resolveAnswer(events)).toEqual([{ itemKey: events[0]!.itemKey, text: 'PARENT' }]);
  const completion: StoredEvent<'turn.completed'> = { sessionId: 'web', turnId: 'turn', seq: 3, at: new Date(3).toISOString(), itemKey: 'done',
    kind: 'turn.completed', data: { status: 'completed', durationMs: 3, answerItemKeys: events.map(event => event.itemKey) } };
  expect(reduceTurn([...events, completion], []).answer).toEqual([{ itemKey: events[0]!.itemKey, text: 'PARENT' }]);
  expect(resolveAnswer([events[1]!])).toEqual([]);
});

it('preserves the child source on actual tool execution/results without attaching them to the parent turn', () => {
  const replay = ClaudeAdapter.replay('web');
  const start = replay.feed(frame(1, { type: 'assistant', uuid: 'child-tools', session_id: 'native', parent_tool_use_id: 'spawn',
    message: { id: 'tools-message', content: [{ type: 'tool_use', id: 'child-read', name: 'Read', input: { file_path: '/tmp/child.txt' } }] } }));
  const result = replay.feed(frame(2, { type: 'user', session_id: 'native', parent_tool_use_id: 'spawn',
    message: { content: [{ type: 'tool_result', tool_use_id: 'child-read', content: 'CHILD FILE' }] } }));
  expect(start).toContainEqual(expect.objectContaining({ type: 'item.start', kind: 'file.read', scope: 'session',
    data: expect.objectContaining({ claudeActor: expect.objectContaining({ parentToolUseId: 'spawn', nativeMessageId: 'tools-message' }) }) }));
  expect(result).toContainEqual(expect.objectContaining({ type: 'item.complete', kind: 'file.read', scope: 'session',
    data: expect.objectContaining({ output: 'CHILD FILE', claudeActor: expect.objectContaining({ parentToolUseId: 'spawn', nativeMessageId: 'tools-message' }) }) }));
});

it('keeps a child TaskList result from clearing the parent plan while retaining the child result', () => {
  const replay = ClaudeAdapter.replay('web');
  const use = (i: number, parent: string | null, id: string, name: string) => replay.feed(frame(i, { type: 'assistant', uuid: id,
    session_id: 'native', parent_tool_use_id: parent, message: { id, content: [{ type: 'tool_use', id, name, input: {} }] } }));
  const result = (i: number, parent: string | null, id: string, value: unknown) => replay.feed(frame(i, { type: 'user',
    session_id: 'native', parent_tool_use_id: parent, tool_use_result: value,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(value) }] } }));
  use(1, null, 'root-create', 'TaskCreate');
  result(2, null, 'root-create', { task: { id: 'root-plan', subject: 'Parent plan' } });
  use(3, 'spawn', 'child-list', 'TaskList');
  const child = result(4, 'spawn', 'child-list', { tasks: [] });
  expect(replay.adapter.nativeState('web').planTasks).toEqual([{ id: 'root-plan', text: 'Parent plan', status: 'pending' }]);
  expect(child).toContainEqual(expect.objectContaining({ type: 'item.complete', kind: 'tool.call', scope: 'session',
    data: expect.objectContaining({ name: 'TaskList', output: '{"tasks":[]}' }) }));
});
