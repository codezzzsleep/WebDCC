import { expect, it } from 'vitest';
import { codexCollabCallStatus } from '../src/codex-collab.js';
import type { EventData } from '../src/events.js';

it('reads an immutable legacy completed row from its original native interruption without rewriting it', () => {
  const input = Object.freeze({ type: 'collabAgentToolCall', id: 'original:string:call', tool: 'wait',
    senderThreadId: 'original-parent', status: 'interrupted', agentsStates: { child: { status: 'running', message: null } } });
  const data: EventData['tool.call'] = Object.freeze({ name: 'collabAgentToolCall', status: 'completed', input });
  const original = JSON.stringify(data);
  expect(codexCollabCallStatus(data)).toBe('stopped');
  expect(JSON.stringify(data)).toBe(original);
  expect(data.status).toBe('completed');
});

it('a completed native call can retain a child error without changing the call or claiming a child success', () => {
  const input = { type: 'collabAgentToolCall', id: 'completed:string:call', tool: 'wait', status: 'completed',
    agentsStates: { child: { status: 'errored', message: 'Original child error' } } };
  const data: EventData['tool.call'] = { name: 'collabAgentToolCall', status: 'unknown', input };
  expect(codexCollabCallStatus(data)).toBe('completed');
  expect(input.agentsStates.child).toEqual({ status: 'errored', message: 'Original child error' });
  expect(data.status).toBe('unknown');
});

it('does not accept an inherited status as a native observation', () => {
  const input: unknown = Object.assign(Object.create({ status: 'completed' }) as object, { type: 'collabAgentToolCall' });
  expect(codexCollabCallStatus({ name: 'collabAgentToolCall', status: 'completed', input })).toBe('unknown');
});

it.each([null, [], { type: 'other-native-item', status: 'interrupted' }])('does not reinterpret an unrecognized tool input (%j)', input => {
  expect(codexCollabCallStatus({ name: 'collabAgentToolCall', status: 'completed', input })).toBeUndefined();
});

it('keeps an ordinary tool with a coincidental native-shaped input outside the Codex call projection', () => {
  expect(codexCollabCallStatus({ name: 'ordinary-tool', status: 'completed',
    input: { type: 'collabAgentToolCall', status: 'interrupted' } })).toBeUndefined();
});
