import { expect, it } from 'vitest';
import { currentClaudeTaskViews, type AdapterEvent, type StoredEvent, type TraceFrame } from '@webdcc/protocol';
import { ClaudeAdapter } from '../src/adapter.js';

const frame = (i: number, value: unknown): TraceFrame => ({ i, t: i, dir: 'in', ch: 'sdk', frame: value });
type Item = Extract<AdapterEvent, { type: 'item.start' | 'item.complete' }>;
const items = (events: AdapterEvent[]): Item[] => events.filter((event): event is Item => event.type === 'item.start' || event.type === 'item.complete')
  .filter(event => event.kind !== 'internal');
const assistant = (id: string, content: unknown[], parent: string | null, aborted = true) => ({ type: 'assistant', uuid: id,
  session_id: 'native', parent_tool_use_id: parent, ...(aborted ? { aborted: true } : {}),
  message: { id, role: 'assistant', model: 'native-model', content, stop_reason: aborted ? null : 'end_turn' } });

it.each(['text', 'thinking'] as const)('retains interrupted %s block content, native origin and incomplete state in each actor', type => {
  const replay = ClaudeAdapter.replay();
  const content = type === 'text' ? { type, text: 'unfinished 中文' } : { type, thinking: 'unfinished 中文', signature: 'native-signature' };
  for (const [i, parent] of [null, 'spawn'].entries()) {
    const native = assistant(`message-${i}`, [content], parent);
    const output = items(replay.feed(frame(i + 1, native)));
    expect(output).toMatchObject([{ type: 'item.complete', kind: type === 'text' ? 'assistant.message' : 'reasoning',
      data: { text: 'unfinished 中文', incomplete: true, claudeBlock: { nativeMessageId: `message-${i}`, parentToolUseId: parent, blockIndex: 0 } }, native }]);
  }
});

it('does not display a truncated new native tool input as an executing command or accept an unobserved result', () => {
  const replay = ClaudeAdapter.replay();
  const native = assistant('partial-tool', [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'incomplete' } }], 'spawn');
  const output = items(replay.feed(frame(1, native)));
  expect(output).toMatchObject([{ type: 'item.complete', kind: 'tool.call', scope: 'session', data: { name: 'Bash', input: { command: 'incomplete' },
    status: 'unknown', incomplete: true, claudeActor: { parentToolUseId: 'spawn' } }, native }]);
  expect(output.some(event => event.type === 'item.start')).toBe(false);
  expect(items(replay.feed(frame(2, { type: 'user', session_id: 'native', parent_tool_use_id: 'spawn',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'no prior canonical execution' }] } })))).toMatchObject([{ kind: 'unknown' }]);
});

it('keeps previously canonical completed tools and normal text separate from a later truncated message delivery', () => {
  const replay = ClaudeAdapter.replay(); const tool = { type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: '/file.txt' } };
  const start = items(replay.feed(frame(1, assistant('tool-block', [tool], 'spawn', false))))[0]!;
  const result = items(replay.feed(frame(2, { type: 'user', session_id: 'native', parent_tool_use_id: 'spawn', message: {
    content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'FILE RESULT' }] } })));
  expect(result).toMatchObject([{ itemKey: start.itemKey, data: { status: 'completed', output: 'FILE RESULT' } }]);
  const late = assistant('tool-block', [tool, { type: 'text', text: 'partial tail' }], 'spawn'); late.uuid = 'later-aborted';
  expect(items(replay.feed(frame(3, late)))).toMatchObject([{ kind: 'assistant.message', data: { text: 'partial tail', incomplete: true } }]);
  const normal = items(replay.feed(frame(4, assistant('normal', [{ type: 'text', text: 'complete answer' }], null, false))))[0]!;
  expect((normal.data as { incomplete?: boolean }).incomplete).not.toBe(true);
});

it('restores old persisted interrupted child text/thinking as incomplete without rewriting its keys or native data', () => {
  const native = assistant('legacy', [{ type: 'text', text: 'old partial' }], 'spawn');
  const stored: StoredEvent[] = [{ sessionId: 'web', turnId: null, seq: 1, at: new Date(1).toISOString(), itemKey: 'old-child-output',
    kind: 'assistant.message', data: { text: 'old partial' }, native }];
  const view = currentClaudeTaskViews(stored);
  expect(view.unassignedOutputs).toMatchObject([{ itemKey: 'old-child-output', text: 'old partial', incomplete: true }]);
  expect(stored[0]?.native).toBe(native); expect(stored[0]?.data).toEqual({ text: 'old partial' });
});

it('a later canonical native delivery can verify a previously truncated tool without changing its ID', () => {
  const replay = ClaudeAdapter.replay();
  const tool = { type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'original' } };
  const partial = items(replay.feed(frame(1, assistant('same-message', [tool], null))))[0]!;
  const complete = assistant('same-message', [tool], null, false); complete.uuid = 'canonical-delivery';
  const verified = items(replay.feed(frame(2, complete)))[0]!;
  expect(verified).toMatchObject({ itemKey: partial.itemKey, type: 'item.start', kind: 'command', data: { status: 'running', command: 'original' } });
  expect(items(replay.feed(frame(3, { type: 'user', session_id: 'native', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'executed' }] } }))))
    .toMatchObject([{ itemKey: partial.itemKey, kind: 'command', data: { status: 'completed', outputTail: 'executed' } }]);
});
