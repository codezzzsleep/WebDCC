import { afterEach, expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { classifySensitive, elicitationResult, parseClaudeNativeAction } from '../src/native.js';
import { ClaudeNativeState } from '../src/native-state.js';
const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocked.query }));
import { ClaudeAdapter } from '../src/adapter.js';

function harness() {
  let options: Options;
  let closed = false;
  let wake: (() => void) | undefined;
  const messages: SDKMessage[] = [];
  const q = {
    async *[Symbol.asyncIterator]() { while (!closed || messages.length) { const message = messages.shift(); if (message !== undefined) yield message; else await new Promise<void>(resolve => { wake = resolve; }); } },
    close: vi.fn(() => { closed = true; wake?.(); }),
    initializationResult: vi.fn(async () => ({ claude_code_version: '2.1.322', available_output_styles: ['default'], output_style: 'default' })),
    supportedModels: vi.fn(async () => [{ value: 'native-alias', resolvedModel: 'native-wire-id', displayName: 'Native model', description: 'Native catalog', supportedEffortLevels: ['low', 'high'], supportsAdaptiveThinking: true }]),
    supportedCommands: vi.fn(async () => [{ name: 'native-skill', description: 'from plugin', argumentHint: '<file>', builtin: false }]),
    supportedAgents: vi.fn(async () => [{ name: 'native-agent', description: 'inherited' }]),
    accountInfo: vi.fn(async () => ({ apiProvider: 'firstParty', tokenSource: 'none' })),
    mcpServerStatus: vi.fn(async () => [{ name: 'native-mcp', status: 'needs-auth', source: 'user', scope: 'user', config: { type: 'http', url: 'https://example.test?token=SECRET', headers: { Authorization: 'SECRET' } } }]),
    stopTask: vi.fn(async () => undefined),
    reloadSkills: vi.fn(async () => ({ commands: [] })),
    interrupt: vi.fn(async () => { throw new Error('interrupt failed'); }),
  };
  mocked.query.mockImplementation((input: { options: Options }) => { options = input.options; return q as unknown as Query; });
  const adapter = new ClaudeAdapter();
  return { adapter, q, options: () => options, push(message: Record<string, unknown>) { messages.push(message as unknown as SDKMessage); wake?.(); } };
}
afterEach(() => mocked.query.mockReset());

it('validates native options and form schemas, preserving decline/cancel without content', () => {
  expect(() => parseClaudeNativeAction({ type: 'thinking', thinking: { type: 'enabled', budgetTokens: 5 } })).toThrow('1024');
  expect(() => parseClaudeNativeAction({ type: 'output', schema: { type: 'invalid-type' } })).toThrow('schema');
  expect(() => parseClaudeNativeAction({ type: 'model', model: 'native', prompt: 'hidden' })).toThrow('未知');
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { age: { type: 'integer', minimum: 18 }, password: { type: 'string', format: 'password' } }, required: ['age'], additionalProperties: false };
  expect(() => elicitationResult(schema, 'accept', { age: 17 })).toThrow('schema');
  expect(elicitationResult(schema, 'accept', { age: 21, password: 'secret' })).toEqual({ action: 'accept', content: { age: 21, password: 'secret' } });
  expect(elicitationResult(schema, 'decline', { password: 'secret' })).toEqual({ action: 'decline' });
  expect(classifySensitive({ type: 'elicitation', requestId: 'r', action: 'accept' })).toBe(true);
});

it('uses native catalog sources and never returns MCP credential-bearing transport config', async () => {
  const h = harness();
  try {
    await h.adapter.create({ sessionId: 's', cwd: '/tmp', providerId: null });
    expect(await h.adapter.listModels()).toEqual([{ id: 'native-alias', label: 'Native model', reasoningEfforts: ['low', 'high'], source: 'Claude Query.supportedModels/2.1.322' }]);
    const catalog = await h.adapter.nativeCatalog('s');
    expect(catalog.commands[0]).toMatchObject({ argumentHint: '<file>', builtin: false });
    expect(JSON.stringify(catalog.mcp)).not.toContain('SECRET');
    expect(catalog.actions.find(action => action.type === 'dialog')?.supported).toBe(false);
    await expect(h.adapter.executeNativeControl('s', { type: 'model', model: 'unlisted' })).rejects.toThrow('目录');
    await expect(h.adapter.executeNativeControl('s', { type: 'model', model: 'unlisted' })).rejects.toMatchObject({ code: 'native-control-rejected' });
    expect(h.q.close).not.toHaveBeenCalled();
    await expect(h.adapter.interrupt('s')).rejects.toThrow('interrupt failed');
  } finally { await h.adapter.dispose('s'); }
});

it('keeps MCP request identities, retries invalid form replies, deduplicates redelivery and cancels on disposal', async () => {
  const h = harness();
  try {
    await h.adapter.create({ sessionId: 's', cwd: '/tmp', providerId: null });
    const signal = new AbortController();
    const request = { serverName: 'mcp', message: 'Enter value', requestedSchema: { type: 'object', properties: { value: { type: 'integer', minimum: 1 } }, required: ['value'] } };
    const first = h.options().onElicitation!(request, { requestId: 'exact-id', signal: signal.signal });
    const second = h.options().onElicitation!(request, { requestId: 'exact-id', signal: signal.signal });
    await expect(h.adapter.executeNativeControl('s', { type: 'elicitation', requestId: 'exact-id', action: 'accept', content: { value: 0 } })).rejects.toThrow('schema');
    await expect(h.adapter.executeNativeControl('s', { type: 'elicitation', requestId: 'exact-id', action: 'accept', content: { value: 0 } })).rejects.toMatchObject({ code: 'native-control-rejected' });
    expect(h.adapter.nativeState('s').interactions[0]?.status).toBe('pending');
    expect(await h.adapter.executeNativeControl('s', { type: 'elicitation', requestId: 'exact-id', action: 'accept', content: { value: 2 } })).toEqual({ submitted: true, confirmed: false, requestId: 'exact-id' });
    expect(await first).toEqual({ action: 'accept', content: { value: 2 } });
    expect(await second).toEqual(await first);
    expect(h.adapter.nativeState('s').interactions[0]?.status).toBe('submitted');
    await expect(h.adapter.executeNativeControl('s', { type: 'elicitation', requestId: 'exact-id', action: 'accept', content: { value: 3 } })).rejects.toThrow('已提交');
    const cancelled = h.options().onElicitation!(request, { requestId: 'pending-dispose', signal: signal.signal });
    await h.adapter.dispose('s');
    expect(await cancelled).toEqual({ action: 'cancel' });
  } finally { await h.adapter.dispose('s'); }
});

it('cancels an unregistered opaque SDK dialog without hanging or declaring a renderer', async () => {
  const h = harness();
  try {
    await h.adapter.create({ sessionId: 's', cwd: '/tmp', providerId: null });
    expect(h.options().supportedDialogKinds).toBeUndefined();
    expect(await h.options().onUserDialog!({ dialogKind: 'future-native-dialog', payload: {} }, { requestId: 'dialog', signal: new AbortController().signal })).toEqual({ behavior: 'cancelled' });
  } finally { await h.adapter.dispose('s'); }
});

it('creates task identities only from successful native output and preserves stopped versus completed runs', () => {
  const state = new ClaudeNativeState();
  expect(state.toolResult('TaskCreate', { subject: 'wrong proposed text' }, { task: { id: 'native-42', subject: 'native corrected text' } }, true)).toBe(false);
  expect(state.plans.size).toBe(0);
  state.toolResult('TaskCreate', {}, { task: { id: 'native-42', subject: 'native corrected text' } }, false);
  state.toolResult('TaskUpdate', { taskId: 'native-42', status: 'completed' }, { success: false, taskId: 'native-42' }, false);
  expect(state.plans.get('native-42')).toMatchObject({ text: 'native corrected text', status: 'pending' });
  state.system({ type: 'system', subtype: 'task_started', task_id: 'task', run_id: '002', parent_task_id: 'parent', is_backgrounded: true, description: 'native' } as unknown as Extract<SDKMessage, { type: 'system' }>);
  expect(state.system({ type: 'system', subtype: 'task_notification', task_id: 'task', run_id: '001', status: 'completed', summary: 'late' } as unknown as Extract<SDKMessage, { type: 'system' }>)).toBe(false);
  state.system({ type: 'system', subtype: 'task_notification', task_id: 'task', run_id: '002', status: 'stopped', summary: 'user stopped' } as unknown as Extract<SDKMessage, { type: 'system' }>);
  expect(state.tasks.get('task')).toMatchObject({ status: 'stopped', runId: '002', parentTaskId: 'parent' });
});

it('the production listener updates real TaskCreate output and does not sum cumulative usage into turn cost', async () => {
  const h = harness();
  try {
    await h.adapter.create({ sessionId: 's', cwd: '/tmp', providerId: null });
    h.push({ type: 'assistant', uuid: 'assistant', parent_tool_use_id: null, session_id: 'native', message: { id: 'm', content: [{ type: 'tool_use', id: 'tool', name: 'TaskCreate', input: { subject: 'proposal' } }] } });
    await vi.waitFor(() => expect(h.adapter.nativeState('s').planTasks).toEqual([]));
    h.push({ type: 'user', parent_tool_use_id: null, session_id: 'native', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'created' }] }, tool_use_result: { task: { id: 'native-id', subject: 'saved title' } } });
    await vi.waitFor(() => expect(h.adapter.nativeState('s').planTasks[0]).toMatchObject({ id: 'native-id', text: 'saved title' }));
    h.push({ type: 'result', session_id: 'native', is_error: false, total_cost_usd: 3, modelUsage: { native: { inputTokens: 100 } }, usage: { input_tokens: 10 }, structured_output: { ok: true } });
    await vi.waitFor(() => expect(h.adapter.nativeState('s').structuredOutput).toEqual({ ok: true }));
    expect(h.adapter.nativeState('s').usage).toMatchObject({ scope: 'session', totalCostUsd: 3 });
  } finally { await h.adapter.dispose('s'); }
});
