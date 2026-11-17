/** Question identity and settlement come from the native call, not HTTP ACKs. */
import type { DshQuestionAnswer } from '@webdcc/protocol';
export type { DshQuestionAnswer } from '@webdcc/protocol';
export type DshQuestionResult = { kind: 'answered'; answers: DshQuestionAnswer[] }
  | { kind: 'continued' | 'cancelled' | 'unknown' };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Legacy ask_user_question translates multi_select to the UI's multiSelect.
 * Only an unambiguous live logged call can supply an omitted wait.callId. */
export function dshQuestionSignature(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const seen = new Set<string>(); const questions = [];
  for (const raw of value) {
    const question = object(raw);
    if (typeof question['id'] !== 'string' || seen.has(question['id']) || typeof question['question'] !== 'string') return undefined;
    seen.add(question['id']);
    questions.push({ id: question['id'], question: question['question'], header: question['header'] ?? null,
      options: question['options'] ?? null, multiSelect: question['multiSelect'] ?? question['multi_select'] ?? false,
      detail: question['detail'] ?? null, intent: question['intent'] ?? null });
  }
  return JSON.stringify(questions);
}

/** Recovery additionally binds the original sensitive-field flags. */
export function dshQuestionRecoverySignature(value: unknown): string | undefined {
  const signature = dshQuestionSignature(value);
  if (signature === undefined || !Array.isArray(value)) return undefined;
  const questions = JSON.parse(signature) as Record<string, unknown>[];
  return JSON.stringify(questions.map((question, index) => ({ ...question, isSecret: object(value[index])['isSecret'] === true })));
}

export function dshQuestionAnswers(value: unknown): DshQuestionAnswer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>(); const answers: DshQuestionAnswer[] = [];
  for (const raw of value) {
    const answer = object(raw);
    if (typeof answer['id'] !== 'string' || seen.has(answer['id']) || !Array.isArray(answer['selected'])
      || answer['selected'].some(item => typeof item !== 'string') || answer['custom'] !== undefined && typeof answer['custom'] !== 'string') return undefined;
    seen.add(answer['id']);
    answers.push({ id: answer['id'], selected: [...answer['selected']] as string[], ...(answer['custom'] === undefined ? {} : { custom: answer['custom'] as string }) });
  }
  return answers;
}

export function dshQuestionResult(data: Record<string, unknown>): DshQuestionResult {
  const message = object(data['message']); const error = object(data['error']);
  if (error['code'] === 'TOOL_OUTCOME_UNKNOWN') return { kind: 'continued' };
  if (message['isError'] === true || data['error'] !== undefined)
    return { kind: ['ASK_CANCELLED', 'ASK_ABORTED'].includes(String(error['code'])) ? 'cancelled' : 'unknown' };
  const content = message['content'];
  const text = Array.isArray(content) ? content.map(raw => { const part = object(raw); return part['type'] === 'text' && typeof part['text'] === 'string' ? part['text'] : ''; }).join('') : '';
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(text)); } catch { return { kind: 'unknown' }; }
  if (value['pending'] === true) return { kind: value['callId'] === message['toolCallId'] ? 'continued' : 'unknown' };
  const answers = dshQuestionAnswers(value['answers']);
  return answers === undefined ? { kind: 'unknown' } : { kind: 'answered', answers };
}

export function sameDshQuestionAnswers(answers: readonly DshQuestionAnswer[], expected: Map<string, DshQuestionAnswer> | undefined): boolean {
  return expected !== undefined && answers.length === expected.size && answers.every(answer => {
    const local = expected.get(answer.id);
    return local !== undefined && JSON.stringify(answer.selected) === JSON.stringify(local.selected) && (answer.custom ?? '') === (local.custom ?? '');
  });
}
