import { expect, it } from 'vitest';
import { validateDshArgs, validateDshResult } from '../src/contracts.js';
import stopEvidence from '../../../../fixtures/dsh/subagent-stop-contract.json' with { type: 'json' };

it('NP-02/11 checks real catalog wrappers, exact parent identity fields and mode discriminators', () => {
  expect(() => validateDshArgs('subagents/prompt', { requestId: 'one', childSessionId: 'child', content: [] })).toThrow('request');
  expect(() => validateDshArgs('subagents/prompt', { request: { requestId: 'one', childSessionId: 'child', mode: 'continuable', parentSessionId: 'parent', delivery: 'queue', content: [] } })).toThrow('additional');
  expect(() => validateDshArgs('subagents/prompt', { request: { requestId: 'one', childSessionId: 'child', delivery: 'queue', content: [] } })).not.toThrow();
  expect(() => validateDshArgs('subagents/interruptByUser', { childSessionId: 'child' })).not.toThrow();
  expect(() => validateDshArgs('subagents/interruptByUser', { childSessionId: 'child', parentSessionId: 'parent', mode: 'continuable' })).toThrow('additional');
  expect(() => validateDshArgs('subagents/interruptByParent', { childSessionId: 'child', parentSessionId: 'parent', mode: 'continuable' })).toThrow('absent');
  expect(() => validateDshArgs('session/follow', { request: { address: { kind: 'session', sessionId: 'one' }, afterSeq: 42 } })).toThrow('additional');
});

it('the captured actual native Stop request and receipt pass the contract while an unaccepted receipt does not', () => {
  const accepted = stopEvidence.capture['subagents/interruptByUser'];
  expect(accepted.httpStatus).toBe(200);
  expect(() => validateDshArgs('subagents/interruptByUser', accepted.request.payload.args)).not.toThrow();
  expect(() => validateDshResult('subagents/interruptByUser', accepted.response.result.value)).not.toThrow();
  expect(() => validateDshResult('subagents/interruptByUser', { accepted: false })).toThrow();
  expect(stopEvidence.capture['subagents/interruptByParent'].httpStatus).toBe(404);
});

it('the official waterfall rejection retains its exact error fields at the native HTTP boundary', () => {
  const args = { clientId: 'native-client', eventId: 'native-waterfall', outcome: { kind: 'rejected', error: {
    name: 'UserQuestionError', message: 'ask_user_question timed out before the user answered', code: 'ASK_TIMED_OUT',
  } } };
  expect(() => validateDshArgs('$events/result', args)).not.toThrow();
});
