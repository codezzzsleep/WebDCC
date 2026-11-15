import type { QuestionItem } from './events.js';
import { normalizeQuestionAnswer } from './question-answer.js';

export interface CodexAsyncReply { questionItemId: string; question: string; answer: string }
const OPEN = '<send_user_message_question_reply>';
const CLOSE = '</send_user_message_question_reply>';

export function codexAsyncQuestionId(itemId: string, index: number): string {
  return JSON.stringify(['request_user_input_async', itemId, index]);
}

/** Match the native TUI's complete reply envelope, including its IDE prefix. */
export function parseCodexAsyncReplies(value: string): CodexAsyncReply[] {
  let text = value.trim();
  if (text.startsWith('# Context from my IDE setup:\n')) {
    if (!text.includes('\n## My request for Codex:\n')) return [];
    text = text.split('\n## My request for Codex:\n').at(-1)!.trim();
  }
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(OPEN.length, -CLOSE.length));
    const replies = Array.isArray(parsed) ? parsed : [parsed];
    if (replies.length === 0 || !replies.every(reply => reply !== null && typeof reply === 'object'
      && typeof reply.questionItemId === 'string' && typeof reply.question === 'string' && typeof reply.answer === 'string')) return [];
    return replies as CodexAsyncReply[];
  } catch { return []; }
}

/** The native AnsweredQuestion bounds the title, never the user's answer. */
export function formatCodexAsyncReply(question: QuestionItem, answer: unknown): string {
  const source = question.asyncReply;
  if (source === undefined || question.questionId !== codexAsyncQuestionId(source.itemId, source.index)) throw Object.assign(new Error('原生异步问题身份无效'), { statusCode: 400 });
  const values = normalizeQuestionAnswer(answer);
  if (values.selected.length > 1 || values.selected.some(value => !question.options?.some(option => option.id === value))) throw Object.assign(new Error('异步问题的选项无效'), { statusCode: 400 });
  const text = values.values.join('\n');
  if (!text.trim()) throw Object.assign(new Error('请输入回答'), { statusCode: 400 });
  const encoded = new TextEncoder().encode(question.prompt);
  let end = Math.min(512, encoded.length);
  while (end < encoded.length && (encoded[end]! & 0xc0) === 0x80) end--;
  const prompt = new TextDecoder().decode(encoded.subarray(0, end)).replace(/[\n\r]/g, ' ');
  if (new TextEncoder().encode(question.questionId).length > 512) return `> ${prompt}\n\n${text}`;
  return `${OPEN}\n${JSON.stringify([{ questionItemId: question.questionId, question: prompt, answer: text }])}\n${CLOSE}`;
}

export function displayCodexAsyncReply(text: string): string {
  const replies = parseCodexAsyncReplies(text);
  return replies.length === 0 ? text : replies.map(reply => `> ${reply.question}\n\n${reply.answer}`).join('\n\n');
}
