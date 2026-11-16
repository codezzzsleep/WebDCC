import { expect, it } from 'vitest';
import { claudeResultOutput, claudeStructuredOutputs, isValidEventData, reduceTurn, type StoredEvent } from '../src/index.js';

const native = { type: 'result', subtype: 'success', is_error: false, uuid: 'native-result', session_id: 'native-session',
  result_index: 0, structured_output: { exact: ['value', false, null, 0] } };
const completion: StoredEvent<'turn.completed'> = { sessionId: 'web', turnId: 'turn', seq: 3, itemKey: 'turn-end',
  at: '2026-11-16T00:00:00Z', kind: 'turn.completed', data: { status: 'completed', durationMs: 1 }, native };

it('recovers a legacy native attachment without inventing a query identity or rewriting the terminal row', () => {
  const original = structuredClone(completion);
  const turn = reduceTurn([completion]);
  expect(turn.structuredOutputs).toEqual([{ itemKey: 'turn-end:structured-output', seq: 3,
    data: expect.objectContaining({ nativeResultId: 'native-result', nativeSessionId: 'native-session', status: 'completed', value: native.structured_output }) }]);
  expect(turn.structuredOutputs![0]!.data).not.toHaveProperty('queryId');
  expect(turn.answer).toEqual([]);
  expect(completion).toEqual(original);
});

it('renders a new projection once alongside its original terminal result and preserves equal IDs in separate queries', () => {
  const first: StoredEvent<'structured.output'> = { ...completion, seq: 1, itemKey: 'query-one:output', kind: 'structured.output', data: claudeResultOutput(native, 'query-one')! };
  const second: StoredEvent<'structured.output'> = { ...first, seq: 4, itemKey: 'query-two:output', data: claudeResultOutput(native, 'query-two')! };
  expect(claudeStructuredOutputs([first, completion])).toEqual([{ itemKey: first.itemKey, seq: 1, data: first.data }]);
  expect(claudeStructuredOutputs([first, completion, second]).map(output => output.data.queryId)).toEqual(['query-one', 'query-two']);
});

it('validates actual scalar values and rejects a completed attachment with no value', () => {
  for (const value of [null, false, 0, [], 'native string']) expect(isValidEventData('structured.output', claudeResultOutput({ ...native, structured_output: value }))).toBe(true);
  const { value: _value, ...missing } = claudeResultOutput(native)!;
  expect(isValidEventData('structured.output', missing)).toBe(false);
  expect(isValidEventData('structured.output', { ...missing, status: 'unknown' })).toBe(true);
});

it('does not manufacture a result from ordinary JSON text, missing payloads, or an unrelated Agent', () => {
  const { structured_output: _attachment, ...plain } = native;
  expect(claudeResultOutput({ ...plain, result: '{"exact":true}' })).toBeUndefined();
  expect(claudeStructuredOutputs([{ ...completion, native: { ...plain, result: '{broken' } }])).toEqual([]);
  expect(claudeStructuredOutputs([{ ...completion, native: { type: 'codex-result', structured_output: true } }])).toEqual([]);
  expect(claudeResultOutput(plain, 'query', true)).toMatchObject({ status: 'unknown' });
});
