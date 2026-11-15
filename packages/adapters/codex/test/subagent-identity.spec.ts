import { expect, it } from 'vitest';
import { CodexAdapter } from '../src/adapter.js';
import type { CodexSubagentView } from '@webdcc/protocol';

it.each([
  ['item/agentMessage/delta', { turnId: 'child-turn', itemId: 'shared', delta: 'child output' }],
  ['item/reasoning/summaryTextDelta', { turnId: 'child-turn', itemId: 'shared', summaryIndex: 0, delta: 'child reasoning' }],
  ['item/commandExecution/outputDelta', { turnId: 'child-turn', itemId: 'shared', delta: 'child command' }],
  ['thread/name/updated', { name: 'child title' }],
  ['thread/goal/updated', { goal: { objective: 'child goal', status: 'active' } }],
  ['thread/tokenUsage/updated', { turnId: 'child-turn', tokenUsage: { last: { inputTokens: 100, outputTokens: 100 } } }],
  ['error', { turnId: 'child-turn', error: { message: 'child stream disconnected' }, willRetry: true }],
] as const)('isolates %s for foreign threads while preserving its exact native frame', (method, params) => {
  const replay = CodexAdapter.replay('session', 'parent');
  replay.feed({ i: 1, t: 1, dir: 'in', ch: 'rpc', frame: { method: 'turn/started', params: { threadId: 'parent', turn: { id: 'parent-turn' } } } });
  const frame = { method, params: { ...params, threadId: 'child' } };
  const events = replay.feed({ i: 2, t: 2, dir: 'in', ch: 'rpc', frame });
  expect(events).toEqual([expect.objectContaining({ type: 'item.complete', kind: 'internal', scope: 'session', native: frame })]);
});

it('nested tasks retain their native parent, and interacting with an ancestor does not reverse the relation', () => {
  const replay = CodexAdapter.replay('session', 'parent'); let index = 0;
  const spawn = (threadId: string, agentThreadId: string, kind = 'started') => replay.feed({ i: ++index, t: index, dir: 'in', ch: 'rpc', frame: { method: 'item/completed', params: { threadId, item: { type: 'subAgentActivity', id: String(index), agentThreadId, agentPath: agentThreadId, kind } } } });
  spawn('parent', 'child');
  const nested = spawn('child', 'grandchild').find(event => event.type === 'item.complete' && event.kind === 'tool.call');
  expect(nested).toMatchObject({ scope: 'session', data: { name: 'subagent', input: { childId: 'grandchild', parentThreadId: 'child' } } });
  expect(spawn('grandchild', 'parent', 'interacted').some(event => event.type === 'item.complete' && event.kind === 'tool.call')).toBe(false);
});

it('restored child identities accept late results without spawning again or admitting a parent turn', () => {
  const child: CodexSubagentView = { agent: 'codex', childId: 'child', parentThreadId: 'parent', nativeTurnId: 'child-turn', rootTurnId: 'old-parent-turn', nativeStatus: 'running', turns: { 'child-turn': { status: 'inProgress' } }, results: [] };
  const replay = CodexAdapter.replay('session', 'parent', [child]);
  const events = replay.feed({ i: 1, t: 1, dir: 'in', ch: 'rpc', frame: { method: 'item/completed', params: { threadId: 'child', turnId: 'child-turn', item: { type: 'agentMessage', id: 'result', text: 'existing task result', phase: 'final_answer' } } } });
  expect(events.find(event => event.type === 'item.complete' && event.kind === 'tool.call')).toMatchObject({ scope: 'session', data: { input: { childId: 'child', parentThreadId: 'parent' }, output: { result: { nativeTurnId: 'child-turn', itemId: 'result', text: 'existing task result' } } } });
  expect(events.some(event => event.type === 'turn.start' || event.type === 'turn.end' || event.type === 'item.complete' && event.kind === 'assistant.message')).toBe(false);
});

it('rootTurnId alone does not fabricate the immediate parent of an unknown descendant', () => {
  const replay = CodexAdapter.replay('session', 'parent');
  replay.feed({ i: 1, t: 1, dir: 'in', ch: 'rpc', frame: { method: 'turn/started', params: { threadId: 'parent', turn: { id: 'root-turn' } } } });
  const frame = { method: 'turn/started', params: { threadId: 'unknown-descendant', turn: { id: 'child-turn', rootTurnId: 'root-turn', status: 'inProgress' } } };
  expect(replay.feed({ i: 2, t: 2, dir: 'in', ch: 'rpc', frame })).toEqual([expect.objectContaining({ type: 'item.complete', kind: 'internal', scope: 'session', native: frame })]);
});
