export interface QuestionAnswer { selected: string[]; custom?: string }

/** Canonical browser shape plus explicit compatibility with older clients. */
export function normalizeQuestionAnswer(answer: unknown): QuestionAnswer & { values: string[] } {
  const invalid = (): never => { throw Object.assign(new Error('问题答案格式无效'), { statusCode: 400 }); };
  if (typeof answer === 'string') return { selected: [], custom: answer, values: [answer] };
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return invalid();
  const value = answer as { selected?: unknown; custom?: unknown; value?: unknown; text?: unknown };
  if (value.selected !== undefined && !Array.isArray(value.selected) || value.custom !== undefined && typeof value.custom !== 'string' || value.text !== undefined && typeof value.text !== 'string' || value.value !== undefined && typeof value.value !== 'string' && !Array.isArray(value.value)) return invalid();
  const selected = value.selected ?? (Array.isArray(value.value) ? value.value : []);
  const custom = value.custom ?? value.text ?? (typeof value.value === 'string' ? value.value : undefined);
  if (!Array.isArray(selected) || selected.some(item => typeof item !== 'string') || custom !== undefined && typeof custom !== 'string') return invalid();
  const choices = selected as string[];
  return { selected: choices, ...(custom === undefined ? {} : { custom: custom as string }), values: [...choices, ...(custom === undefined || custom === '' ? [] : [custom as string])] };
}
