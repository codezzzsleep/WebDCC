import { expect, it } from 'vitest';
import { currentCodexSubagents, type AdapterEvent, type CodexSubagentView, type StoredEvent } from '@webdcc/protocol';
import { CodexAdapter } from '../src/adapter.js';
import type { ThreadItem } from '../src/schema/v2/ThreadItem.js';
import type { CollabAgentState } from '../src/schema/v2/CollabAgentState.js';
import type { CollabAgentToolCallStatus } from '../src/schema/v2/CollabAgentToolCallStatus.js';

type States = Record<string, CollabAgentState>;
const parent = 'parent';
function fixture(seed: readonly CodexSubagentView[] = [], prior: readonly StoredEvent[] = [], startRoot = true) {
  const replay = CodexAdapter.replay('session', parent, seed);
  const events: AdapterEvent[] = [];
  const stored: StoredEvent[] = [...prior];
  let index = 0;
  const feed = (method: string, params: Record<string, unknown>) => {
    const emitted = replay.feed({ i: ++index, t: index, dir: 'in', ch: 'rpc', frame: { method, params } });
    events.push(...emitted);
    for (const event of emitted) if (event.type === 'item.complete') stored.push({
      sessionId: 'session', seq: stored.length + 1, turnId: null, itemKey: event.itemKey,
      at: 'controlled', kind: event.kind, data: event.data, native: event.native,
    });
    return emitted;
  };
  const call = (id: string, states: States, status: CollabAgentToolCallStatus, turnId = 'root', senderThreadId = parent,
    tool: 'spawnAgent' | 'wait' = 'wait', receiverThreadIds = Object.keys(states)) => feed(status === 'inProgress' ? 'item/started' : 'item/completed', {
      threadId: parent, turnId, item: { type: 'collabAgentToolCall', id, tool, status, senderThreadId,
        receiverThreadIds, prompt: null, model: null, reasoningEffort: null, agentsStates: states } satisfies ThreadItem,
    });
  const spawn = (childId = 'child') => call('spawn-' + childId, {}, 'completed', 'root', parent, 'spawnAgent', [childId]);
  if (startRoot) feed('turn/started', { threadId: parent, turn: { id: 'root', status: 'inProgress' } });
  return { replay, feed, call, spawn, events, stored, children: () => currentCodexSubagents(stored) };
}

it.each(['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound'] as const)(
  'retains the native %s child state, message and original parent call identity without inventing a child turn', status => {
    const f = fixture(); f.spawn();
    const message = '原生 ' + status + '\r\n🐈';
    f.call('query:string:identity', {}, 'inProgress');
    f.call('query:string:identity', { child: { status, message } }, 'completed');
    expect(f.children()).toMatchObject([{ childId: 'child', parentThreadId: parent, nativeStatus: status,
      turns: {}, snapshots: [{ callId: 'query:string:identity', senderThreadId: parent, nativeTurnId: 'root',
        tool: 'wait', callStatus: 'completed', status, message, applied: true }] }]);
    expect(f.children()[0]?.nativeTurnId).toBeUndefined();
    expect(f.events.filter(event => event.type === 'turn.start')).toHaveLength(1);
    expect(f.events.some(event => event.type === 'item.complete' && event.kind === 'assistant.message')).toBe(false);
  });

it('retains a query observation without replacing the newer child turn that started during its read', () => {
  const f = fixture(); f.spawn();
  f.feed('turn/started', { threadId: 'child', turn: { id: 'child-old', status: 'inProgress' } });
  f.call('old-query', {}, 'inProgress');
  f.feed('turn/started', { threadId: 'child', turn: { id: 'child-new', status: 'inProgress' } });
  f.call('old-query', { child: { status: 'completed', message: 'Old child result' } }, 'completed');
  expect(f.children()).toMatchObject([{ nativeStatus: 'running', nativeTurnId: 'child-new',
    snapshots: [{ callId: 'old-query', status: 'completed', message: 'Old child result', applied: false }] }]);
  expect(f.events.filter(event => event.type === 'turn.start')).toHaveLength(1);
});

it('a later query that returns first stays authoritative after an old return or repeated lifecycle frames', () => {
  const f = fixture(); f.spawn();
  f.call('old', {}, 'inProgress'); f.call('new', {}, 'inProgress');
  const newer = { child: { status: 'errored' as const, message: 'New query error' } };
  const older = { child: { status: 'completed' as const, message: 'Old query result' } };
  f.call('new', newer, 'completed'); f.call('old', older, 'completed');
  f.call('old', {}, 'inProgress'); f.call('old', older, 'completed'); f.call('new', newer, 'completed');
  expect(f.children()).toMatchObject([{ nativeStatus: 'errored', snapshots: [
    { callId: 'new', message: 'New query error', applied: true },
    { callId: 'old', message: 'Old query result', applied: false },
  ] }]);
  expect(f.children()[0]?.snapshots).toHaveLength(2);
});

it('preserves distinct original turns when the same call string is reused', () => {
  const f = fixture(); f.spawn();
  f.call('same-call', {}, 'inProgress');
  f.call('same-call', { child: { status: 'running', message: 'First observation' } }, 'completed');
  f.feed('turn/started', { threadId: parent, turn: { id: 'root-next', status: 'inProgress' } });
  f.call('same-call', {}, 'inProgress', 'root-next');
  f.call('same-call', { child: { status: 'completed', message: 'Second observation' } }, 'completed', 'root-next');
  expect(f.children()[0]?.snapshots).toMatchObject([
    { callId: 'same-call', nativeTurnId: 'root', message: 'First observation' },
    { callId: 'same-call', nativeTurnId: 'root-next', message: 'Second observation' },
  ]);
  expect(f.children()[0]?.nativeStatus).toBe('completed');
});

it('restored call identities cannot reproject an old query after a new child turn', () => {
  const f = fixture(); f.spawn();
  f.call('finished-query', {}, 'inProgress');
  const states = { child: { status: 'completed' as const, message: 'Retained original result' } };
  f.call('finished-query', states, 'completed');
  const next = fixture(f.children(), f.stored, false);
  next.feed('turn/started', { threadId: 'child', turn: { id: 'new-after-reconnect', status: 'inProgress' } });
  next.call('finished-query', {}, 'inProgress'); next.call('finished-query', states, 'completed');
  expect(next.children()).toMatchObject([{ nativeStatus: 'running', nativeTurnId: 'new-after-reconnect',
    snapshots: [{ callId: 'finished-query', message: 'Retained original result' }] }]);
  expect(next.children()[0]?.snapshots).toHaveLength(1);
  expect(next.events.some(event => event.type === 'turn.start')).toBe(false);
});

it('does not fabricate a parent edge for an unknown target in an otherwise valid query', () => {
  const f = fixture(); f.spawn();
  f.call('query-with-peer', {}, 'inProgress');
  f.call('query-with-peer', { child: { status: 'completed', message: 'Owned child' },
    peer: { status: 'completed', message: 'Unknown peer' } }, 'completed');
  expect(f.children()).toHaveLength(1);
  expect(f.children()[0]?.snapshots).toMatchObject([{ message: 'Owned child' }]);
  expect(f.stored.some(event => event.native && JSON.stringify(event.native).includes('Unknown peer'))).toBe(true);
});

it('does not apply a collab snapshot whose sender contradicts the notification thread', () => {
  const f = fixture(); f.spawn();
  f.call('foreign-query', {}, 'inProgress', 'root', 'unrelated-sender');
  f.call('foreign-query', { child: { status: 'completed', message: 'Foreign result' } }, 'completed', 'root', 'unrelated-sender');
  expect(f.children()[0]?.nativeStatus).toBe('unknown');
  expect(f.children()[0]?.snapshots).toBeUndefined();
  expect(f.stored.some(event => event.native && JSON.stringify(event.native).includes('Foreign result'))).toBe(true);
});

it('keeps an unreviewed state as native evidence without claiming a successful or running child', () => {
  const f = fixture(); f.spawn();
  f.call('unreviewed-state', {}, 'inProgress');
  f.call('unreviewed-state', { child: { status: 'future-state', message: 'Original unsupported state' } as unknown as CollabAgentState }, 'completed');
  expect(f.children()).toMatchObject([{ nativeStatus: 'unknown', snapshots: [
    { status: 'future-state', message: 'Original unsupported state', applied: false },
  ] }]);
  const emitted = f.events.filter(event => event.type === 'item.complete' && event.kind === 'tool.call' && event.data.name === 'subagent');
  expect(emitted.at(-1)).toMatchObject({ data: { status: 'unknown' } });
});

it.each([null, ''])('preserves the original nullable or empty message (%j)', message => {
  const f = fixture(); f.spawn(); f.call('nullable', {}, 'inProgress');
  f.call('nullable', { child: { status: 'completed', message } }, 'completed');
  expect(f.children()[0]?.snapshots).toMatchObject([{ message }]);
});

it.each([undefined, { callId: 'invalid-snapshot' }])('preserves old rows and their child results when a valid snapshot is absent', snapshot => {
  const event: StoredEvent<'tool.call'> = { sessionId: 'session', seq: 1, turnId: null, itemKey: 'legacy-child', at: 'legacy', kind: 'tool.call',
    data: { name: 'subagent', status: 'completed', input: { agent: 'codex', childId: 'child', parentThreadId: parent, nativeStatus: 'completed' },
      output: { result: { nativeTurnId: 'legacy-turn', itemId: 'legacy-message', text: 'Existing native result' }, collabSnapshot: snapshot } } };
  expect(currentCodexSubagents([event])).toMatchObject([{ nativeStatus: 'completed', results: [{ text: 'Existing native result' }] }]);
  expect(currentCodexSubagents([event])[0]?.snapshots).toBeUndefined();
});
