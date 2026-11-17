import { expect, it } from 'vitest';
import { codexNativeToolStatus, isValidEventData, type EventData } from '../src/index.js';

const data = (phase?: unknown, input: unknown = { type: 'webSearch', id: 'native:search', query: null, action: null }): EventData['tool.call'] =>
  ({ name: 'webSearch', input, status: 'completed', ...(phase === undefined ? {} : { codexItemPhase: phase }) }) as EventData['tool.call'];

it.each([['started', 'running'], ['completed', 'completed'], [undefined, 'unknown'], ['future', 'unknown']])(
  'reads only an explicit native WebSearch phase %s and keeps unknown legacy phases honest', (phase, status) => {
    expect(codexNativeToolStatus(data(phase))).toBe(status);
  });

it('accepts native completion timestamp evidence but does not infer completion from results or a parent turn', () => {
  expect(codexNativeToolStatus(data(undefined, { type: 'webSearch', id: 'native:search', completedAtMs: 123 }))).toBe('completed');
  expect(codexNativeToolStatus(data(undefined, { type: 'webSearch', id: 'native:search', results: [{ text: 'already available' }], parentStatus: 'completed' }))).toBe('unknown');
});

it('does not rewrite the original legacy input or claim a native phase from an unrelated tool input', () => {
  const legacy = data(); const before = JSON.stringify(legacy); Object.freeze(legacy); Object.freeze(legacy.input);
  expect(codexNativeToolStatus(legacy)).toBe('unknown'); expect(JSON.stringify(legacy)).toBe(before);
  expect(codexNativeToolStatus({ ...data('started'), input: { type: 'ordinary-tool' } })).toBeUndefined();
  expect(codexNativeToolStatus({ ...data('started'), name: 'WebSearch' })).toBeUndefined();
});

it('validates the additive phase without rejecting legacy tool data or allowing a guessed phase value', () => {
  expect(isValidEventData('tool.call', data())).toBe(true);
  expect(isValidEventData('tool.call', data('started'))).toBe(true);
  expect(isValidEventData('tool.call', data('completed'))).toBe(true);
  expect(isValidEventData('tool.call', data('future'))).toBe(false);
});
