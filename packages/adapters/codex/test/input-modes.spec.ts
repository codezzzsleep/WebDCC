import { expect, it } from 'vitest';
import { isInputContent, publicInputContent } from '@webdcc/protocol';
import { validateNativeParams, validateNativeResult } from '../src/controls.js';

it('validates the separately exported pinned experimental mode contract and preserves the standard turn contract', () => {
  const standard = { threadId: 'native', input: [{ type: 'text', text: '原文', text_elements: [] }] };
  const mode = { mode: 'plan', settings: { model: 'actual-model', reasoning_effort: 'xhigh', developer_instructions: null } };
  expect(() => validateNativeParams('turn/start', standard)).not.toThrow();
  expect(() => validateNativeParams('turn/start', { ...standard, collaborationMode: mode })).not.toThrow();
  expect(() => validateNativeParams('turn/start', { ...standard, collaborationMode: { ...mode, settings: { ...mode.settings, model: null } } })).toThrow();
  expect(() => validateNativeParams('turn/start', { ...standard, collaborationMode: { ...mode, mode: 'invented' } })).toThrow();
  expect(() => validateNativeParams('turn/start', { ...standard, collaborationMode: { ...mode, settings: { ...mode.settings, reasoningEffort: 'max' } } })).toThrow();
  expect(() => validateNativeParams('turn/start', { ...standard, injected: true })).toThrow();
  expect(() => validateNativeParams('collaborationMode/list', {})).not.toThrow();
  expect(() => validateNativeParams('collaborationMode/list', { activate: true })).toThrow();
  expect(() => validateNativeResult('collaborationMode/list', { data: [{ name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' }] })).not.toThrow();
  expect(() => validateNativeResult('collaborationMode/list', { data: [{ name: 'Plan', mode: 'invented' }] })).toThrow();
});

it('mode is a typed durable input field, rejects arbitrary browser controls and does not alter input text', () => {
  const input = { version: 1 as const, parts: [{ type: 'text' as const, text: '  中文\r\n  ' }], collaborationMode: 'plan' as const };
  expect(isInputContent(input, '  中文\r\n  ')).toBe(true);
  expect(publicInputContent(input)).toEqual(input);
  expect(isInputContent({ ...input, collaborationMode: 'invented' })).toBe(false);
  expect(isInputContent({ ...input, developerInstructions: 'rewrite' })).toBe(false);
});
