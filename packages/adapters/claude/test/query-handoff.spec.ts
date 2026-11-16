import { afterEach, expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterEvent } from '@webdcc/protocol';

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocked.query }));
import { ClaudeAdapter } from '../src/adapter.js';

function deferred() {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function controlledQuery() {
  let ended = false; let wake: (() => void) | undefined; let exit = Promise.resolve();
  const messages: SDKMessage[] = [];
  return {
    async *[Symbol.asyncIterator]() {
      while (!ended || messages.length > 0) {
        const message = messages.shift(); if (message !== undefined) yield message;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
      await exit;
    },
    close: vi.fn(() => { ended = true; wake?.(); }),
    initializationResult: vi.fn(async () => ({ claude_code_version: '2.1.322' })),
    push(value: unknown) { messages.push(value as SDKMessage); wake?.(); },
    holdExit(promise: Promise<void>) { exit = promise; },
  };
}
function harness() {
  const queries: { q: ReturnType<typeof controlledQuery>; options: Options }[] = [];
  const adapter = new ClaudeAdapter(); const events: AdapterEvent[] = [];
  adapter.onEvent((_id, event) => events.push(event));
  mocked.query.mockImplementation(({ options }: { options: Options }) => {
    const q = controlledQuery(); queries.push({ q, options }); return q as unknown as Query;
  });
  return { adapter, queries, events };
}
afterEach(() => mocked.query.mockReset());
const oldOptions = { sessionId: 's', cwd: '/tmp', providerId: null, model: 'old-model', accessMode: 'plan' };
const newOptions = { ...oldOptions, model: 'current-model', accessMode: 'default' };
const taskSnapshot = { type: 'system', subtype: 'background_tasks_changed', session_id: 'native-current', tasks: [
  { task_id: 'one', run_id: 'current-one', task_type: 'local_agent', description: 'Current task one' },
  { task_id: 'two', run_id: 'current-two', task_type: 'local_agent', description: 'Current task two' },
] };

it('an old model initialization failure cannot close the recovered query, discard its tasks or cancel its approval', async () => {
  const h = harness(); const initialize = deferred(); let changing: Promise<unknown> | undefined;
  let permission: Promise<unknown> | undefined; let permissionDone = false;
  try {
    await h.adapter.create(oldOptions);
    const original = mocked.query.getMockImplementation()!;
    mocked.query.mockImplementation((input: { options: Options }) => {
      const result = original(input);
      if (h.queries.length === 2) h.queries[1]!.q.initializationResult.mockImplementation(async () => { await initialize.promise; return { claude_code_version: '2.1.322' }; });
      return result;
    });
    changing = h.adapter.setModel('s', 'requested-model').then(() => ({ success: true }), error => error);
    await vi.waitFor(() => expect(h.queries).toHaveLength(2));
    await h.adapter.dispose('s'); await h.adapter.create(newOptions);
    const current = h.queries[2]!; current.q.push(taskSnapshot);
    await vi.waitFor(() => expect(h.adapter.nativeState('s').tasks).toHaveLength(2));
    permission = current.options.canUseTool!('Bash', { command: 'pwd' }, { signal: new AbortController().signal, toolUseID: 'current-tool', requestId: 'current-permission' }).then(value => { permissionDone = true; return value; });
    initialize.reject(new Error('original model initialization failed'));
    const failure = await changing;
    console.info(JSON.stringify({ proof: 'controlled Claude initialization handoff', currentCloseCalls: current.q.close.mock.calls.length,
      queryCount: h.queries.length, currentTaskCount: h.adapter.nativeState('s').tasks.length, permissionDone }));
    expect(current.q.close).not.toHaveBeenCalled();
    expect(failure).toMatchObject({ code: 'uncertain' });
    expect(String(failure)).toContain('original model initialization failed');
    expect(h.adapter.nativeState('s').tasks.map(task => task.taskId)).toEqual(['one', 'two']);
    expect(permissionDone).toBe(false);
    expect(h.queries).toHaveLength(3);
    expect(h.events.filter(event => event.type === 'item.complete' && event.kind === 'approval.request')).toHaveLength(1);
  } finally {
    initialize.reject(new Error('test cleanup')); await changing;
    for (const { q } of h.queries) q.close(); await h.adapter.dispose('s'); await permission;
  }
});

it('an old rollback failure cannot close the query that took over during rollback initialization', async () => {
  const h = harness(); const rollback = deferred(); let changing: Promise<unknown> | undefined;
  try {
    await h.adapter.create(oldOptions);
    const original = mocked.query.getMockImplementation()!;
    mocked.query.mockImplementation((input: { options: Options }) => {
      const result = original(input);
      if (h.queries.length === 2) h.queries[1]!.q.initializationResult.mockRejectedValue(new Error('requested model failed'));
      if (h.queries.length === 3) h.queries[2]!.q.initializationResult.mockImplementation(async () => { await rollback.promise; return { claude_code_version: '2.1.322' }; });
      return result;
    });
    changing = h.adapter.setModel('s', 'requested-model').then(() => ({ success: true }), error => error);
    await vi.waitFor(() => expect(h.queries).toHaveLength(3));
    await h.adapter.dispose('s'); await h.adapter.create(newOptions);
    const current = h.queries[3]!; current.q.push(taskSnapshot);
    await vi.waitFor(() => expect(h.adapter.nativeState('s').tasks).toHaveLength(2));
    rollback.reject(new Error('original rollback initialization failed'));
    const failure = await changing;
    console.info(JSON.stringify({ proof: 'controlled Claude rollback handoff', currentCloseCalls: current.q.close.mock.calls.length,
      queryCount: h.queries.length }));
    expect(current.q.close).not.toHaveBeenCalled();
    expect(failure).toMatchObject({ code: 'uncertain' });
    expect(String(failure)).toContain('requested model failed');
    expect(String(failure)).toContain('original rollback initialization failed');
    expect(h.adapter.nativeState('s').tasks).toHaveLength(2);
    expect(h.queries).toHaveLength(4);
  } finally { rollback.reject(new Error('test cleanup')); await changing; for (const { q } of h.queries) q.close(); await h.adapter.dispose('s'); }
});

it('a query created while the retired pump is exiting cannot be overwritten by an older pending change', async () => {
  const h = harness(); const exit = deferred(); let changing: Promise<unknown> | undefined;
  try {
    await h.adapter.create(oldOptions); h.queries[0]!.q.holdExit(exit.promise);
    changing = h.adapter.setModel('s', 'requested-model').then(() => ({ success: true }), error => error);
    await vi.waitFor(() => { expect(h.queries[0]!.q.close).toHaveBeenCalledOnce(); expect(h.adapter.debugProcesses()).toHaveLength(0); });
    await h.adapter.create(newOptions);
    const current = h.queries[1]!; current.q.push(taskSnapshot);
    await vi.waitFor(() => expect(h.adapter.nativeState('s').tasks).toHaveLength(2));
    exit.resolve(); const failure = await changing;
    console.info(JSON.stringify({ proof: 'controlled Claude retired pump handoff', queryCount: h.queries.length,
      currentCloseCalls: current.q.close.mock.calls.length, currentTaskCount: h.adapter.nativeState('s').tasks.length }));
    expect(h.queries).toHaveLength(2);
    expect(failure).toMatchObject({ code: 'uncertain' });
    expect(h.queries).toHaveLength(2); expect(current.q.close).not.toHaveBeenCalled();
    expect(h.adapter.nativeState('s').tasks).toHaveLength(2);
    expect(h.events.filter(event => event.type === 'permissions' && event.observation.source === 'query:replacing')).toHaveLength(0);
  } finally { exit.resolve(); await changing; for (const { q } of h.queries) q.close(); await h.adapter.dispose('s'); }
});

it('an explicitly closed replacement stays closed when its old initialization later rejects', async () => {
  const h = harness(); const initialize = deferred(); let changing: Promise<unknown> | undefined;
  try {
    await h.adapter.create(oldOptions);
    const original = mocked.query.getMockImplementation()!;
    mocked.query.mockImplementation((input: { options: Options }) => {
      const result = original(input);
      if (h.queries.length === 2) h.queries[1]!.q.initializationResult.mockImplementation(async () => { await initialize.promise; return { claude_code_version: '2.1.322' }; });
      return result;
    });
    changing = h.adapter.setModel('s', 'requested-model').then(() => ({ success: true }), error => error);
    await vi.waitFor(() => expect(h.queries).toHaveLength(2));
    await h.adapter.dispose('s'); initialize.reject(new Error('initialization rejected after explicit close'));
    expect(await changing).toMatchObject({ code: 'uncertain' });
    expect(h.queries).toHaveLength(2); expect(h.adapter.debugProcesses()).toEqual([]);
  } finally { initialize.reject(new Error('test cleanup')); await changing; for (const { q } of h.queries) q.close(); await h.adapter.dispose('s'); }
});

it('an explicit close while the original query pump is exiting prevents the pending replacement', async () => {
  const h = harness(); const exit = deferred(); let changing: Promise<unknown> | undefined;
  try {
    await h.adapter.create(oldOptions); h.queries[0]!.q.holdExit(exit.promise);
    changing = h.adapter.setModel('s', 'requested-model').then(() => ({ success: true }), error => error);
    await vi.waitFor(() => { expect(h.queries[0]!.q.close).toHaveBeenCalledOnce(); expect(h.adapter.debugProcesses()).toEqual([]); });
    await h.adapter.dispose('s');
    exit.resolve(); const outcome = await changing;
    console.info(JSON.stringify({ proof: 'independent explicit close during original pump exit', queryCount: h.queries.length,
      outcome: String(outcome), processes: h.adapter.debugProcesses().length, actualNativeOrProvider: false }));
    expect(outcome).toMatchObject({ code: 'uncertain' });
    expect(h.queries).toHaveLength(1); expect(h.adapter.debugProcesses()).toEqual([]);
  } finally { exit.resolve(); await changing; for (const { q } of h.queries) q.close(); await h.adapter.dispose('s'); }
});

it('an explicit close while the failed replacement pump is exiting prevents rollback', async () => {
  const h = harness(); const exit = deferred(); let changing: Promise<unknown> | undefined;
  try {
    await h.adapter.create(oldOptions);
    const original = mocked.query.getMockImplementation()!;
    mocked.query.mockImplementation((input: { options: Options }) => {
      const result = original(input);
      if (h.queries.length === 2) {
        h.queries[1]!.q.holdExit(exit.promise);
        h.queries[1]!.q.initializationResult.mockRejectedValue(new Error('requested initialization failed before close'));
      }
      return result;
    });
    changing = h.adapter.setModel('s', 'requested-model').then(() => ({ success: true }), error => error);
    await vi.waitFor(() => { expect(h.queries).toHaveLength(2); expect(h.queries[1]!.q.close).toHaveBeenCalledOnce(); expect(h.adapter.debugProcesses()).toEqual([]); });
    await h.adapter.dispose('s');
    exit.resolve(); const outcome = await changing;
    console.info(JSON.stringify({ proof: 'independent explicit close during failed replacement cleanup', queryCount: h.queries.length,
      outcome: String(outcome), processes: h.adapter.debugProcesses().length, actualNativeOrProvider: false }));
    expect(outcome).toMatchObject({ code: 'uncertain' });
    expect(String(outcome)).toContain('requested initialization failed before close');
    expect(h.queries).toHaveLength(2); expect(h.adapter.debugProcesses()).toEqual([]);
  } finally { exit.resolve(); await changing; for (const { q } of h.queries) q.close(); await h.adapter.dispose('s'); }
});
