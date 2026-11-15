import { afterEach, expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterEvent } from '@webdcc/protocol';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }));
import { ClaudeAdapter } from '../src/adapter.js';

function fakeQuery(onClose?: () => void) {
  const messages: SDKMessage[] = [];
  let done = false;
  let wake: (() => void) | undefined;
  const q = {
    async *[Symbol.asyncIterator]() {
      while (!done || messages.length > 0) {
        const next = messages.shift();
        if (next !== undefined) yield next;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    },
    close: vi.fn(() => { onClose?.(); done = true; wake?.(); }),
    setPermissionMode: vi.fn(async () => undefined),
    applyFlagSettings: vi.fn(async () => undefined),
    initializationResult: vi.fn(async () => ({})),
    push(message: Record<string, unknown>) { messages.push(message as unknown as SDKMessage); wake?.(); },
  };
  return q;
}
afterEach(() => mocks.query.mockReset());

it('NP-04/07 closes the old query before model replacement and preserves confirmed permission and effort settings', async () => {
  const calls: string[] = [];
  const queries: ReturnType<typeof fakeQuery>[] = [];
  const selected: { model?: string; permissionMode?: string; effort?: string; resume?: string }[] = [];
  mocks.query.mockImplementation(({ options }: { options: Options }) => {
    const id = queries.length;
    const q = fakeQuery(() => calls.push(`close:${id}`));
    queries.push(q);
    selected.push({ model: options.model, permissionMode: options.permissionMode, effort: options.effort, resume: options.resume });
    calls.push(`query:${id}`);
    return q as unknown as Query;
  });
  const adapter = new ClaudeAdapter({ model: 'constructor-default' });
  const events: AdapterEvent[] = [];
  adapter.onEvent((_id, event) => events.push(event));
  try {
    await adapter.create({ sessionId: 'local', cwd: '.', providerId: null, accessMode: 'acceptEdits', model: 'initial' });
    queries[0]?.push({ type: 'system', subtype: 'init', session_id: 'native', permissionMode: 'acceptEdits', slash_commands: [] });
    await vi.waitFor(() => expect(events.some(event => event.type === 'native-id')).toBe(true));
    await adapter.setAccessMode('local', 'plan');
    await adapter.setReasoningEffort('local', 'high');
    // A frame queued just before close still arrives from the retired query.
    const old = queries[0]!;
    const close = old.close.getMockImplementation()!;
    old.close.mockImplementation(() => { old.push({ type: 'system', subtype: 'late', session_id: 'native' }); close(); });
    await adapter.setModel('local', 'replacement');
    expect(calls.slice(0, 3)).toEqual(['query:0', 'close:0', 'query:1']);
    expect(selected[0]?.model).toBe('initial');
    expect(selected[1]).toEqual({ model: 'replacement', permissionMode: 'plan', effort: 'high', resume: 'native' });
    expect(events.some(event => event.type === 'item.complete' && event.kind === 'unknown' && (event.data as { nativeType?: string }).nativeType === 'system/late')).toBe(false);
  } finally { for (const q of queries) q.close(); await adapter.dispose('local'); }
});

it('NP-04/07 refuses replacement during an active turn and omits overrides when returning to native permission', async () => {
  const queries: ReturnType<typeof fakeQuery>[] = [];
  const modes: (string | undefined)[] = [];
  mocks.query.mockImplementation(({ options }: { options: Options }) => { const q = fakeQuery(); queries.push(q); modes.push(options.permissionMode); return q as unknown as Query; });
  const adapter = new ClaudeAdapter();
  const events: AdapterEvent[] = [];
  adapter.onEvent((_id, event) => events.push(event));
  try {
    await adapter.create({ sessionId: 'local', cwd: '.', providerId: null, accessMode: 'plan' });
    queries[0]?.push({ type: 'system', subtype: 'init', session_id: 'native', permissionMode: 'plan', slash_commands: [] });
    await vi.waitFor(() => expect(events.some(event => event.type === 'native-id')).toBe(true));
    await adapter.send('local', { text: 'active' });
    await expect(adapter.setModel('local', 'next')).rejects.toMatchObject({ statusCode: 409 });
    expect(queries).toHaveLength(1);
    queries[0]?.push({ type: 'result', session_id: 'native', is_error: false });
    await vi.waitFor(() => expect(events.some(event => event.type === 'turn.end')).toBe(true));
    await adapter.setAccessMode('local', 'inherit');
    expect(modes).toEqual(['plan', undefined]);
  } finally { await adapter.dispose('local'); }
});

it('NP-04 keeps a live background task owned and ignores an older run notification', async () => {
  const q = fakeQuery();
  mocks.query.mockReturnValue(q as unknown as Query);
  const adapter = new ClaudeAdapter();
  const seen: AdapterEvent[] = [];
  adapter.onEvent((_id, event) => seen.push(event));
  try {
    await adapter.create({ sessionId: 'local', cwd: '.', providerId: null });
    q.push({ type: 'system', subtype: 'task_started', task_id: 'task', run_id: '002', description: 'background', session_id: 'native' });
    q.push({ type: 'system', subtype: 'task_notification', task_id: 'task', run_id: '001', status: 'completed', summary: 'old', session_id: 'native' });
    await vi.waitFor(() => expect(seen.filter(event => event.type === 'item.complete' && event.kind === 'tool.call')).toHaveLength(2));
    await expect(adapter.setModel('local', 'next')).rejects.toMatchObject({ statusCode: 409 });
    expect(q.close).not.toHaveBeenCalled();
  } finally { await adapter.dispose('local'); }
});

it('NP-04 uses complete native background snapshots even when task bookends are missed or arrive later', async () => {
  const queries: ReturnType<typeof fakeQuery>[] = [];
  mocks.query.mockImplementation(() => { const q = fakeQuery(); queries.push(q); return q as unknown as Query; });
  const adapter = new ClaudeAdapter();
  const seen: AdapterEvent[] = [];
  adapter.onEvent((_id, event) => seen.push(event));
  try {
    await adapter.create({ sessionId: 'local', cwd: '.', providerId: null });
    queries[0]!.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task', run_id: '002', task_type: 'shell', description: 'busy' }], session_id: 'native' });
    await vi.waitFor(() => expect(seen.some(event => event.type === 'item.complete' && event.kind === 'internal')).toBe(true));
    await expect(adapter.setModel('local', 'next')).rejects.toMatchObject({ statusCode: 409 });
    queries[0]!.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: 'native' });
    queries[0]!.push({ type: 'system', subtype: 'task_started', task_id: 'task', run_id: '002', description: 'late bookend', session_id: 'native' });
    await vi.waitFor(() => expect(seen.some(event => event.type === 'item.complete' && event.kind === 'tool.call')).toBe(true));
    await adapter.setModel('local', 'next');
    expect(queries).toHaveLength(2);
  } finally { await adapter.dispose('local'); }
});

it('NP-04/07 failed query initialization rolls back the same native session and settings before permitting a retry', async () => {
  const selected: { model?: string; mode?: string; resume?: string }[] = [];
  const queries: ReturnType<typeof fakeQuery>[] = [];
  mocks.query.mockImplementation(({ options }: { options: Options }) => {
    const q = fakeQuery();
    if (queries.length === 1) q.initializationResult.mockRejectedValue(new Error('new model failed'));
    queries.push(q);
    selected.push({ model: options.model, mode: options.permissionMode, resume: options.resume });
    return q as unknown as Query;
  });
  const adapter = new ClaudeAdapter();
  const seen: AdapterEvent[] = [];
  adapter.onEvent((_id, event) => seen.push(event));
  try {
    await adapter.create({ sessionId: 'local', cwd: '.', providerId: null, accessMode: 'plan', model: 'old' });
    queries[0]!.push({ type: 'system', subtype: 'init', session_id: 'native', permissionMode: 'plan', slash_commands: [] });
    await vi.waitFor(() => expect(seen.some(event => event.type === 'native-id')).toBe(true));
    await expect(adapter.setModel('local', 'new')).rejects.toThrow('new model failed');
    expect(queries[0]!.close).toHaveBeenCalledOnce();
    expect(queries[1]!.close).toHaveBeenCalledOnce();
    expect(selected[2]).toEqual({ model: 'old', mode: 'plan', resume: 'native' });
    await adapter.setModel('local', 'retry');
    expect(selected[3]).toEqual({ model: 'retry', mode: 'plan', resume: 'native' });
  } finally { await adapter.dispose('local'); }
});
