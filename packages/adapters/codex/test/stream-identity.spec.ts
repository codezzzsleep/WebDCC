import { expect, it } from 'vitest';
import type { AdapterEvent, TraceFrame } from '@webdcc/protocol';
import { CodexAdapter } from '../src/adapter.js';
import type { ThreadTokenUsageUpdatedNotification } from '../src/schema/v2/ThreadTokenUsageUpdatedNotification.js';

function fixture() {
  const replay = CodexAdapter.replay('session', 'thread'); let index = 0;
  return (method: string, params: Record<string, unknown>, time: number) => replay.feed({
    i: ++index, t: time, dir: 'in', ch: 'rpc', frame: { method, params: { threadId: 'thread', ...params } },
  } satisfies TraceFrame);
}
function sample(turnId: string, inputTokens: number): ThreadTokenUsageUpdatedNotification {
  const last = { totalTokens: inputTokens + 10, inputTokens, outputTokens: 10, cachedInputTokens: 3,
    cacheWriteInputTokens: 4, reasoningOutputTokens: 6 };
  return { threadId: 'thread', turnId, tokenUsage: { total: last, last, modelContextWindow: 10000 } };
}
function usage(events: AdapterEvent[]) {
  return events.find(event => event.type === 'item.complete' && event.kind === 'usage');
}

it('native reasoning updates retain their turn identity after another turn starts and the older turn completes', () => {
  const feed = fixture();
  feed('turn/started', { turn: { id: 'a' } }, 10);
  feed('item/reasoning/summaryTextDelta', { turnId: 'a', itemId: 'shared', summaryIndex: 0, delta: 'A' }, 20);
  feed('turn/started', { turn: { id: 'b' } }, 30);
  feed('item/reasoning/summaryTextDelta', { turnId: 'b', itemId: 'shared', summaryIndex: 0, delta: 'B' }, 40);
  feed('turn/completed', { turn: { id: 'a', status: 'completed' } }, 50);
  expect(feed('item/reasoning/summaryPartAdded', { turnId: 'b', itemId: 'shared', summaryIndex: 1 }, 60)[0]).toMatchObject({
    type: 'item.update', itemKey: 'shared', nativeTurnId: 'b', data: { text: 'B\n' },
  });
  expect(feed('item/reasoning/summaryTextDelta', { turnId: 'b', itemId: 'shared', summaryIndex: 1, delta: 'second' }, 70)).toEqual([
    { type: 'item.update', itemKey: 'shared', nativeTurnId: 'b', data: { text: 'B\nsecond' } },
  ]);
});

it('late native usage keeps its old turn identity and cannot consume the newer turn generation timer', () => {
  const feed = fixture();
  feed('turn/started', { turn: { id: 'a' } }, 10);
  feed('item/reasoning/summaryTextDelta', { turnId: 'a', itemId: 'a-reasoning', summaryIndex: 0, delta: 'A' }, 20);
  feed('turn/started', { turn: { id: 'b' } }, 100);
  feed('item/reasoning/summaryTextDelta', { turnId: 'b', itemId: 'b-reasoning', summaryIndex: 0, delta: 'B' }, 110);
  const old = usage(feed('thread/tokenUsage/updated', sample('a', 50), 120));
  expect(old).toMatchObject({ type: 'item.complete', nativeTurnId: 'a', kind: 'usage', data: { inputTokens: 50, outputTokens: 10 } });
  const current = usage(feed('thread/tokenUsage/updated', sample('b', 70), 130));
  expect(current).toMatchObject({ type: 'item.complete', nativeTurnId: 'b', kind: 'usage', data: { inputTokens: 70, generationMs: 20 } });
});

it('native cache-write token usage is retained with the other native usage counters', () => {
  const feed = fixture();
  feed('turn/started', { turn: { id: 'a' } }, 10);
  expect(usage(feed('thread/tokenUsage/updated', sample('a', 50), 20))).toMatchObject({
    nativeTurnId: 'a', data: { inputTokens: 50, outputTokens: 10, cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4, reasoningOutputTokens: 6 },
  });
});

it('an explicit native item start is not followed by an implicit start that discards seeded text and phase', () => {
  const feed = fixture();
  feed('turn/started', { turn: { id: 'a' } }, 10);
  feed('item/started', { turnId: 'a', item: { type: 'agentMessage', id: 'shared', text: 'Seed ', phase: 'commentary' } }, 20);
  expect(feed('item/agentMessage/delta', { turnId: 'a', itemId: 'shared', delta: 'tail' }, 30)).toEqual([
    { type: 'item.delta', nativeTurnId: 'a', itemKey: 'shared', field: 'text', append: 'tail' },
  ]);
});

it.each(['approval', 'question'] as const)('late old-turn %s request and its native confirmation retain the request turn after a new turn starts', async kind => {
  const replay = CodexAdapter.replay('session', 'thread'); let index = 0;
  const feed = (method: string, params: Record<string, unknown>, id?: string) => replay.feed({
    i: ++index, t: index, dir: 'in', ch: 'rpc', frame: { method, params, ...(id === undefined ? {} : { id }) },
  } satisfies TraceFrame);
  feed('turn/started', { threadId: 'thread', turn: { id: 'a' } });
  feed('turn/started', { threadId: 'thread', turn: { id: 'b' } });
  const id = `request-${kind}`;
  const params = kind === 'question' ? {
    threadId: 'thread', turnId: 'a', itemId: 'control-item', isBlocking: true, autoResolutionMs: null,
    questions: [{ id: 'choice', header: 'Choice', question: 'Choose a value', isOther: true, isSecret: false, options: null }],
  } : { kind: 'command', threadId: 'thread', turnId: 'a', itemId: 'control-item', environmentId: null, startedAtMs: 1, command: 'cat fixture' };
  const method = kind === 'question' ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval';
  const request = feed(method, params, id).find(event => event.type === 'item.complete' && event.kind === (kind === 'question' ? 'question' : 'approval.request'));
  expect(request).toMatchObject({ type: 'item.complete', nativeTurnId: 'a' });
  if (request?.type !== 'item.complete') throw new Error('Missing native request');
  const data = request.data as { questionId: string; approvalId: string };
  if (kind === 'question') await replay.adapter.answer('session', data.questionId, { custom: 'original turn answer' });
  else await replay.adapter.respond('session', { approvalId: data.approvalId, optionId: 'accept' });
  expect(replay.replies).toHaveLength(1);
  expect(replay.replies[0]).toMatchObject({ id });
  const resolved = feed('serverRequest/resolved', { threadId: 'thread', requestId: id });
  expect(resolved[0]).toMatchObject({ type: 'item.complete', nativeTurnId: 'a', kind: kind === 'question' ? 'question' : 'approval.resolved' });
  expect(feed('serverRequest/resolved', { threadId: 'thread', requestId: id }).some(event => event.type === 'item.complete' && event.kind === (kind === 'question' ? 'question' : 'approval.resolved'))).toBe(false);
});

it.each(['approval', 'question'] as const)('does not expose an actionable %s request for another native thread', kind => {
  const replay = CodexAdapter.replay('session', 'thread');
  const params = kind === 'question' ? {
    threadId: 'foreign-thread', turnId: 'foreign-turn', itemId: 'control-item', isBlocking: true, autoResolutionMs: null,
    questions: [{ id: 'choice', header: 'Choice', question: 'Choose a value', isOther: true, isSecret: false, options: null }],
  } : { kind: 'command', threadId: 'foreign-thread', turnId: 'foreign-turn', itemId: 'control-item', environmentId: null, startedAtMs: 1, command: 'cat fixture' };
  const events = replay.feed({ i: 1, t: 1, dir: 'in', ch: 'rpc', frame: { id: 'foreign-request',
    method: kind === 'question' ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval', params } } satisfies TraceFrame);
  expect(events.some(event => event.type === 'item.complete' && ['question', 'approval.request'].includes(event.kind))).toBe(false);
  expect(replay.replies).toEqual([{ id: 'foreign-request', error: expect.objectContaining({ code: -32602 }) }]);
});
