import { expect, it } from 'vitest';
import { validateDshArgs } from '../src/contracts.js';

it('NP-02/11 checks real catalog wrappers, exact parent identity fields and mode discriminators', () => {
  expect(() => validateDshArgs('subagents/prompt', { requestId: 'one', childSessionId: 'child', content: [] })).toThrow('request');
  expect(() => validateDshArgs('subagents/prompt', { request: { requestId: 'one', childSessionId: 'child', mode: 'continuable', delivery: 'queue', content: [] } })).toThrow('parentSessionId');
  expect(() => validateDshArgs('subagents/interruptByUser', { childSessionId: 'child' })).toThrow('absent');
  expect(() => validateDshArgs('subagents/interruptByParent', { childSessionId: 'child', parentSessionId: 'parent', mode: 'one-shot' })).toThrow('constant');
  expect(() => validateDshArgs('subagents/interruptByParent', { childSessionId: 'child', parentSessionId: 'parent', mode: 'continuable' })).not.toThrow();
  expect(() => validateDshArgs('session/follow', { request: { address: { kind: 'session', sessionId: 'one' }, afterSeq: 42 } })).toThrow('additional');
});
