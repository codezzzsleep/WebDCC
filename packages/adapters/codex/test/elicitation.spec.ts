import { expect, it } from 'vitest';
import type { EventData } from '@webdcc/protocol';
import { CodexAdapter } from '../src/adapter.js';
import { elicitationResponse } from '../src/elicitation.js';
import type { McpServerElicitationRequestParams } from '../src/schema/v2/McpServerElicitationRequestParams.js';

const form: McpServerElicitationRequestParams = { threadId: 'thread', turnId: null, serverName: 'server', mode: 'openai/form', _meta: null, message: 'Enter details',
  requestedSchema: { type: 'object', required: ['name', 'age'], properties: { name: { type: 'string', minLength: 1 }, age: { type: 'integer', minimum: 18 } }, additionalProperties: false } };

it.each(['constructor', 'toString', 'hasOwnProperty'])('validates only JSON own fields for native schema key %s', name => {
  for (const dialect of [undefined, 'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema']) {
    const schema = { type: 'object', properties: { [name]: { type: 'string' } }, additionalProperties: false, ...(dialect === undefined ? {} : { $schema: dialect }) };
    const request: McpServerElicitationRequestParams = { ...form, requestedSchema: schema };
    expect(elicitationResponse(request, { action: 'accept', content: {} })).toEqual({ action: 'accept', content: {}, _meta: null });
    const content = { [name]: '  original value  ' };
    expect(elicitationResponse(request, { action: 'accept', content })).toEqual({ action: 'accept', content, _meta: null });
    expect(() => elicitationResponse(request, { action: 'accept', content: { [name]: 12 } })).toThrow('原生要求');
    expect(() => elicitationResponse(request, { action: 'accept', content: { extra: 'not allowed' } })).toThrow('原生要求');
    const inherited = Object.assign(Object.create({ extra: 'not a JSON own field' }) as Record<string, unknown>, content);
    expect(JSON.parse(JSON.stringify(elicitationResponse(request, { action: 'accept', content: inherited })))).toEqual({ action: 'accept', content, _meta: null });
    const required = { ...request, requestedSchema: { ...schema, required: [name] } };
    expect(() => elicitationResponse(required, { action: 'accept', content: {} })).toThrow('required');
  }
});

it.each(['accept', 'decline', 'cancel'] as const)('NP-06 MCP %s produces a typed native reply and waits for native resolution', async action => {
  const replay = CodexAdapter.replay('s', 'thread');
  const events = replay.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 'mcp:string:id', method: 'mcpServer/elicitation/request', params: form } });
  const event = events.find(event => event.type === 'item.complete' && event.kind === 'question') as { data: EventData['question']; scope?: string };
  expect(event.scope).toBe('session');
  const content = action === 'accept' ? { name: '  原文  ', age: 24 } : null;
  expect(await replay.adapter.answer('s', event.data.questionId, { action, content })).toMatchObject({ confirmed: false });
  expect(replay.replies).toEqual([{ id: 'mcp:string:id', result: { action, content, _meta: null } }]);
  await expect(replay.adapter.answer('s', event.data.questionId, { action, content })).rejects.toMatchObject({ statusCode: 409 });
  const resolved = replay.feed({ i: 2, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 'mcp:string:id' } } });
  expect(resolved).toContainEqual(expect.objectContaining({ scope: 'session', kind: 'question', data: expect.objectContaining({ outcome: action, status: action === 'accept' ? 'answered' : 'skipped', resolution: 'native-acknowledged' }) }));
});

it('NP-02 MCP invalid fields, content and identities are rejected before responding or claiming completion', async () => {
  expect(() => elicitationResponse(form, { action: 'accept', content: { name: '', age: 17 } })).toThrow('原生要求');
  expect(() => elicitationResponse(form, { action: 'accept', content: { name: 'ok', age: 22 }, replacementSchema: {} })).toThrow('未知字段');
  expect(() => elicitationResponse(form, { action: 'decline', content: { unexpected: 'input' } })).toThrow('不能包含');
  const replay = CodexAdapter.replay('s', 'thread');
  replay.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 1, method: 'mcpServer/elicitation/request', params: { ...form, threadId: 'other' } } });
  expect(replay.replies).toMatchObject([{ id: 1, error: { code: -32602 } }]);
  const events = replay.feed({ i: 2, t: 0, dir: 'in', ch: 'rpc', frame: { id: 2, method: 'mcpServer/elicitation/request', params: form } });
  const questionId = (events.find(event => event.type === 'item.complete' && event.kind === 'question') as { data: EventData['question'] }).data.questionId;
  await expect(replay.adapter.answer('s', questionId, { action: 'accept', content: { name: 'ok', age: '22' } })).rejects.toMatchObject({ statusCode: 400 });
  expect(replay.replies).toHaveLength(1);
  await replay.adapter.answer('s', questionId, { action: 'accept', content: { name: 'ok', age: 22 } });
  expect(replay.replies).toHaveLength(2);
});

it.each(['grant-turn', 'grant-session', 'deny-permissions'])('NP-06 native %s only grants the requested scope and permission profile', async optionId => {
  const replay = CodexAdapter.replay('s', 'thread');
  const permissions = { network: { enabled: true }, fileSystem: { read: ['/tmp'], write: null } };
  const events = replay.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 7, method: 'item/permissions/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', cwd: '/tmp', environmentId: null, startedAtMs: 1, reason: 'requested', permissions } } });
  const approvalId = (events.find(event => event.type === 'item.complete' && event.kind === 'approval.request') as { data: EventData['approval.request'] }).data.approvalId;
  await expect(replay.adapter.respond('s', { approvalId, optionId: 'accept' })).rejects.toMatchObject({ statusCode: 400 });
  expect(await replay.adapter.respond('s', { approvalId, optionId })).toMatchObject({ confirmed: false });
  expect(replay.replies).toEqual([{ id: 7, result: { scope: optionId === 'grant-session' ? 'session' : 'turn', permissions: optionId === 'deny-permissions' ? {} : permissions } }]);
});

it('NP-06 cancellation closes MCP forms with action=cancel, retains pending identity and never replies twice', async () => {
  const replay = CodexAdapter.replay('s', 'thread');
  replay.feed({ i: 1, t: 0, dir: 'in', ch: 'rpc', frame: { id: 12, method: 'mcpServer/elicitation/request', params: { ...form, mode: 'url', url: 'https://example.com/flow', elicitationId: 'url-id' } } });
  expect(await replay.adapter.cancelPending('s')).toMatchObject({ confirmed: false });
  await replay.adapter.cancelPending('s');
  expect(replay.replies).toEqual([{ id: 12, result: { action: 'cancel', content: null, _meta: null } }]);
  const events = replay.feed({ i: 2, t: 0, dir: 'in', ch: 'rpc', frame: { method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 12 } } });
  expect(events).toContainEqual(expect.objectContaining({ kind: 'question', data: expect.objectContaining({ status: 'skipped', outcome: 'cancel' }) }));
});
