import { expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { claudeNativeActionCatalog, parseClaudeNativeAction } from '../src/native.js';

it.each([{ type: 'enabled' }, { type: 'enabled', display: 'omitted' }, { type: 'enabled', display: 'summarized' }])('accepts the SDK optional budget contract: $type/$display', thinking => {
  expect(parseClaudeNativeAction({ type: 'thinking', thinking })).toEqual({ type: 'thinking', thinking });
});

it('declares only the native fields allowed by each tagged thinking variant', () => {
  const schema = claudeNativeActionCatalog([]).find(action => action.type === 'thinking')!.schema;
  const valid = new Ajv({ strict: false }).compile(schema);
  for (const thinking of [null, { type: 'disabled' }, { type: 'adaptive' }, { type: 'adaptive', display: 'summarized' },
    { type: 'enabled' }, { type: 'enabled', budgetTokens: 1024, display: 'omitted' }]) expect(valid({ type: 'thinking', thinking })).toBe(true);
  for (const thinking of [{ type: 'disabled', budgetTokens: 1024 }, { type: 'disabled', display: 'omitted' },
    { type: 'adaptive', budgetTokens: 1024 }, { type: 'enabled', budgetTokens: '1024' }, { type: 'enabled', budgetTokens: 1 }]) expect(valid({ type: 'thinking', thinking })).toBe(false);
});

it('rejects invalid provided budgets and fields instead of converting them into native defaults', () => {
  for (const budgetTokens of [null, 0, 512, -1, 1024.5, '1024']) expect(() => parseClaudeNativeAction({ type: 'thinking', thinking: { type: 'enabled', budgetTokens } })).toThrow();
  for (const thinking of [{ type: 'disabled', display: 'omitted' }, { type: 'adaptive', budgetTokens: 1024 },
    { type: 'enabled', display: 'hidden' }, { type: 'enabled', other: true }]) expect(() => parseClaudeNativeAction({ type: 'thinking', thinking })).toThrow();
});
