import { expect, it } from 'vitest';
import { nativeReasoningContent, validNativeReasoningParts } from '../src/codex-reasoning.js';
import { isValidEventData } from '../src/validate.js';

it('reads original old native content rows and preserves all indices, Unicode and whitespace separately', () => {
  const content = ['\t原生 😀\n', '', 'third\n'];
  expect(nativeReasoningContent({ kind: 'reasoning', data: { text: 'summary' }, native: { type: 'reasoning', content } })).toEqual(content.map((text, index) => ({ index, text })));
  expect(nativeReasoningContent({ kind: 'internal', native: { type: 'reasoning', content } })).toEqual([]);
});

it('uses explicit projected native parts including a sparse index or an intentionally empty list', () => {
  const parts = [{ index: 7, text: 'native part seven' }];
  expect(nativeReasoningContent({ kind: 'reasoning', data: { text: 'summary', nativeContent: parts } })).toEqual(parts);
  expect(nativeReasoningContent({ kind: 'reasoning', data: { text: '', nativeContent: [] }, native: { type: 'reasoning', content: ['old'] } })).toEqual([]);
});

it.each([[{ index: -1, text: 'bad' }], [{ index: 1.2, text: 'bad' }], [{ index: 0, text: false }], [{ index: 1, text: 'a' }, { index: 1, text: 'b' }]])('rejects malformed native content parts without accepting ambiguous identity', parts => {
  expect(validNativeReasoningParts(parts)).toBe(false);
  expect(isValidEventData('reasoning', { text: 'summary', nativeContent: parts })).toBe(false);
  expect(isValidEventData('reasoning', { text: 'old Agent reasoning' })).toBe(true);
});
