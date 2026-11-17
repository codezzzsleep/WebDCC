import { expect, it } from 'vitest';
import type { ClaudeQueryConfiguration, StoredEvent } from '../src/index.js';
import { currentClaudeConfiguration, isClaudeQueryConfiguration } from '../src/index.js';

const configuration = (queryId: string, options: ClaudeQueryConfiguration['options'] = {}): ClaudeQueryConfiguration => ({
  formatVersion: 1, queryId, nativeSessionId: 'native', sdkVersion: '0.3.322', cliVersion: '2.1.322', scopeFingerprint: 'a'.repeat(64),
  requestedModel: null, options, optionsFingerprint: 'b'.repeat(64), nativeAcceptedAt: '2026-11-16T00:00:00Z', modelEffect: 'not-observed',
});
type Event = Pick<StoredEvent, 'kind' | 'data'>;
const runtime = (id: string, state: 'started' | 'unavailable'): Event => ({ kind: 'internal', data: { nativeType: 'claude/query', claudeTaskRuntime: { id, state } } });
const snapshot = (value: ClaudeQueryConfiguration): Event => ({ kind: 'internal', data: { nativeType: 'claude/query-configuration', claudeConfiguration: value } });

it('retains accepted configuration after query closure without claiming the query is running', () => {
  const value = configuration('one', { thinking: { type: 'enabled', budgetTokens: 1024 }, enableFileCheckpointing: false });
  expect(currentClaudeConfiguration([runtime('one', 'started'), snapshot(value), runtime('one', 'unavailable')], 'native')).toEqual({ state: 'accepted', configuration: value });
});

it('ignores old query configurations and repeated old init after a replacement; an empty snapshot clears every old override', () => {
  const old = configuration('old', { outputFormat: { type: 'json_schema', schema: { type: 'object' } } }); const current = configuration('current');
  const events = [runtime('old', 'started'), snapshot(old), runtime('old', 'unavailable'), runtime('current', 'started'), snapshot(current),
    runtime('old', 'started'), snapshot(old), runtime('current', 'unavailable'), snapshot(configuration('current', { enableFileCheckpointing: true }))];
  expect(currentClaudeConfiguration(events, 'native')).toEqual({ state: 'accepted', configuration: current });
  expect(currentClaudeConfiguration(events, 'other-native')).toEqual({ state: 'none' });
});

it('a malformed newer configuration remains unavailable and never falls back to an older accepted schema', () => {
  const previous = configuration('query', { outputFormat: { type: 'json_schema', schema: { type: 'object' } } });
  const broken = { ...configuration('query'), options: { enableFileCheckpointing: 'false' } } as unknown as ClaudeQueryConfiguration;
  expect(currentClaudeConfiguration([runtime('query', 'started'), snapshot(previous), snapshot(broken)], 'native').state).toBe('unavailable');
});

it('restorable options preserve legal tagged variants and false while excluding one-shot actions and invented model effects', () => {
  for (const options of [{}, { thinking: { type: 'enabled' } }, { thinking: { type: 'disabled' } }, { enableFileCheckpointing: false }]) {
    expect(isClaudeQueryConfiguration(configuration('query', options as ClaudeQueryConfiguration['options']))).toBe(true);
  }
  for (const options of [{ resumeSessionAt: 'one-shot' }, { thinking: { type: 'disabled', display: 'omitted' } },
    { thinking: { type: 'adaptive', budgetTokens: 1024 } }, { thinking: { type: 'enabled', budgetTokens: 10 } }]) {
    expect(isClaudeQueryConfiguration({ ...configuration('query'), options })).toBe(false);
  }
  expect(isClaudeQueryConfiguration({ ...configuration('query'), modelEffect: 'confirmed' })).toBe(false);
});
