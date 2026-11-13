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
