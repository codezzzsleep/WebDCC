import { expect, it } from 'vitest';
import { codexReviewItem } from '../src/codex-review.js';

it('preserves native Review target and formatted result text from existing marker rows', () => {
  const result = '\t# Native Review\n\nOriginal findings 😀\n';
  expect(codexReviewItem({ kind: 'tool.call', native: { type: 'enteredReviewMode', id: 'enter', review: 'changes against baseline' } })).toEqual({ phase: 'started', text: 'changes against baseline' });
  expect(codexReviewItem({ kind: 'tool.call', native: { type: 'exitedReviewMode', id: 'result', review: result } })).toEqual({ phase: 'finished', text: result });
  expect(codexReviewItem({ kind: 'tool.call', native: { type: 'exitedReviewMode', review: 'Native did not return a review result' } })?.text).toBe('Native did not return a review result');
});

it('requires the explicit native Review marker, keeps other Agent tools and foreign/internal observations separate', () => {
  expect(codexReviewItem({ kind: 'internal', native: { type: 'exitedReviewMode', review: 'foreign review' } })).toBeUndefined();
  expect(codexReviewItem({ kind: 'tool.call', native: { type: 'mcpToolCall', review: 'tool content' } })).toBeUndefined();
  expect(codexReviewItem({ kind: 'tool.call', native: { type: 'exitedReviewMode', review: {} } })).toBeUndefined();
});
