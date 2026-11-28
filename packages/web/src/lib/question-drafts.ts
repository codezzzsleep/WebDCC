import type { StoredEvent, QuestionItem } from '@webdcc/protocol';

export interface QuestionDraft { selected: string[]; custom: string }
const memory = new Map<string, QuestionDraft>();
const accepted = new Map<string, QuestionDraft>();
const secretEdits = new Set<string>();
const secretReceipts = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
const changed = (): void => { version++; for (const listener of listeners) listener(); };
export const subscribeQuestionDrafts = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const questionDraftVersion = (): number => version;
const sameAnswer = (left: QuestionDraft, right: QuestionDraft): boolean => left.custom === right.custom
  && left.selected.length === right.selected.length && left.selected.every(id => right.selected.includes(id));

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
export function saveQuestionDraft(key: string, draft: QuestionDraft, persist = true): void {
  memory.set(key, { selected: [...draft.selected], custom: draft.custom });
  if (persist) try { localStorage.setItem(key, JSON.stringify(draft)); } catch { /* In-memory navigation recovery remains available. */ }
  changed();
}
/** Comparison only: an accepted answer is supplied by the authenticated receipt. */
export function acceptQuestionAnswer(key: string, answer: QuestionDraft): void {
  const previous = accepted.get(key);
  if (previous !== undefined && sameAnswer(previous, answer)) return;
  accepted.set(key, { selected: [...answer.selected], custom: answer.custom }); changed();
}
export function questionHasUnsavedChanges(key: string): boolean {
  if (secretEdits.has(key)) return true;
  const saved = accepted.get(key);
  if (saved === undefined) return false;
  readQuestionDraft(key);
  const draft = memory.get(key);
  return draft !== undefined && !sameAnswer(draft, saved);
}
/** Sensitive values never enter the draft/receipt caches, only a dirty flag. */
export function markSecretQuestionEdited(key: string): void { if (!secretEdits.has(key)) { secretEdits.add(key); changed(); } }
export function acceptSecretQuestionAnswer(key: string, commandId: string): void {
  if (commandId === '' || secretReceipts.get(key) === commandId) return;
  secretReceipts.set(key, commandId); secretEdits.delete(key); changed();
}
export function clearQuestionDraft(key: string): void {
  const hadState = memory.has(key) || accepted.has(key) || secretEdits.has(key) || secretReceipts.has(key);
  memory.delete(key); accepted.delete(key); secretEdits.delete(key); secretReceipts.delete(key);
  try { localStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
  if (hadState) changed();
}
