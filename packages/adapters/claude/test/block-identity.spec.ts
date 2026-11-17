import { expect, it } from 'vitest';
import { isValidEventData, resolveAnswer, type AdapterEvent, type StoredEvent, type TraceFrame } from '@webdcc/protocol';
import { ClaudeAdapter } from '../src/adapter.js';

type Item = Extract<AdapterEvent, { type: 'item.start' | 'item.complete' }>;
const frame = (i: number, value: unknown): TraceFrame => ({ i, t: i, dir: 'in', ch: 'sdk', frame: value });
const items = (events: AdapterEvent[]): Item[] => events.filter((event): event is Item => event.type === 'item.start' || event.type === 'item.complete')
  .filter(event => !['internal', 'notice'].includes(event.kind));
const assistant = (content: unknown[], uuid: string, parent: string | null = null, session = 'native', id = 'message') => ({ type: 'assistant',
  uuid, session_id: session, parent_tool_use_id: parent, message: { id, role: 'assistant', model: 'native-model', content, stop_reason: null } });
const read = (id: string, path: string) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: path } });
const result = (toolId: string, output: string, parent: string | null = null, session: string | undefined = 'native', failed = false) => ({ type: 'user',
  ...(session === undefined ? {} : { session_id: session }), parent_tool_use_id: parent,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: output, is_error: failed }] } });

it('delivers mixed complete text/tool/thinking blocks in their native order in replay and the production listener', () => {
  const replay = ClaudeAdapter.replay();
  const observed: AdapterEvent[] = [];
  replay.adapter.onEvent((_id, event) => observed.push(event));
  const delivered = items(replay.feed(frame(1, assistant([
    { type: 'text', text: 'before' }, read('read', '/main.txt'), { type: 'thinking', thinking: 'thought' }, { type: 'text', text: 'after' },
  ], 'mixed'))));
  expect(delivered.map(event => event.kind)).toEqual(['assistant.message', 'file.read', 'reasoning', 'assistant.message']);
  expect(items(observed)).toEqual(delivered);
  expect(new Set(delivered.map(event => event.itemKey)).size).toBe(4);
  expect(delivered.every(event => isValidEventData(event.kind, event.data))).toBe(true);
  const stored = delivered.filter(event => event.type === 'item.complete').map((event, seq) => ({ sessionId: 'web', turnId: 'turn',
    at: new Date(seq).toISOString(), seq, itemKey: event.itemKey, kind: event.kind, data: event.data, native: event.native })) as StoredEvent[];
  expect(resolveAnswer(stored).map(answer => answer.text)).toEqual(['before', 'after']);
});

it('keeps all native block slots when streamed assistant messages deliver one canonical block at a time', () => {
  const replay = ClaudeAdapter.replay();
  const delivered: Item[] = [];
  for (const [i, block] of [read('child-read', '/child.txt'), { type: 'redacted_thinking', data: 'native-opaque' },
    { type: 'thinking', thinking: 'child thought' }, { type: 'text', text: 'child answer' }].entries()) {
    delivered.push(...items(replay.feed(frame(i + 1, assistant([block], `block-${i}`, 'spawn')))));
  }
  expect(delivered.map(event => (event.data as { claudeActor?: { blockIndex?: number } }).claudeActor?.blockIndex)).toEqual([0, 1, 2, 3]);
  expect(delivered.map(event => event.kind)).toEqual(['file.read', 'unknown', 'reasoning', 'assistant.message']);
});

it.each([false, true])('separates main and child tool results with the same opaque ID (child first: %s)', childFirst => {
  const replay = ClaudeAdapter.replay();
  const main = items(replay.feed(frame(1, assistant([read('same', '/main.txt')], 'main', null, 'native', 'main-message'))))[0]!;
  const child = items(replay.feed(frame(2, assistant([read('same', '/child.txt')], 'child', 'spawn', 'native', 'child-message'))))[0]!;
  expect(main.itemKey).not.toBe(child.itemKey);
  const deliver = (childResult: boolean, i: number) => items(replay.feed(frame(i, result('same', childResult ? 'CHILD' : 'MAIN', childResult ? 'spawn' : null))));
  const first = deliver(childFirst, 3), second = deliver(!childFirst, 4);
  const mainResult = childFirst ? second : first, childResult = childFirst ? first : second;
  expect(mainResult).toMatchObject([{ type: 'item.complete', itemKey: main.itemKey, kind: 'file.read', data: { path: '/main.txt', status: 'completed' } }]);
  expect(mainResult[0]?.scope).toBeUndefined();
  expect((mainResult[0]?.data as { claudeActor?: unknown }).claudeActor).toBeUndefined();
  expect(childResult).toMatchObject([{ type: 'item.complete', itemKey: child.itemKey, kind: 'file.read', scope: 'session', data: { path: '/child.txt',
    output: 'CHILD', claudeActor: { nativeSessionId: 'native', parentToolUseId: 'spawn', nativeMessageId: 'child-message', blockIndex: 0 } } }]);
});

it('isolates equal tool IDs across two child actors and native sessions while preserving native failures', () => {
  const replay = ClaudeAdapter.replay();
  const targets = [['spawn-a', 'native', '/a.txt'], ['spawn-b', 'native', '/b.txt'], ['spawn-a', 'other-native', '/c.txt']] as const;
  const starts = targets.map(([parent, session, path], i) => items(replay.feed(frame(i + 1, assistant([read('same', path)], `call-${i}`, parent, session))))[0]!);
  expect(new Set(starts.map(event => event.itemKey)).size).toBe(3);
  for (const [i, [parent, session, path]] of targets.entries()) {
    const finished = items(replay.feed(frame(i + 4, result('same', `OUTPUT ${path}`, parent, session, i === 1))));
    expect(finished).toMatchObject([{ itemKey: starts[i]!.itemKey, data: { path, status: i === 1 ? 'failed' : 'completed', claudeActor: { parentToolUseId: parent, nativeSessionId: session } } }]);
  }
});

it('allows SDK optional result session IDs only when the explicit actor identifies one current call', () => {
  const replay = ClaudeAdapter.replay();
  const root = items(replay.feed(frame(1, assistant([read('same', '/root.txt')], 'root'))))[0]!;
  const child = items(replay.feed(frame(2, assistant([read('same', '/child.txt')], 'child', 'spawn'))))[0]!;
  expect(items(replay.feed(frame(3, result('same', 'ROOT', null, undefined))))).toMatchObject([{ itemKey: root.itemKey, data: { path: '/root.txt' } }]);
  expect(items(replay.feed(frame(4, result('same', 'CHILD', 'spawn', undefined))))).toMatchObject([{ itemKey: child.itemKey, data: { output: 'CHILD' } }]);
});

it('retains unmatched or ambiguous tool results without completing a different actor/session call', () => {
  const replay = ClaudeAdapter.replay();
  const a = items(replay.feed(frame(1, assistant([read('same', '/a.txt')], 'a', 'spawn', 'native-a'))))[0]!;
  const b = items(replay.feed(frame(2, assistant([read('same', '/b.txt')], 'b', 'spawn', 'native-b'))))[0]!;
  for (const [i, value] of [result('same', 'AMBIGUOUS', 'spawn', undefined), result('same', 'WRONG ACTOR', null, 'native-a')].entries()) {
    expect(items(replay.feed(frame(i + 3, value)))).toMatchObject([{ kind: 'unknown', native: value }]);
  }
  expect(items(replay.feed(frame(5, result('same', 'A', 'spawn', 'native-a'))))).toMatchObject([{ itemKey: a.itemKey, data: { path: '/a.txt', output: 'A' } }]);
  expect(items(replay.feed(frame(6, result('same', 'B', 'spawn', 'native-b'))))).toMatchObject([{ itemKey: b.itemKey, data: { path: '/b.txt', output: 'B' } }]);
});

it('does not reopen an already completed canonical tool when the native full message is subsequently delivered', () => {
  const replay = ClaudeAdapter.replay();
  const block = read('read', '/main.txt');
  const start = items(replay.feed(frame(1, assistant([block], 'tool-block'))))[0]!;
  expect(items(replay.feed(frame(2, result('read', 'FINISHED'))))).toMatchObject([{ itemKey: start.itemKey, data: { status: 'completed' } }]);
  const full = frame(3, assistant([block, { type: 'text', text: 'after tool' }], 'full'));
  expect(items(replay.feed(full))).toMatchObject([{ kind: 'assistant.message', data: { text: 'after tool' } }]);
  expect(items(replay.feed(full))).toEqual([]);
});

it('preserves a tool partial index and its native block source through canonical delivery and execution failure', () => {
  const replay = ClaudeAdapter.replay();
  const stream = (event: unknown) => ({ type: 'stream_event', session_id: 'native', parent_tool_use_id: 'spawn', event });
  replay.feed(frame(1, stream({ type: 'message_start', message: { id: 'message' } })));
  replay.feed(frame(2, stream({ type: 'content_block_start', index: 3, content_block: read('read', '/child.txt') })));
  const start = items(replay.feed(frame(3, assistant([read('read', '/child.txt')], 'tool', 'spawn'))))[0]!;
  expect(start.data).toMatchObject({ claudeBlock: { nativeMessageId: 'message', blockIndex: 3, queryId: 'replay:replay' }, claudeActor: { blockIndex: 3 } });
  const completed = items(replay.feed(frame(4, result('read', 'FAILED', 'spawn', 'native', true))))[0]!;
  expect(completed.data).toMatchObject({ path: '/child.txt', status: 'failed', error: 'FAILED',
    claudeBlock: { nativeMessageId: 'message', blockIndex: 3, queryId: 'replay:replay' }, claudeActor: { blockIndex: 3 } });
  expect(completed.itemKey).toBe(start.itemKey);
});

it('does not guess which block completed when one actor has two active native calls with the same ID', () => {
  const replay = ClaudeAdapter.replay();
  const starts = items(replay.feed(frame(1, assistant([read('same', '/first.txt'), read('same', '/second.txt')], 'duplicate-id'))));
  expect(new Set(starts.map(event => event.itemKey)).size).toBe(2);
  const native = result('same', 'UNATTRIBUTABLE');
  expect(items(replay.feed(frame(2, native)))).toMatchObject([{ kind: 'unknown', native }]);
});

it('uses the current partial slot when the same message contains another tool block with a repeated ID', () => {
  const replay = ClaudeAdapter.replay();
  const stream = (event: unknown) => ({ type: 'stream_event', session_id: 'native', parent_tool_use_id: null, event });
  replay.feed(frame(1, stream({ type: 'message_start', message: { id: 'message' } })));
  replay.feed(frame(2, stream({ type: 'content_block_start', index: 0, content_block: read('same', '/first.txt') })));
  const first = items(replay.feed(frame(3, assistant([read('same', '/first.txt')], 'first'))))[0]!;
  replay.feed(frame(4, stream({ type: 'content_block_start', index: 4, content_block: read('same', '/second.txt') })));
  const second = items(replay.feed(frame(5, assistant([read('same', '/second.txt')], 'second'))))[0]!;
  expect(second.data).toMatchObject({ path: '/second.txt', claudeBlock: { blockIndex: 4 } });
  expect(second.itemKey).not.toBe(first.itemKey);
  expect(items(replay.feed(frame(6, result('same', 'AMBIGUOUS'))))).toMatchObject([{ kind: 'unknown' }]);
});
