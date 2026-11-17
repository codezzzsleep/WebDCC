import { expect, it } from 'vitest';
import { codexNativeImageStatus, type EventData } from '../src/index.js';

const data = (status: unknown): EventData['tool.call'] => ({ name: 'imageGeneration', status: 'completed',
  input: { type: 'imageGeneration', id: 'native:image', status, result: '', failure: null, generationId: null } });

it.each([['in_progress', 'running'], ['completed', 'completed'], ['failed', 'failed'], ['', 'unknown'], ['future', 'unknown'], [undefined, 'unknown']])(
  'reads the original native status %s for new and immutable legacy image cards', (status, expected) => {
    const original = data(status); const before = JSON.stringify(original); Object.freeze(original); Object.freeze(original.input);
    expect(codexNativeImageStatus(original)).toBe(expected); expect(JSON.stringify(original)).toBe(before);
  });

it('keeps namespace/type mismatches and ordinary tools outside the Codex image reader', () => {
  expect(codexNativeImageStatus({ ...data('in_progress'), name: 'ordinary-tool' })).toBeUndefined();
  expect(codexNativeImageStatus({ ...data('in_progress'), input: { type: 'ordinary-tool', status: 'in_progress' } })).toBeUndefined();
  expect(codexNativeImageStatus({ ...data('in_progress'), input: null })).toBeUndefined();
  expect(codexNativeImageStatus({ ...data('in_progress'), input: [] })).toBeUndefined();
});
