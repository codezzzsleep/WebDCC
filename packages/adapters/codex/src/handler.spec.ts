import { expect, it } from 'vitest';
import { CodexAdapter } from './adapter.js';
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
