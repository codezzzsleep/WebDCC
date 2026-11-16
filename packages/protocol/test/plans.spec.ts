import { expect, it } from 'vitest';
import { nativePlanText } from '../src/plans.js';
import { reduceTurn } from '../src/turn.js';
import { isValidEventData } from '../src/validate.js';
import type { EventData, StoredEvent } from '../src/events.js';

function plan(seq: number, data: EventData['plan'], itemKey: string, native?: unknown): StoredEvent {
  return { sessionId: 's', turnId: 'turn', seq, at: new Date(seq).toISOString(), kind: 'plan', itemKey, data, native };
}

it('validates native document fields without changing the existing checklist contract', () => {
  expect(isValidEventData('plan', { items: [], text: '', incomplete: true })).toBe(true);
  expect(isValidEventData('plan', { items: [{ text: 'Task', status: 'pending' }] })).toBe(true);
  expect(isValidEventData('plan', { items: [], text: 1 })).toBe(false);
  expect(isValidEventData('plan', { items: [], text: 'Draft', incomplete: 'false' })).toBe(false);
});

it('recovers original native Markdown from old rows and preserves an explicit empty document', () => {
  const original = '\t# 原生 Markdown\n\n- [ ] Keep exact text 😀\n';
  expect(nativePlanText(plan(1, { items: [] }, 'p', { type: 'plan', id: 'p', text: original }))).toBe(original);
  expect(nativePlanText(plan(2, { items: [], text: '' }, 'p', { type: 'plan', text: original }))).toBe('');
  expect(nativePlanText(plan(3, { items: [{ text: 'Native task', status: 'pending' }] }, 'tasks'))).toBeUndefined();
});

it('keeps Markdown documents separate from the existing Claude/DSH/Codex structured task steps', () => {
  const items: EventData['plan']['items'] = [{ text: 'Task with an owner', status: 'in_progress' }];
  const view = reduceTurn([plan(1, { items }, 'tasks'), plan(2, { items: [], text: '# Document', incomplete: false }, 'document')]);
  expect(view.plan).toEqual(items);
  expect(view.steps.filter(event => nativePlanText(event) !== undefined)).toHaveLength(1);
  const legacy = reduceTurn([plan(1, { items }, 'tasks'), plan(2, { items: [] }, 'document', { type: 'plan', text: '# Old native document' })]);
  expect(legacy.plan).toEqual(items);
});

it('coalesces a retained draft and a later real final plan under the same native item identity', () => {
  const view = reduceTurn([
    plan(1, { items: [], text: 'Unfinished draft', incomplete: true }, 'document'),
    plan(2, { items: [], text: 'Real final', incomplete: false }, 'document'),
  ]);
  expect(view.plan).toBeUndefined();
  expect(view.steps).toHaveLength(1);
  expect(nativePlanText(view.steps[0]!)).toBe('Real final');
  expect(view.steps[0]!.data).toMatchObject({ incomplete: false });
});
