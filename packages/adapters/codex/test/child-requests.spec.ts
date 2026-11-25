import { expect, it } from 'vitest';
import type { CodexSubagentView, EventData, TraceFrame } from '@webdcc/protocol';
import { CodexAdapter } from '../src/adapter.js';

/** Controlled native protocol frames; no native process or model invocation. */
function fixture() {
  const child: CodexSubagentView = { agent: 'codex', childId: 'child', parentThreadId: 'parent', agentPath: 'reviewer',
    nativeStatus: 'running', nativeTurnId: 'child-turn', turns: { 'child-turn': { status: 'inProgress' } }, results: [] };
  const replay = CodexAdapter.replay('session', 'parent', [child]); let index = 0;
  const feed = (method: string, params: Record<string, unknown>, id?: string | number) => replay.feed({ i: ++index, t: index, dir: 'in', ch: 'rpc',
    frame: { method, params, ...(id === undefined ? {} : { id }) } } satisfies TraceFrame);
  const question = (threadId: string) => ({ threadId, turnId: `${threadId}-turn`, itemId: 'question-item', isBlocking: true, autoResolutionMs: null,
    questions: [{ id: 'q', header: 'Choice', question: 'Choose one', isSecret: false, isOther: true, options: null }] });
  return { replay, feed, question };
}

it('answers a known child through its original request and acknowledges only that child, without creating a parent turn', async () => {
  const { replay, feed, question } = fixture();
  const events = feed('item/tool/requestUserInput', question('child'), 'native-child-request');
  expect(events.some(event => event.type === 'turn.start' || event.type === 'turn.end')).toBe(false);
  const item = events.find(event => event.type === 'item.complete' && event.kind === 'question');
  expect(item).toMatchObject({ scope: 'session', nativeTurnId: 'child-turn', data: { prompt: 'Choose one', header: '子 Agent reviewer · Choice' },
    native: { id: 'native-child-request', params: question('child') } });
  if (item?.type !== 'item.complete') throw new Error('Missing child question');
  const id = (item.data as EventData['question']).questionId;
  await replay.adapter.answer('session', id, { custom: '  原答🐈\n ' });
  expect(replay.replies).toEqual([{ id: 'native-child-request', result: { answers: { q: { answers: ['  原答🐈\n '] } } } }]);
  expect(feed('serverRequest/resolved', { threadId: 'parent', requestId: 'native-child-request' }).some(event => event.type === 'item.complete' && event.kind === 'question')).toBe(false);
  expect(feed('serverRequest/resolved', { threadId: 'child', requestId: 'native-child-request' })).toContainEqual(expect.objectContaining({
    scope: 'session', nativeTurnId: 'child-turn', kind: 'question', data: expect.objectContaining({ questionId: id, status: 'answered', resolution: 'native-acknowledged' }),
  }));
  expect(feed('serverRequest/resolved', { threadId: 'child', requestId: 'native-child-request' }).some(event => event.type === 'item.complete' && event.kind === 'question')).toBe(false);
  await expect(replay.adapter.answer('session', id, { custom: 'duplicate' })).rejects.toMatchObject({ statusCode: 409 });
});

it('root cancellation does not reply on behalf of independently waiting child requests', async () => {
  const { replay, feed, question } = fixture();
  feed('item/tool/requestUserInput', question('parent'), 'parent-request');
  const items = feed('item/tool/requestUserInput', question('child'), 'child-request');
  const child = items.find(event => event.type === 'item.complete' && event.kind === 'question');
  if (child?.type !== 'item.complete') throw new Error('Missing child question');
  await replay.adapter.cancelPending('session');
  expect(replay.replies).toEqual([{ id: 'parent-request', result: { answers: {} } }]);
  await replay.adapter.answer('session', (child.data as EventData['question']).questionId, { custom: 'child continues' });
  expect(replay.replies.at(-1)).toEqual({ id: 'child-request', result: { answers: { q: { answers: ['child continues'] } } } });
});

it('child approval keeps the original native permission response and thread-bound confirmation', async () => {
  const { replay, feed } = fixture();
  const permissions = { network: { enabled: true }, fileSystem: { read: ['/tmp'], write: null } };
  const events = feed('item/permissions/requestApproval', { threadId: 'child', turnId: 'child-turn', itemId: 'item', cwd: '/tmp',
    environmentId: null, startedAtMs: 1, reason: 'original reason', permissions }, 41);
  const approval = events.find(event => event.type === 'item.complete' && event.kind === 'approval.request');
  expect(approval).toMatchObject({ scope: 'session', nativeTurnId: 'child-turn' });
  if (approval?.type !== 'item.complete') throw new Error('Missing child approval');
  const approvalId = (approval.data as EventData['approval.request']).approvalId;
  await replay.adapter.respond('session', { approvalId, optionId: 'grant-turn' });
  expect(replay.replies).toEqual([{ id: 41, result: { scope: 'turn', permissions } }]);
  expect(feed('serverRequest/resolved', { threadId: 'child', requestId: 41 })).toContainEqual(expect.objectContaining({
    scope: 'session', nativeTurnId: 'child-turn', kind: 'approval.resolved', data: expect.objectContaining({ approvalId, optionId: 'grant-turn' }),
  }));
});

it('child MCP form keeps its native result and unknown thread requests remain rejected', async () => {
  const { replay, feed, question } = fixture();
  const params = { threadId: 'child', turnId: 'child-turn', serverName: 'native-server', mode: 'openai/form', _meta: null,
    message: 'Original form', requestedSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } };
  const events = feed('mcpServer/elicitation/request', params, 'child-form');
  const form = events.find(event => event.type === 'item.complete' && event.kind === 'question');
  if (form?.type !== 'item.complete') throw new Error('Missing child form');
  expect(form).toMatchObject({ scope: 'session', nativeTurnId: 'child-turn', native: { params } });
  await replay.adapter.answer('session', (form.data as EventData['question']).questionId, { action: 'accept', content: { value: ' exact ' } });
  expect(replay.replies).toEqual([{ id: 'child-form', result: { action: 'accept', content: { value: ' exact ' }, _meta: null } }]);
  feed('item/tool/requestUserInput', question('foreign'), 'foreign-request');
  expect(replay.replies.at(-1)).toMatchObject({ id: 'foreign-request', error: { code: -32602 } });
});
