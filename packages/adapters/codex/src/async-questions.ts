import { codexAsyncQuestionId, parseCodexAsyncReplies, type QuestionItem, type AdapterEvent } from '@webdcc/protocol';

/** The native handler emits complete questions on an async agent-message item. */
export function codexAsyncQuestions(item: Record<string, unknown>, nativeId: string): QuestionItem[] {
  if (item['type'] !== 'agentMessage' || item['delivery'] !== 'async' || typeof item['id'] !== 'string' || !Array.isArray(item['questions'])) return [];
  const questions = item['questions'] as { title?: unknown; options?: unknown }[];
  if (!questions.every(question => question !== null && typeof question === 'object' && typeof question.title === 'string' && question.title.trim()
    && (question.options == null || Array.isArray(question.options) && question.options.length > 0 && question.options.every(option => typeof option === 'string' && option.trim())))) return [];
  const itemId = item['id'];
  return questions.map((question, index) => ({ questionId: codexAsyncQuestionId(itemId, index), prompt: question.title as string,
    isBlocking: false, allowsFreeText: true, multiSelect: false, asyncReply: { nativeId, itemId, index }, toolCallId: itemId,
    ...(question.options == null ? {} : { options: (question.options as string[]).map(option => ({ id: option, label: option })) }) }));
}

export function nativeAsyncReplies(item: Record<string, unknown>) {
  if (item['type'] !== 'userMessage' || !Array.isArray(item['content'])) return { text: '', replies: [] };
  const text = item['content'].filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text as string).join('\n');
  return { text, replies: parseCodexAsyncReplies(text) };
}

export function codexAsyncQuestionEvents(item: Record<string, unknown>, nativeId: string): Extract<AdapterEvent, { type: 'item.complete' }>[] {
  return codexAsyncQuestions(item, nativeId).map(question => ({ type: 'item.complete', itemKey: `question-${question.questionId}`, kind: 'question', data: question, native: item, scope: 'session' }));
}
