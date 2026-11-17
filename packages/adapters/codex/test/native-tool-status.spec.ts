import { Ajv } from 'ajv';
import { expect, it } from 'vitest';
import { isValidEventData, type EventData } from '@webdcc/protocol';
import { CodexAdapter, mapItemData } from '../src/adapter.js';
import schema from '../src/json-schema/compatibility-0.169.0.schemas.json' with { type: 'json' };
import { nativeToolItem } from './fixtures/native-tool-items.js';

const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
for (const type of ['mcpToolCall', 'dynamicToolCall'] as const) {
  const branch = schema.definitions.v2.ThreadItem.oneOf.find(value => value.properties.type.enum.includes(type));
  if (branch === undefined) throw new Error('Missing reviewed native tool call contract');
  const valid = ajv.compile({ ...branch, definitions: schema.definitions });

  it.each([['inProgress', 'running'], ['completed', 'completed'], ['failed', 'failed']] as const)(
    `${type} retains native %s lifecycle and complete original identity/content`, (status, expected) => {
      const item = nativeToolItem(type, status);
      expect(valid(item), ajv.errorsText(valid.errors)).toBe(true);
      const replay = CodexAdapter.replay('native-tools', 'parent');
      replay.feed({ i: 1, t: 1, dir: 'in', ch: 'rpc', frame: { method: 'turn/started', params: { threadId: 'parent', turn: { id: 'original-turn', status: 'inProgress' } } } });
      const emitted = replay.feed({ i: 2, t: 2, dir: 'in', ch: 'rpc', frame: {
        method: status === 'inProgress' ? 'item/started' : 'item/completed',
        params: { threadId: 'parent', turnId: 'original-turn', item },
      } });
      const event = emitted.find(value => (value.type === 'item.start' || value.type === 'item.complete') && value.kind === 'tool.call');
      expect(event).toMatchObject({ type: status === 'inProgress' ? 'item.start' : 'item.complete',
        kind: 'tool.call', itemKey: item.id, nativeTurnId: 'original-turn', native: item });
      if (event?.type !== 'item.start' && event?.type !== 'item.complete') throw new Error('Missing native item event');
      const data = event.data as EventData['tool.call'];
      expect(data.status).toBe(expected);
      expect(data.input).toEqual(item);
      expect(isValidEventData('tool.call', data)).toBe(true);
      expect(emitted.some(value => value.type === 'turn.start' || value.type === 'turn.end' || value.type === 'item.complete' && value.kind === 'assistant.message')).toBe(false);
    });

  it.each([undefined, 'future-native-state', 'toString'])(`${type} preserves unsupported or missing state (%j) without declaring completion`, status => {
    const item: Record<string, unknown> = { ...nativeToolItem(type, 'inProgress'), status };
    if (status === undefined) delete item['status'];
    const data = mapItemData(item) as EventData['tool.call'];
    expect(data.status).toBe('unknown');
    expect(data.input).toEqual(item);
    expect(isValidEventData('tool.call', data)).toBe(true);
  });
}
