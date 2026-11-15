import { expect, it } from 'vitest';
import type { AdapterEvent, TraceFrame } from '@webdcc/protocol';
import { ClaudeAdapter } from './adapter.js';

function stream(type: string, value: Record<string, unknown> = {}, parent: string | null = null): TraceFrame {
  return { i: 1, t: 1, dir: 'in', ch: 'sdk', frame: { type: 'stream_event', session_id: 'native-session', parent_tool_use_id: parent, event: { type, ...value } } };
}
function complete(id: string, content: Record<string, unknown>[], uuid = id, parent: string | null = null): TraceFrame {
  return { i: 2, t: 2, dir: 'in', ch: 'sdk', frame: { type: 'assistant', session_id: 'native-session', parent_tool_use_id: parent, uuid, message: { id, content } } };
}
const completions = (events: AdapterEvent[]) => events.filter((event): event is Extract<AdapterEvent, { type: 'item.complete' }> => event.type === 'item.complete' && ['assistant.message', 'reasoning'].includes(event.kind));

it('NP-09 completes two text blocks with their own canonical text and original live identities', () => {
  const replay = ClaudeAdapter.replay();
  replay.feed(stream('message_start', { message: { id: 'message' } }));
  const starts = [0, 1].flatMap(index => {
    const start = replay.feed(stream('content_block_start', { index, content_block: { type: 'text' } }));
    replay.feed(stream('content_block_delta', { index, delta: { type: 'text_delta', text: `stream ${index}` } }));
    return start.filter(event => event.type === 'item.start');
  });
  const result = completions(replay.feed(complete('message', [{ type: 'text', text: 'first final' }, { type: 'text', text: 'second final' }])));
  expect(result.map(event => event.data)).toEqual([{ text: 'first final' }, { text: 'second final' }]);
  expect(result.map(event => event.itemKey)).toEqual(starts.map(event => event.itemKey));
});

it('NP-09 handles single-block SDK deliveries without completing other blocks in the same message', () => {
  const replay = ClaudeAdapter.replay();
  replay.feed(stream('message_start', { message: { id: 'mixed' } }));
  replay.feed(stream('content_block_start', { index: 0, content_block: { type: 'thinking' } }));
  replay.feed(stream('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'thinking' } }));
  const first = completions(replay.feed(complete('mixed', [{ type: 'thinking', thinking: 'thought' }], 'block-zero')));
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ kind: 'reasoning', data: { text: 'thought' } });
  const start = replay.feed(stream('content_block_start', { index: 1, content_block: { type: 'text' } })).find(event => event.type === 'item.start');
  replay.feed(stream('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'stream' } }));
  const second = completions(replay.feed(complete('mixed', [{ type: 'text', text: 'answer' }], 'block-one')));
  expect(second).toHaveLength(1);
  expect(second[0]).toMatchObject({ kind: 'assistant.message', itemKey: start?.type === 'item.start' ? start.itemKey : undefined, data: { text: 'answer' } });
});

it('NP-09 isolates equal block indices across main and child actors', () => {
  const replay = ClaudeAdapter.replay();
  const starts: string[] = [];
  for (const parent of [null, 'parent-tool']) {
    replay.feed(stream('message_start', { message: { id: 'same-model-message-id' } }, parent));
    const start = replay.feed(stream('content_block_start', { index: 0, content_block: { type: 'text' } }, parent)).find(event => event.type === 'item.start');
    if (start?.type === 'item.start') starts.push(start.itemKey);
  }
  expect(new Set(starts).size).toBe(2);
  const child = completions(replay.feed(complete('same-model-message-id', [{ type: 'text', text: 'child' }], 'child-uuid', 'parent-tool')));
  const main = completions(replay.feed(complete('same-model-message-id', [{ type: 'text', text: 'main' }], 'main-uuid')));
  expect(child.map(event => event.itemKey)).toEqual([starts[1]]);
  expect(main.map(event => event.itemKey)).toEqual([starts[0]]);
  expect(child[0]?.data).toEqual({ text: 'child' });
  expect(main[0]?.data).toEqual({ text: 'main' });
});

it('NP-09 preserves mixed thinking/text without partials, unique messages, and duplicate-delivery identity', () => {
  const replay = ClaudeAdapter.replay();
  const mixed = complete('first', [{ type: 'thinking', thinking: 'thought' }, { type: 'text', text: 'text' }]);
  const first = completions(replay.feed(mixed));
  expect(first.map(event => event.data)).toEqual([{ text: 'thought' }, { text: 'text' }]);
  expect(completions(replay.feed(mixed))).toHaveLength(0);
  const second = completions(replay.feed(complete('second', [{ type: 'text', text: 'text' }])));
  expect(second).toHaveLength(1);
  expect(second[0]?.itemKey).not.toBe(first[1]?.itemKey);
});

it('NP-09 retains system compaction, tasks and unknown native system envelopes', () => {
  const replay = ClaudeAdapter.replay();
  const system = (subtype: string, value: Record<string, unknown>) => replay.feed({ i: 1, t: 0, dir: 'in', ch: 'sdk', frame: { type: 'system', subtype, session_id: 'native', uuid: subtype, ...value } });
  expect(system('compact_boundary', { compact_metadata: { trigger: 'auto', pre_tokens: 9000 } })).toContainEqual(expect.objectContaining({ kind: 'notice', native: expect.objectContaining({ compact_metadata: { trigger: 'auto', pre_tokens: 9000 } }) }));
  expect(system('task_notification', { task_id: 'task', run_id: 'run', status: 'failed', output_file: '/tmp/output', summary: 'failed task' })).toContainEqual(expect.objectContaining({ kind: 'tool.call', data: expect.objectContaining({ name: 'claude-task', status: 'failed', input: expect.objectContaining({ taskId: 'task', runId: 'run', nativeStatus: 'failed' }) }) }));
  expect(system('future_extension', { preserved: 42 })).toContainEqual(expect.objectContaining({ kind: 'unknown', native: expect.objectContaining({ preserved: 42 }) }));
});

it('NP-09 distinguishes native execution errors from explicit aborted turns', () => {
  const replay = ClaudeAdapter.replay();
  const result = (terminal_reason: string) => replay.feed({ i: 1, t: 0, dir: 'in', ch: 'sdk', frame: { type: 'result', subtype: 'error_during_execution', terminal_reason, is_error: true, errors: ['native error'] } });
  expect(result('api_error')).toContainEqual(expect.objectContaining({ type: 'turn.end', status: 'failed' }));
  expect(result('aborted_tools')).toContainEqual(expect.objectContaining({ type: 'turn.end', status: 'interrupted' }));
});

it('NP-09 a main result leaves a background child content block open', () => {
  const replay = ClaudeAdapter.replay();
  replay.feed(stream('message_start', { message: { id: 'main' } }));
  replay.feed(stream('content_block_start', { index: 0, content_block: { type: 'text' } }));
  replay.feed(stream('message_start', { message: { id: 'child' } }, 'parent-tool'));
  const child = replay.feed(stream('content_block_start', { index: 0, content_block: { type: 'text' } }, 'parent-tool')).find(event => event.type === 'item.start');
  const result = completions(replay.feed({ i: 3, t: 3, dir: 'in', ch: 'sdk', frame: { type: 'result', session_id: 'native-session', is_error: false } }));
  expect(result).toHaveLength(1);
  expect(result[0]?.itemKey).not.toBe(child?.type === 'item.start' ? child.itemKey : undefined);
  const done = completions(replay.feed(complete('child', [{ type: 'text', text: 'child finish' }], 'child-complete', 'parent-tool')));
  expect(done[0]?.itemKey).toBe(child?.type === 'item.start' ? child.itemKey : undefined);
});
