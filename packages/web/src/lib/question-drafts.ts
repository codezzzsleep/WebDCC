import type { StoredEvent, QuestionItem } from '@webdcc/protocol';

export interface QuestionDraft { selected: string[]; custom: string }
const memory = new Map<string, QuestionDraft>();

/** Session/turn/native question and its form bind a draft to exactly one reply. */
export function questionDraftKey(event: StoredEvent, question: QuestionItem): string {
  return `wdcc.question-draft.v1:${JSON.stringify([event.sessionId, event.turnId, question.groupId, question.questionId,
    question.prompt, question.options?.map(option => [option.id, option.label]), question.asyncReply])}`;
}
export function readQuestionDraft(key: string): QuestionDraft {
  const current = memory.get(key);
  if (current !== undefined) return { selected: [...current.selected], custom: current.custom };
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as QuestionDraft | null;
    if (value !== null && Array.isArray(value.selected) && value.selected.every(id => typeof id === 'string') && typeof value.custom === 'string') {
      memory.set(key, value); return { selected: [...value.selected], custom: value.custom };
    }
  } catch { /* Keep the current page usable when storage is unavailable. */ }
  return { selected: [], custom: '' };
}
export function saveQuestionDraft(key: string, draft: QuestionDraft): void {
  memory.set(key, { selected: [...draft.selected], custom: draft.custom });
  try { localStorage.setItem(key, JSON.stringify(draft)); } catch { /* In-memory navigation recovery remains available. */ }
}
export function clearQuestionDraft(key: string): void {
  memory.delete(key);
  try { localStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
}
