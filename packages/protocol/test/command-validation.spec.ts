import { expect, it } from 'vitest';
import { isClientMessage, isCommand } from '../src/command-validation.js';

it('NP-02 rejects malformed authenticated commands and subscriptions before handlers run', () => {
  for (const message of [null, [], { op: 'hello' }, { op: 'subscribe', subscribe: [{ sessionId: 's', afterSeq: -1 }] }, { op: 'command', command: { op: 'rpc', method: 'anything', clientCommandId: 'c' } }]) expect(isClientMessage(message)).toBe(false);
  const command = { op: 'send', clientCommandId: 'c', sessionId: 's', text: '字\r\n' };
  expect(isCommand(command)).toBe(true);
  expect(isClientMessage({ op: 'command', command })).toBe(true);
  expect(isCommand({ ...command, images: ['file', 2] })).toBe(false);
  expect(isClientMessage({ op: 'hello', clientId: 'browser', feedAfter: 0, subscribe: [{ sessionId: 's', afterSeq: 0 }] })).toBe(true);
});
