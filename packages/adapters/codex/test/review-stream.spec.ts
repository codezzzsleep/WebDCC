import { expect, it } from 'vitest';
import { CodexAdapter } from '../src/adapter.js';

function fixture() {
  const replay = CodexAdapter.replay('s', 'thread'); let sequence = 0;
  return (method: string, params: Record<string, unknown>) => replay.feed({ i: ++sequence, t: sequence,
    dir: 'in', ch: 'rpc', frame: { method, params: { threadId: 'thread', ...params } } });
}

it('starts the native Review root before early items and binds its separate execution turn without losing either original identity', () => {
  const feed = fixture();
  const early = { turnId: 'review-root', item: { type: 'enteredReviewMode', id: 'enter', review: 'current changes' } };
  const started = feed('item/started', early);
  expect(started[0]).toMatchObject({ type: 'turn.start', nativeTurnId: 'review-root', native: { threadId: 'thread', ...early } });
  const turn = { id: 'execution', rootTurnId: 'review-root', status: 'inProgress' };
  expect(feed('turn/started', { turn })[0]).toMatchObject({ type: 'turn.start', nativeTurnId: 'review-root', native: { turn } });
  expect(feed('item/completed', { turnId: 'review-root', item: { type: 'exitedReviewMode', id: 'result', review: 'Original native Review' } })[0]).toMatchObject({ nativeTurnId: 'review-root' });
  expect(feed('turn/completed', { turn: { id: 'review-root', rootTurnId: 'review-root', status: 'completed' } })[0]).toMatchObject({ type: 'turn.end', nativeTurnId: 'review-root', status: 'completed' });
});

it('does not apply a root alias to an ordinary delegated turn without a same-thread native Review marker', () => {
  const feed = fixture();
  expect(feed('turn/started', { turn: { id: 'delegated', rootTurnId: 'root-work' } })[0]).toMatchObject({ type: 'turn.start', nativeTurnId: 'delegated' });
});

it('replays a correlated native Review acceptance through the same lifecycle handler and keeps opaque request identity', () => {
  const replay = CodexAdapter.replay('s', 'thread');
  const turn = { id: 'root', rootTurnId: null, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null };
  const request = 'review/request:9007199254740993';
  replay.feed({ i: 1, t: 1, dir: 'out', ch: 'rpc', frame: { id: request, method: 'review/start', params: { threadId: 'thread', delivery: 'inline', target: { type: 'uncommittedChanges' } } } });
  replay.feed({ i: 2, t: 2, dir: 'in', ch: 'rpc', frame: { id: request, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'other', itemId: 'command', kind: 'command', environmentId: null, startedAtMs: 1, command: 'cat fixture' } } });
  const result = { reviewThreadId: 'thread', turn };
  expect(replay.feed({ i: 2, t: 2, dir: 'in', ch: 'rpc', frame: { id: request, result } })[0]).toMatchObject({ type: 'turn.start', nativeTurnId: 'root', native: result });
  const marker = replay.feed({ i: 3, t: 3, dir: 'in', ch: 'rpc', frame: { method: 'item/started', params: { threadId: 'thread', turnId: 'root', item: { type: 'enteredReviewMode', id: 'enter', review: 'current changes' } } } });
  expect(marker.some(event => event.type === 'turn.start')).toBe(false);
  const unmatched = CodexAdapter.replay('s', 'thread').feed({ i: 1, t: 1, dir: 'in', ch: 'rpc', frame: { id: request, result } });
  expect(unmatched.every(event => event.type === 'item.complete' && event.kind === 'internal')).toBe(true);
});

it('keeps a newer Review running when an old completed Review execution start arrives late', () => {
  const feed = fixture();
  feed('item/started', { turnId: 'a', item: { type: 'enteredReviewMode', id: 'enter-a', review: 'a' } });
  feed('turn/started', { turn: { id: 'a-execution', rootTurnId: 'a' } });
  feed('turn/completed', { turn: { id: 'a', rootTurnId: 'a', status: 'completed' } });
  feed('item/started', { turnId: 'b', item: { type: 'enteredReviewMode', id: 'enter-b', review: 'b' } });
  feed('turn/started', { turn: { id: 'b-execution', rootTurnId: 'b' } });
  const late = feed('turn/started', { turn: { id: 'a-execution', rootTurnId: 'a' } });
  expect(late.every(event => event.type === 'item.complete' && event.kind === 'internal')).toBe(true);
  expect(feed('item/completed', { turnId: 'b', item: { type: 'exitedReviewMode', id: 'b-result', review: 'B native result' } })[0]).toMatchObject({ nativeTurnId: 'b' });
});

it('does not reopen a terminal native root when its Review mode marker and execution start arrive late', () => {
  const feed = fixture();
  feed('item/started', { turnId: 'old-root', item: { type: 'enteredReviewMode', id: 'old-enter', review: 'old review' } });
  feed('turn/started', { turn: { id: 'old-execution', rootTurnId: 'old-root' } });
  feed('turn/completed', { turn: { id: 'old-root', status: 'completed' } });
  feed('turn/started', { turn: { id: 'current' } });
  const marker = feed('item/started', { turnId: 'old-root', item: { type: 'enteredReviewMode', id: 'old-enter', review: 'old review' } });
  expect(marker.some(event => event.type === 'turn.start')).toBe(false);
  const late = feed('turn/started', { turn: { id: 'old-root', rootTurnId: null } });
  expect(late.every(event => event.type === 'item.complete' && event.kind === 'internal')).toBe(true);
});

it('keeps a new ordinary turn distinct when its provenance points to an already completed Review', () => {
  const feed = fixture();
  feed('item/started', { turnId: 'review', item: { type: 'enteredReviewMode', id: 'enter', review: 'current changes' } });
  feed('turn/started', { turn: { id: 'execution', rootTurnId: 'review' } });
  feed('turn/completed', { turn: { id: 'review', status: 'completed' } });
  expect(feed('turn/started', { turn: { id: 'new-native-turn', rootTurnId: 'review' } })[0]).toMatchObject({ type: 'turn.start', nativeTurnId: 'new-native-turn' });
});

it('keeps native Markdown plan streams under the Review root and retains interrupted text when execution ids are used', () => {
  const feed = fixture();
  feed('item/started', { turnId: 'review', item: { type: 'enteredReviewMode', id: 'enter', review: 'current changes' } });
  feed('turn/started', { turn: { id: 'execution', rootTurnId: 'review' } });
  expect(feed('item/started', { turnId: 'execution', item: { type: 'plan', id: 'plan', text: '' } })[0]).toMatchObject({ type: 'item.start', nativeTurnId: 'review' });
  expect(feed('item/plan/delta', { turnId: 'execution', itemId: 'plan', delta: '# Native draft\n' })[0]).toMatchObject({ type: 'item.delta', nativeTurnId: 'review', append: '# Native draft\n' });
  const completed = feed('turn/completed', { turn: { id: 'review', status: 'interrupted' } });
  expect(completed).toMatchObject([
    { type: 'item.complete', nativeTurnId: 'review', kind: 'plan', data: { text: '# Native draft\n', incomplete: true } },
    { type: 'turn.end', nativeTurnId: 'review', status: 'interrupted' },
  ]);
  expect(feed('item/plan/delta', { turnId: 'execution', itemId: 'plan', delta: 'stale' }).every(event => event.type === 'item.complete' && event.kind === 'internal')).toBe(true);
});

it('keeps Review root ownership of execution items, requests and late results while only root completion closes the operation', async () => {
  const replay = CodexAdapter.replay('s', 'thread'); let sequence = 0;
  const feed = (method: string, params: Record<string, unknown>, id?: string) => replay.feed({ i: ++sequence, t: sequence,
    dir: 'in', ch: 'rpc', frame: { method, params: { threadId: 'thread', ...params }, ...(id === undefined ? {} : { id }) } });
  feed('item/started', { turnId: 'root', item: { type: 'enteredReviewMode', id: 'enter', review: 'current changes' } });
  feed('turn/started', { turn: { id: 'execution-a', rootTurnId: 'root' } });
  feed('turn/started', { turn: { id: 'execution-b', rootTurnId: 'root' } });
  expect(feed('item/completed', { turnId: 'execution-a', item: { type: 'agentMessage', id: 'message-a', text: 'Original earlier execution text' } })[0]).toMatchObject({ nativeTurnId: 'root', data: { text: 'Original earlier execution text' } });
  const pending = feed('item/commandExecution/requestApproval', { turnId: 'execution-b', itemId: 'command', kind: 'command', environmentId: null, startedAtMs: 1, command: 'cat fixture' }, 'native/request:review');
  const approval = pending.find(event => event.type === 'item.complete' && event.kind === 'approval.request');
  expect(approval).toMatchObject({ nativeTurnId: 'root' });
  if (approval?.type !== 'item.complete') throw new Error('Missing approval');
  await replay.adapter.respond('s', { approvalId: (approval.data as { approvalId: string }).approvalId, optionId: 'decline' });
  expect(replay.replies).toEqual([{ id: 'native/request:review', result: { decision: 'decline' } }]);
  expect(feed('serverRequest/resolved', { requestId: 'native/request:review' })[0]).toMatchObject({ nativeTurnId: 'root', kind: 'approval.resolved' });
  expect(feed('turn/completed', { turn: { id: 'execution-a', rootTurnId: 'root', status: 'completed' } }).every(event => event.type === 'item.complete' && event.kind === 'internal')).toBe(true);
  expect(feed('turn/completed', { turn: { id: 'root', status: 'completed' } })[0]).toMatchObject({ type: 'turn.end', nativeTurnId: 'root' });
});
