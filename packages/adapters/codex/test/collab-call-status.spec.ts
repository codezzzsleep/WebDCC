import { Ajv } from 'ajv';
import { expect, it } from 'vitest';
import { isValidEventData, type AdapterEvent, type EventData } from '@webdcc/protocol';
import { CodexAdapter, mapItemData } from '../src/adapter.js';
import type { ThreadItem } from '../src/schema/v2/ThreadItem.js';
import type { CollabAgentToolCallStatus } from '../src/schema/v2/CollabAgentToolCallStatus.js';
import schema from '../src/json-schema/compatibility-0.169.0.schemas.json' with { type: 'json' };
import capture from './fixtures/collab-call-native.json' with { type: 'json' };

const branch = schema.definitions.v2.ThreadItem.oneOf.find(value => value.properties.type.enum.includes('collabAgentToolCall'));
if (branch === undefined) throw new Error('Missing reviewed native collab item contract');
const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
for (const [name, min, max] of [['uint', 0, Number.MAX_SAFE_INTEGER], ['uint16', 0, 65535],
  ['uint32', 0, 4294967295], ['uint64', 0, Number.MAX_SAFE_INTEGER],
  ['int32', -2147483648, 2147483647], ['int64', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]] as const) {
  ajv.addFormat(name, { type: 'number', validate: value => Number.isSafeInteger(value) && value >= min && value <= max });
}
const valid = ajv.compile({ ...branch, definitions: schema.definitions });
const tool = (event: AdapterEvent) => {
  if ((event.type !== 'item.start' && event.type !== 'item.complete') || event.kind !== 'tool.call') return undefined;
  return event.data as EventData['tool.call'];
};

it('replays both original official started/completed calls without declaring the running calls successful or changing native identity', () => {
  const replay = CodexAdapter.replay('call-state', capture.nativeId);
  const states: string[] = [];
  for (const row of capture.frames) {
    const frame = row.payload;
    const emitted = replay.feed({ i: row.originalRpcEnvelopeId, t: row.originalRpcEnvelopeId, dir: 'in', ch: 'rpc', frame });
    if (frame.method === 'turn/started') continue;
    const params = frame.params as { turnId: string; item: Record<string, unknown> };
    expect(valid(params.item), ajv.errorsText(valid.errors)).toBe(true);
    const event = emitted.find(value => tool(value)?.name === 'collabAgentToolCall');
    expect(event).toBeDefined();
    const data = tool(event!)!;
    expect(data.input).toEqual(params.item);
    expect(data.status).toBe(frame.method === 'item/started' ? 'running' : 'completed');
    expect(event).toMatchObject({ itemKey: params.item['id'], nativeTurnId: params.turnId, native: params.item });
    expect(isValidEventData('tool.call', data)).toBe(true);
    states.push(data.status);
  }
  expect(states).toEqual(['running', 'completed', 'running', 'completed']);
  expect(capture.originalCapturePassed).toBe(false);
});

it.each([['completed', 'completed'], ['failed', 'failed'], ['interrupted', 'stopped']] as const)(
  'the native %s call retains its own terminal status without ending the parent or claiming a child result', (nativeStatus, expectedStatus) => {
    const replay = CodexAdapter.replay('call-state', capture.nativeId);
    const turn = capture.frames[0]!;
    replay.feed({ i: 1, t: 1, dir: 'in', ch: 'rpc', frame: turn.payload });
    const params = turn.payload.params as { turn: { id: string } };
    const item = (status: CollabAgentToolCallStatus) => ({ type: 'collabAgentToolCall', id: 'wait:original:string:id',
      tool: 'wait', status, senderThreadId: capture.nativeId, receiverThreadIds: ['known-native-child'],
      prompt: null, model: null, reasoningEffort: null,
      agentsStates: { 'known-native-child': { status: 'running', message: null } } } satisfies ThreadItem);
    const feed = (method: string, value: ThreadItem, index: number) => replay.feed({ i: index, t: index, dir: 'in', ch: 'rpc',
      frame: { method, params: { threadId: capture.nativeId, turnId: params.turn.id, item: value } } });
    const started = feed('item/started', item('inProgress'), 2);
    const original = item(nativeStatus);
    expect(valid(original), ajv.errorsText(valid.errors)).toBe(true);
    const ended = feed('item/completed', original, 3);
    expect(started.map(tool).filter(Boolean)).toMatchObject([{ status: 'running' }]);
    expect(ended.map(tool).filter(Boolean)).toMatchObject([{ status: expectedStatus, input: original }]);
    expect(ended).toContainEqual(expect.objectContaining({ type: 'item.complete', itemKey: original.id,
      nativeTurnId: params.turn.id, native: original }));
    expect(ended.some(value => value.type === 'turn.end' || value.type === 'turn.start')).toBe(false);
    expect(ended.some(value => tool(value)?.name === 'subagent' || value.type === 'item.complete' && value.kind === 'assistant.message')).toBe(false);
  });

it.each([undefined, 'future-native-state', 'toString'])('retains an unsupported or absent native call status (%j) as unknown', status => {
  const item = { type: 'collabAgentToolCall', id: 'unsupported:call', tool: 'wait', senderThreadId: capture.nativeId,
    receiverThreadIds: [], agentsStates: {}, ...(status === undefined ? {} : { status }) };
  const data = mapItemData(item) as EventData['tool.call'];
  expect(data.status).toBe('unknown');
  expect(data.input).toEqual(item);
  expect(isValidEventData('tool.call', data)).toBe(true);
});
