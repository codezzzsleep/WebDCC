import { expect, it } from 'vitest';
import { currentCodexSubagents, isValidEventData, type AdapterEvent, type CodexSubagentView, type StoredEvent } from '@webdcc/protocol';
import { CodexAdapter } from '../src/adapter.js';
import type { ThreadItem } from '../src/schema/v2/ThreadItem.js';
import type { AgentMessageDeltaNotification } from '../src/schema/v2/AgentMessageDeltaNotification.js';

const parent = 'parent:string:identity';
const message = (id: string, text: string, phase: 'commentary' | 'partial_answer' | 'final_answer' | null = null): ThreadItem => ({
  type: 'agentMessage', id, text, phase, memoryCitation: null, delivery: null, questions: null,
});

function fixture(seed: readonly CodexSubagentView[] = [], prior: readonly StoredEvent[] = [], startParent = true) {
  const replay = CodexAdapter.replay('session', parent, seed);
  const events: AdapterEvent[] = [];
  const stored: StoredEvent[] = [...prior];
  let index = 0;
  const feed = (method: string, params: Record<string, unknown>) => {
    const frame = { method, params };
    const emitted = replay.feed({ i: ++index, t: index, dir: 'in', ch: 'rpc', frame });
    events.push(...emitted);
    for (const event of emitted) if (event.type === 'item.complete') {
      expect(isValidEventData(event.kind, event.data)).toBe(true);
      stored.push({ sessionId: 'session', seq: stored.length + 1, turnId: null, itemKey: event.itemKey,
        at: 'controlled', kind: event.kind, data: event.data as StoredEvent['data'], native: event.native });
    }
    return emitted;
  };
  const start = (childId = 'child-a', turnId = 'child-turn') => {
    feed('item/completed', { threadId: parent, turnId: 'parent-turn', item: {
      type: 'collabAgentToolCall', id: 'spawn-' + childId, tool: 'spawnAgent', status: 'completed', senderThreadId: parent,
      receiverThreadIds: [childId], prompt: null, model: null, reasoningEffort: null, agentsStates: {},
    } satisfies ThreadItem });
    feed('turn/started', { threadId: childId, turn: { id: turnId, rootTurnId: 'parent-turn', status: 'inProgress' } });
  };
  const delta = (text: string, childId = 'child-a', turnId = 'child-turn', itemId = 'shared:item') =>
    feed('item/agentMessage/delta', { threadId: childId, turnId, itemId, delta: text } satisfies AgentMessageDeltaNotification);
  const complete = (text: string, childId = 'child-a', turnId = 'child-turn', itemId = 'shared:item') =>
    feed('item/completed', { threadId: childId, turnId, item: message(itemId, text, 'final_answer') });
  const end = (status: string, childId = 'child-a', turnId = 'child-turn') =>
    feed('turn/completed', { threadId: childId, turn: { id: turnId, status } });
  const wait = (status: 'inProgress' | 'completed') => feed(status === 'inProgress' ? 'item/started' : 'item/completed', {
    threadId: parent, turnId: 'parent-turn', item: {
      type: 'collabAgentToolCall', id: 'wait:string:identity', tool: 'wait', status, senderThreadId: parent,
      receiverThreadIds: ['child-a'], prompt: null, model: null, reasoningEffort: null,
      agentsStates: status === 'inProgress' ? {} : { 'child-a': { status: 'completed', message: 'caller snapshot' } },
    } satisfies ThreadItem,
  });
  if (startParent) feed('turn/started', { threadId: parent, turn: { id: 'parent-turn', status: 'inProgress' } });
  return { feed, start, delta, complete, end, wait, events, stored, children: () => currentCodexSubagents(stored) };
}

it('shows two native child text streams before completion without admitting a parent answer or mixing matching item IDs', () => {
  const f = fixture(); f.start('child-a', 'turn:string:🐈'); f.start('child-b', 'turn:string:🐈');
  f.delta(' 原生🐈\r\n', 'child-a', 'turn:string:🐈');
  f.delta('<b>另一子线程</b>', 'child-b', 'turn:string:🐈');
  f.delta('重复重复\t', 'child-a', 'turn:string:🐈');
  expect(f.children()).toMatchObject([
    { childId: 'child-a', nativeStatus: 'running', nativeTurnId: 'turn:string:🐈', results: [
      { nativeTurnId: 'turn:string:🐈', itemId: 'shared:item', text: ' 原生🐈\r\n重复重复\t', incomplete: true },
    ] },
    { childId: 'child-b', nativeStatus: 'running', results: [{ itemId: 'shared:item', text: '<b>另一子线程</b>', incomplete: true }] },
  ]);
  expect(f.events.filter(event => event.type === 'turn.start')).toHaveLength(1);
  expect(f.events.some(event => event.type === 'turn.end' || event.type === 'item.complete' && event.kind === 'assistant.message')).toBe(false);
});

it('preserves the started item text and native phase while a duplicate or late start cannot erase accumulated deltas', () => {
  const f = fixture(); f.start();
  const params = { threadId: 'child-a', turnId: 'child-turn', item: message('shared:item', '初始 ', 'partial_answer') };
  f.feed('item/started', params); f.delta('正文'); f.feed('item/started', params);
  expect(f.children()[0]?.results).toEqual([
    { nativeTurnId: 'child-turn', itemId: 'shared:item', text: '初始 正文', nativePhase: 'partial_answer', incomplete: true },
  ]);
});

it('a delayed started item supplies its native phase without resetting already received child text', () => {
  const f = fixture(); f.start(); f.delta('first observed delta');
  f.feed('item/started', { threadId: 'child-a', turnId: 'child-turn', item: message('shared:item', '', 'commentary') });
  expect(f.children()[0]?.results).toEqual([
    { nativeTurnId: 'child-turn', itemId: 'shared:item', text: 'first observed delta', nativePhase: 'commentary', incomplete: true },
  ]);
});

it('uses native completed text as the authoritative result and keeps late starts and deltas in raw evidence', () => {
  const f = fixture(); f.start(); f.delta('temporary partial');
  f.complete(' 原生不同的终稿\n');
  const late = { threadId: 'child-a', turnId: 'child-turn', itemId: 'shared:item', delta: 'obsolete suffix' };
  const emitted = f.feed('item/agentMessage/delta', late);
  f.feed('item/started', { threadId: 'child-a', turnId: 'child-turn', item: message('shared:item', 'old start') });
  expect(f.children()[0]?.results).toEqual([
    { nativeTurnId: 'child-turn', itemId: 'shared:item', text: ' 原生不同的终稿\n', nativePhase: 'final_answer' },
  ]);
  expect(emitted).toEqual([expect.objectContaining({ kind: 'internal', scope: 'session', native: { method: 'item/agentMessage/delta', params: late } })]);
});

it.each(['interrupted', 'failed', 'completed'])('retains incomplete child text after native turn %s without fabricating a completed message', status => {
  const f = fixture(); f.start(); f.delta('unfinished 🐈'); f.end(status);
  f.delta('late');
  f.feed('item/started', { threadId: 'child-a', turnId: 'child-turn', item: message('shared:item', '') });
  expect(f.children()[0]).toMatchObject({ nativeStatus: status, turns: { 'child-turn': { status } },
    results: [{ nativeTurnId: 'child-turn', itemId: 'shared:item', text: 'unfinished 🐈', incomplete: true }] });
});

it('continues a restored partial result and fences old text after a restored completion without a new parent turn', () => {
  const first = fixture(); first.start(); first.delta('before refresh ');
  const next = fixture(first.children(), first.stored, false); next.delta('after reconnect'); next.complete('native final'); next.end('completed');
  const restored = fixture(next.children(), next.stored, false);
  restored.delta('obsolete after restart');
  restored.feed('item/started', { threadId: 'child-a', turnId: 'child-turn', item: message('shared:item', 'obsolete start') });
  expect(restored.children()[0]?.results).toEqual([
    { nativeTurnId: 'child-turn', itemId: 'shared:item', text: 'native final', nativePhase: 'final_answer' },
  ]);
  expect(next.events.some(event => event.type === 'turn.start' || event.type === 'turn.end')).toBe(false);
  expect(restored.events.every(event => event.type === 'item.complete' && event.kind === 'internal')).toBe(true);
});

it('restores a terminal partial message without reopening it, but accepts the later native completed item', () => {
  const first = fixture(); first.start(); first.delta('interrupted prefix'); first.end('interrupted');
  const next = fixture(first.children(), first.stored, false); next.delta('late suffix');
  expect(next.children()[0]?.results).toMatchObject([{ text: 'interrupted prefix', incomplete: true }]);
  expect(next.events.every(event => event.type === 'item.complete' && event.kind === 'internal')).toBe(true);
  next.complete('late authoritative item');
  expect(next.children()[0]).toMatchObject({ nativeStatus: 'interrupted', results: [{ text: 'late authoritative item', nativePhase: 'final_answer' }] });
  expect(next.children()[0]?.results[0]).not.toHaveProperty('incomplete');
});

it('keeps reused item IDs in separate child turns and old completions cannot replace the current running child state', () => {
  const f = fixture(); f.start(); f.delta('old partial');
  f.feed('turn/started', { threadId: 'child-a', turn: { id: 'new-turn', status: 'inProgress' } });
  f.delta('new partial', 'child-a', 'new-turn'); f.complete('old authoritative final'); f.end('interrupted');
  expect(f.children()[0]).toMatchObject({ nativeTurnId: 'new-turn', nativeStatus: 'running',
    results: [{ nativeTurnId: 'new-turn', itemId: 'shared:item', text: 'new partial', incomplete: true },
      { nativeTurnId: 'child-turn', itemId: 'shared:item', text: 'old authoritative final' }] });
  expect(f.children()[0]?.turns).toEqual({ 'child-turn': { status: 'interrupted' }, 'new-turn': { status: 'inProgress' } });
});

it('a child text delta fences an older caller snapshot without fabricating a child terminal', () => {
  const f = fixture(); f.start(); f.wait('inProgress'); f.delta('new direct child activity'); f.wait('completed');
  expect(f.children()[0]).toMatchObject({ nativeStatus: 'running', results: [{ text: 'new direct child activity', incomplete: true }],
    snapshots: [{ message: 'caller snapshot', applied: false }] });
});

it('text from an older child turn does not invalidate a caller observation of the current turn', () => {
  const f = fixture(); f.start();
  f.feed('turn/started', { threadId: 'child-a', turn: { id: 'new-turn', status: 'inProgress' } });
  f.wait('inProgress'); f.delta('older turn text'); f.wait('completed');
  expect(f.children()[0]).toMatchObject({ nativeTurnId: 'new-turn', nativeStatus: 'completed',
    results: [{ nativeTurnId: 'child-turn', text: 'older turn text', incomplete: true }], snapshots: [{ applied: true }] });
});

it.each([
  { threadId: 'unknown-descendant', turnId: 'child-turn', itemId: 'message', delta: 'unknown lineage' },
  { threadId: 'child-a', itemId: 'message', delta: 'missing turn' },
  { threadId: 'child-a', turnId: 'child-turn', itemId: '', delta: 'missing item' },
  { threadId: 'child-a', turnId: 'child-turn', itemId: 123, delta: 'numeric item' },
  { threadId: 'child-a', turnId: 'child-turn', itemId: 'message', delta: 123 },
])('retains an unassignable child delta as raw evidence without guessing its target: %j', params => {
  const f = fixture(); f.start();
  expect(f.feed('item/agentMessage/delta', params)).toEqual([
    expect.objectContaining({ kind: 'internal', scope: 'session', native: { method: 'item/agentMessage/delta', params } }),
  ]);
  expect(f.children()[0]?.results).toEqual([]);
});

it('stores repeated native delta bytes once per chunk rather than persisting growing prefix copies', () => {
  const f = fixture(); f.start();
  for (let index = 0; index < 100; index++) f.delta('相同🐈 ');
  const deltas = f.stored.filter(event => event.kind === 'tool.call').map(event => event.data as { output?: { resultDelta?: { text: string } } })
    .flatMap(data => data.output?.resultDelta === undefined ? [] : [data.output.resultDelta.text]);
  expect(deltas).toHaveLength(100);
  expect(deltas.join('')).toBe('相同🐈 '.repeat(100));
  expect(f.children()[0]?.results).toMatchObject([{ text: deltas.join(''), incomplete: true }]);
});

it('keeps existing completed child rows unchanged when no additive streaming fields are present', () => {
  const f = fixture(); f.start(); f.complete('legacy completed text');
  expect(currentCodexSubagents(JSON.parse(JSON.stringify(f.stored)) as StoredEvent[])[0]?.results).toEqual([
    { nativeTurnId: 'child-turn', itemId: 'shared:item', text: 'legacy completed text', nativePhase: 'final_answer' },
  ]);
});
