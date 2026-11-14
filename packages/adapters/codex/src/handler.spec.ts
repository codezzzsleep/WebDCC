import { expect, it } from 'vitest';
import { CodexAdapter } from './adapter.js';
import type { EventData } from '@webdcc/protocol';
it.each([false, true, undefined])('preserves request_user_input isBlocking=%s and never derives it from autoResolutionMs', async isBlocking => {
  const replay = CodexAdapter.replay('s', 'thread');
  const events = replay.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'blocking', method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'tool', isBlocking, autoResolutionMs: 1, questions: [{ id: 'q', question: 'preserved' }] } } });
  const question = (events.find(event => event.type === 'item.complete' && event.kind === 'question') as { data: EventData['question'] }).data;
  expect(question.isBlocking).toBe(isBlocking); expect(question.status).toBeUndefined();
  replay.feed({ i: 2, t: 60_000, dir: 'in', ch: 'rpc', frame: { method: 'warning', params: { message: 'later' } } });
  await replay.adapter.answer('s', question.questionId, { custom: 'answer' });
  const resolved = replay.feed({ i: 3, t: 60_001, dir: 'in', ch: 'rpc', frame: { method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 'blocking' } } });
  const confirmed = resolved.find(event => event.type === 'item.complete' && event.kind === 'question') as { nativeTurnId?: string; data: EventData['question'] };
  expect(confirmed).toMatchObject({ nativeTurnId: 'turn', data: { status: 'answered' } }); expect(confirmed.data.isBlocking).toBe(isBlocking);
});
it('maps owned native thread active flags without turning observer notLoaded or foreign state into execution facts', () => {
  const replay = CodexAdapter.replay('s', 'thread');
  const feed = (threadId: string, status: unknown) => replay.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'thread/status/changed', params: { threadId, status } } });
  expect(feed('thread', { type: 'active', activeFlags: ['waitingOnUserInput'] })).toContainEqual(expect.objectContaining({ type: 'status', status: 'waiting', source: 'native-thread', scope: 'session' }));
  expect(feed('thread', { type: 'active', activeFlags: [] })).toContainEqual(expect.objectContaining({ type: 'status', status: 'running' }));
  expect(feed('thread', { type: 'idle' })).toContainEqual(expect.objectContaining({ type: 'status', status: 'idle' }));
  expect(feed('thread', { type: 'notLoaded' }).some(event => event.type === 'status')).toBe(false);
  expect(feed('foreign', { type: 'active', activeFlags: ['waitingOnApproval'] }).some(event => event.type === 'status')).toBe(false);
});
it('native multiquestion control replies use native IDs and wait for all answers', async () => {
  const replay = CodexAdapter.replay('s');
  const events = replay.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 12, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'language', question: '语言' }, { id: 'version', question: '版本' }] } } });
  expect(events.filter(event => event.type === 'item.complete' && event.kind === 'question')).toHaveLength(2);
  await replay.adapter.answer('s', 'language', { value: '中文' }); expect(replay.replies).toHaveLength(0);
  await replay.adapter.answer('s', 'version', { value: '新版' });
  expect(replay.replies).toEqual([{ id: 12, result: { answers: { language: { answers: ['中文'] }, version: { answers: ['新版'] } } } }]);
});

it('NP-06 isolates repeated native question IDs and never offers approval for unknown requests', async () => {
  const replay = CodexAdapter.replay('s');
  const ask = (id: string) => replay.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'same', question: 'text' }] } } });
  const first = ask('first').find(event => event.type === 'item.complete' && event.kind === 'question');
  const second = ask('second').find(event => event.type === 'item.complete' && event.kind === 'question');
  const a = (first as { data: { questionId: string } }).data.questionId;
  const b = (second as { data: { questionId: string } }).data.questionId;
  expect(a).not.toBe(b);
  await expect(replay.adapter.answer('s', 'same', { custom: 'ambiguous' })).rejects.toThrow();
  await replay.adapter.answer('s', b, { selected: [], custom: 'second only' });
  expect(replay.replies).toEqual([{ id: 'second', result: { answers: { same: { answers: ['second only'] } } } }]);
  const unknown = replay.feed({ i: 3, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'unknown', method: 'unknown/control', params: {} } });
  expect(unknown.some(event => event.type === 'item.complete' && event.kind === 'approval.request')).toBe(false);
  expect(replay.replies.at(-1)).toMatchObject({ id: 'unknown', error: { code: -32601 } });
});

it('NP-02 string and number request IDs with the same printed value remain distinct', async () => {
  const replay = CodexAdapter.replay('s');
  const questions: string[] = [];
  for (const id of [12, '12']) {
    const events = replay.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'x', question: 'answer' }] } } });
    questions.push((events.find(event => event.type === 'item.complete' && event.kind === 'question') as { data: { questionId: string } }).data.questionId);
  }
  expect(questions[0]).not.toBe(questions[1]);
  await replay.adapter.answer('s', questions[0] ?? '', { custom: 'numeric' });
  await replay.adapter.answer('s', questions[1] ?? '', { custom: 'string' });
  expect(replay.replies).toMatchObject([{ id: 12 }, { id: '12' }]);
});

it('NP-06 native confirmation uses the exact thread and typed request ID and is idempotent', async () => {
  const replay = CodexAdapter.replay('s', 'thread');
  const ids: string[] = [];
  for (const id of [0, '0']) {
    const events = replay.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q', question: 'preserved prompt' }] } } });
    ids.push((events.find(event => event.type === 'item.complete' && event.kind === 'question') as { data: EventData['question'] }).data.questionId);
  }
  expect(await replay.adapter.answer('s', ids[0]!, 'answer')).toMatchObject({ confirmed: false });
  await expect(replay.adapter.answer('s', ids[0]!, 'duplicate')).rejects.toMatchObject({ statusCode: 409 });
  const resolve = (threadId: string, requestId: string | number) => replay.feed({ i: 2, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'serverRequest/resolved', params: { threadId, requestId } } });
  expect(resolve('wrong-thread', 0).some(event => event.type === 'item.complete' && event.kind === 'question')).toBe(false);
  expect(resolve('thread', 0)).toContainEqual(expect.objectContaining({ kind: 'question', data: expect.objectContaining({ questionId: ids[0], prompt: 'preserved prompt', status: 'answered', resolution: 'native-acknowledged' }) }));
  expect(resolve('thread', 0).some(event => event.type === 'item.complete' && event.kind === 'question')).toBe(false);
  expect(resolve('thread', '0')).toContainEqual(expect.objectContaining({ kind: 'question', data: expect.objectContaining({ questionId: ids[1], status: 'skipped', resolution: 'external' }) }));
  expect(replay.replies).toHaveLength(1);
});

it('NP-06 approvals wait for native resolution and submitted responses are not sent again during cancellation', async () => {
  const replay = CodexAdapter.replay('s', 'thread');
  const events = replay.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'approval', method: 'item/commandExecution/requestApproval', params: { command: 'ls' } } });
  const approvalId = (events.find(event => event.type === 'item.complete' && event.kind === 'approval.request') as { data: EventData['approval.request'] }).data.approvalId;
  expect(await replay.adapter.respond('s', { approvalId, optionId: 'decline' })).toEqual({ confirmed: false });
  const resolved = replay.feed({ i: 2, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 'approval' } } });
  expect(resolved).toContainEqual(expect.objectContaining({ kind: 'approval.resolved', data: { approvalId, optionId: 'decline', by: 'user' } }));
  await replay.adapter.cancelPending('s');
  expect(replay.replies).toHaveLength(1);
});
