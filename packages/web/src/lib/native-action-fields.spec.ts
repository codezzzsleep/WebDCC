import { expect, it } from 'vitest';
import { dshNativeActionMetadata, dshNativeCall, parseDshNativeAction } from '../../../adapters/dsh/src/native.js';
import { nativeActionFields } from './native-action-fields.js';

const revision = 'a'.repeat(64);
const catalog = { settings: { writable: true, namespaces: [{ ns: 'one', revision: 0 }, { ns: 'two', revision: 7 }] } };
const schema = (type: string) => dshNativeActionMetadata(true, catalog).find(action => action.type === type)!.schema;
const settings = (ns = 'one') => ({ type: 'settings-mutate', ns, ops: [{ op: 'set', path: ['model'], value: '  原样\r\ntext  ' }] });

it.each([{ ns: 'one', expected: 0 }, { ns: 'two', expected: 7 }])('fills the exact native revision for namespace $ns, including revision zero', ({ ns, expected }) => {
  const input = settings(ns);
  const result = nativeActionFields(input, schema(input.type), catalog, 'outer-command');
  const parsed = parseDshNativeAction({ ...result, revision });
  expect(dshNativeCall(parsed, 'native-parent')).toEqual({ endpoint: 'settings/mutate', args: { ns, ops: input.ops, expectedRevision: expected } });
  expect(input).not.toHaveProperty('expectedRevision');
  expect(result.ops).toEqual(input.ops);
});

it('rejects a supplied stale version instead of silently upgrading its CAS evidence', () => {
  const input = { ...settings('two'), expectedRevision: 99 };
  expect(() => nativeActionFields(input, schema(input.type), catalog, 'outer-command')).toThrow('原生设置版本已变化');
  expect(input.expectedRevision).toBe(99);
});

it('retains a supplied revision that matches the selected native namespace', () => {
  const input = { ...settings('two'), expectedRevision: 7 };
  expect(nativeActionFields(input, schema(input.type), catalog, 'outer-command').expectedRevision).toBe(7);
});

it.each([
  { settings: undefined },
  { settings: { unavailable: true, writable: true, namespaces: [{ ns: 'one', revision: 1 }] } },
  { settings: { writable: false, namespaces: [{ ns: 'one', revision: 1 }] } },
  { settings: { writable: true, namespaces: [{ ns: 'other', revision: 1 }] } },
  { settings: { writable: true, namespaces: [{ ns: 'one', revision: -1 }] } },
  { settings: { writable: true, namespaces: [{ ns: 'one', revision: 1.5 }] } },
  { settings: { writable: true, namespaces: [{ ns: 'one', revision: 1 }, { ns: 'one', revision: 2 }] } },
])('rejects unavailable, nonwritable, ambiguous or invalid native settings evidence before submission %#', invalid => {
  const input = settings();
  expect(() => nativeActionFields(input, schema(input.type), invalid, 'outer-command')).toThrow(/原生设置.*刷新/);
  expect(input).not.toHaveProperty('expectedRevision');
});

it('retains the existing per-command child requestId generation and exact user text', () => {
  const input = { type: 'child-prompt', childSessionId: 'child', delivery: 'steer', text: '  原样\r\nmessage  ' };
  const result = nativeActionFields(input, schema(input.type), catalog, 'outer-command');
  const parsed = parseDshNativeAction({ ...result, revision });
  expect(dshNativeCall(parsed, 'native-parent')).toEqual({ endpoint: 'subagents/prompt', args: { request: { requestId: 'outer-command', childSessionId: 'child', delivery: 'steer', content: [{ type: 'text', text: input.text }] } } });
  expect(input).not.toHaveProperty('requestId');
});

it('preserves an explicitly supplied native request identity', () => {
  const input = { type: 'child-prompt', requestId: 'native-request', childSessionId: 'child', delivery: 'queue', text: 'exact' };
  expect(nativeActionFields(input, schema(input.type), catalog, 'outer-command').requestId).toBe('native-request');
});

it('does not add settings versions to actions whose schema does not request that source', () => {
  const input = { type: 'rename', title: '  exact  ' };
  expect(nativeActionFields(input, schema(input.type), catalog, 'outer-command')).toEqual(input);
});
