import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/adapter.js';

const oldId = '11111111-1111-4111-8111-111111111111';
const nextId = '22222222-2222-4222-8222-222222222222';
const resetUuid = '33333333-3333-4333-8333-333333333333';
const inputUuid = '44444444-4444-4444-8444-444444444444';

it.each(['clear', 'plan_mode_exit', 'fresh_session', 'onboarding', undefined, 'future-trigger'])('preserves the authoritative conversation reset for trigger %s', trigger => {
  const replay = ClaudeAdapter.replay('controlled-session');
  const reset = Object.freeze({ type: 'conversation_reset', new_conversation_id: nextId, uuid: resetUuid, session_id: oldId,
    ...(trigger === undefined ? {} : { trigger }), user_message_uuid: inputUuid, timestamp: '2000-01-01T00:00:00.000Z' });
  const events = replay.feed({ i: 1, t: 10, dir: 'in', ch: 'sdk', frame: reset as unknown as SDKMessage });
  expect(events).toContainEqual(expect.objectContaining({ type: 'item.complete', kind: 'notice', scope: 'session', native: reset,
    data: expect.objectContaining({ nativeType: 'conversation_reset', contextReset: expect.objectContaining({ id: nextId, uuid: resetUuid,
      userMessageUuid: inputUuid, timestamp: reset.timestamp, ...(trigger === undefined ? {} : { trigger }) }) }) }));
  expect(events.some(event => event.type === 'item.complete' && event.kind === 'unknown')).toBe(false);
  expect(reset.new_conversation_id).toBe(nextId);
});
