import { expect, it } from 'vitest';
import { codexNativeToolStatus } from '../src/codex-tool-call.js';
import type { EventData } from '../src/events.js';

it.each(['mcpToolCall', 'dynamicToolCall'])('reads immutable old %s rows from native progress without altering their status or results', name => {
  const input = Object.freeze({ type: name, id: 'old:string:call', status: 'inProgress', arguments: { value: null },
    result: { content: [{ text: '原件🐈' }] }, success: null });
  const data: EventData['tool.call'] = Object.freeze({ name, status: 'completed', input });
  const original = JSON.stringify(data);
  expect(codexNativeToolStatus(data)).toBe('running');
  expect(JSON.stringify(data)).toBe(original);
  expect(data.status).toBe('completed');
});

it('uses the native call status independently of a dynamic tool result success flag', () => {
  const data: EventData['tool.call'] = { name: 'dynamicToolCall', status: 'unknown',
    input: { type: 'dynamicToolCall', status: 'completed', success: false, contentItems: [{ type: 'inputText', text: 'Native tool outcome' }] } };
  expect(codexNativeToolStatus(data)).toBe('completed');
  expect(data.input).toMatchObject({ success: false, contentItems: [{ text: 'Native tool outcome' }] });
  expect(data.status).toBe('unknown');
});

it('does not treat an inherited status as a native field', () => {
  const input: unknown = Object.assign(Object.create({ status: 'completed' }) as object, { type: 'mcpToolCall' });
  expect(codexNativeToolStatus({ name: 'mcpToolCall', status: 'completed', input })).toBe('unknown');
});

it.each([null, [], { type: 'dynamicToolCall', status: 'inProgress' }])('leaves unrelated or malformed MCP inputs (%j) outside its projection', input => {
  expect(codexNativeToolStatus({ name: 'mcpToolCall', status: 'completed', input })).toBeUndefined();
});

it('does not change a generic tool with a coincidental MCP-shaped input', () => {
  expect(codexNativeToolStatus({ name: 'ordinary-tool', status: 'completed', input: { type: 'mcpToolCall', status: 'inProgress' } })).toBeUndefined();
});
