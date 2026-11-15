import { expect, it } from 'vitest';
import { codexAsyncQuestionId, displayCodexAsyncReply, formatCodexAsyncReply, parseCodexAsyncReplies } from '../src/codex-questions.js';
import type { QuestionItem } from '../src/events.js';

const question: QuestionItem = { questionId: codexAsyncQuestionId('native-item', 0), prompt: '问题\r\n下一行', isBlocking: false, asyncReply: { nativeId: 'thread', itemId: 'native-item', index: 0 } };
it('matches native structured replies, IDE prefixes and preserves answer bytes', () => {
  const answer = ' 字节\r\n</send_user_message_question_reply> ';
  const text = formatCodexAsyncReply(question, { custom: answer });
  expect(parseCodexAsyncReplies(text)).toEqual([{ questionItemId: question.questionId, question: '问题  下一行', answer }]);
  expect(parseCodexAsyncReplies(`# Context from my IDE setup:\nfile\n## My request for Codex:\n${text}`)).toEqual(parseCodexAsyncReplies(text));
  expect(displayCodexAsyncReply(text)).toBe(`> 问题  下一行\n\n${answer}`);
  expect(parseCodexAsyncReplies(`context\n${text}`)).toEqual([]);
  expect(parseCodexAsyncReplies(`${text}\nother message`)).toEqual([]);
  expect(parseCodexAsyncReplies('<send_user_message_question_reply>[null]</send_user_message_question_reply>')).toEqual([]);
});
it('bounds model-authored framing by UTF-8 bytes with native fallback for oversized identities', () => {
  const bounded = formatCodexAsyncReply({ ...question, prompt: '中'.repeat(180) }, 'answer');
  expect(new TextEncoder().encode(parseCodexAsyncReplies(bounded)[0]!.question).length).toBe(510);
  const itemId = '中'.repeat(180);
  expect(formatCodexAsyncReply({ ...question, questionId: codexAsyncQuestionId(itemId, 0), asyncReply: { nativeId: 'thread', itemId, index: 0 } }, 'answer')).toBe('> 问题  下一行\n\nanswer');
});
