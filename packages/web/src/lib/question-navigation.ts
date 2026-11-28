import type { EventData, StoredEvent } from '@webdcc/protocol';
import { questionDraftKey, questionHasUnsavedChanges } from './question-drafts.js';

export function latestQuestions(events: StoredEvent[]): StoredEvent[] {
  const questions = new Map<string, StoredEvent>();
  for (const event of events) if (event.kind === 'question') questions.set((event.data as EventData['question']).questionId, event);
  return [...questions.values()];
}
export function awaitsQuestionAnswer(event: StoredEvent): boolean {
  const question = event.data as EventData['question'];
  return question.status !== 'answered' && question.status !== 'skipped' && !['collected', 'sent', 'queued'].includes(question.submission ?? '');
}
export function needsQuestionAnswer(event: StoredEvent): boolean {
  const question = event.data as EventData['question'];
  return awaitsQuestionAnswer(event) || question.status !== 'answered' && question.status !== 'skipped'
    && question.submission === 'collected' && questionHasUnsavedChanges(questionDraftKey(event, question));
}
export function focusQuestion(scope: HTMLElement | null, questionId: string): boolean {
  const card = [...scope?.querySelectorAll<HTMLElement>('[data-question-id]') ?? []].find(el => el.dataset.questionId === questionId);
  if (!card) return false;
  card.scrollIntoView({ block: 'start' });
  card.focus({ preventScroll: true });
  return true;
}
