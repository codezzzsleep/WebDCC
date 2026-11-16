import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createTestApp } from './helpers.js';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mock.query }));
import { ClaudeAdapter } from '../../adapters/claude/src/adapter.js';

it('HTTP keeps the recovered SDK query/owner/tasks/approval and persists the old configuration receipt as uncertain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-claude-query-handoff-'));
  const path = join(directory, 'state.sqlite');
  const ctx = await createTestApp({}, undefined, {}, { dbPath: path });
  const second = openDb(path);
  const queries: { options: Options; close: ReturnType<typeof vi.fn>; push: (message: unknown) => void }[] = [];
  let reject!: (error: Error) => void; const initialization = new Promise<void>((_yes, no) => { reject = no; });
  let response: ReturnType<typeof ctx.app.inject> | undefined;
  let permission: Promise<unknown> | undefined; let permissionDone = false; let closed = false;
  const nativeId = '5c4a2ff2-364c-4e16-b4b2-50692640ddad';
  mock.query.mockImplementation(({ options }: { options: Options }) => {
    const index = queries.length; let ended = false; let wake: (() => void) | undefined;
    const messages = [{ type: 'system', subtype: 'init', session_id: nativeId, model: options.model,
      permissionMode: options.permissionMode ?? 'default', slash_commands: [], capabilities: [] }] as unknown as SDKMessage[];
    const close = vi.fn(() => { ended = true; wake?.(); });
    queries.push({ options, close, push(message) { messages.push(message as SDKMessage); wake?.(); } });
    return {
      async *[Symbol.asyncIterator]() { while (!ended || messages.length > 0) {
        const message = messages.shift(); if (message !== undefined) yield message;
        else await new Promise<void>(resolve => { wake = resolve; });
      } }, close,
      initializationResult: async () => { if (index === 1) await initialization; return { claude_code_version: '2.1.322' }; },
      supportedModels: async () => ['old-model', 'requested-model'].map(value => ({ value, displayName: value, description: 'controlled SDK catalog' })),
      supportedCommands: async () => [], supportedAgents: async () => [], accountInfo: async () => ({}), mcpServerStatus: async () => [],
    } as unknown as Query;
  });
  const adapter = new ClaudeAdapter();
  vi.spyOn(adapter.nativeHistory, 'info').mockRejectedValue(new Error('controlled history unavailable'));
  ctx.manager.registerAdapter(adapter);
  try {
    const workspace = ctx.store.createWorkspace('Claude query handoff', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code', model: 'old-model', accessMode: 'plan' });
    await vi.waitFor(() => expect(ctx.store.getSession(session.id)?.nativeId).toBe(nativeId));
    const initial = await ctx.manager.nativeControls(session.id);
    const commandId = 'claude-old-query-configuration';
    response = ctx.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/native/actions`, headers: { cookie: ctx.cookie },
      payload: { commandId, revision: initial.revision, action: { type: 'model', model: 'requested-model' } } });
    await vi.waitFor(() => expect(queries).toHaveLength(2));
    await ctx.manager.dispose(session.id); await ctx.manager.slashCommands(session.id);
    await vi.waitFor(() => expect(queries).toHaveLength(3));
    const current = ctx.manager.getRuntime(session.id)!; const sdk = queries[2]!;
    sdk.push({ type: 'system', subtype: 'background_tasks_changed', session_id: nativeId, tasks: [
      { task_id: 'current-one', run_id: 'one', task_type: 'local_agent', description: 'current one' },
      { task_id: 'current-two', run_id: 'two', task_type: 'local_agent', description: 'current two' },
    ] });
    await vi.waitFor(() => expect(adapter.nativeState(session.id).tasks).toHaveLength(2));
    permission = sdk.options.canUseTool!('Bash', { command: 'pwd' }, { signal: new AbortController().signal, toolUseID: 'current-tool', requestId: 'current-approval' }).then(value => { permissionDone = true; return value; });
    await vi.waitFor(() => expect(ctx.store.allEvents(session.id).some(event => event.kind === 'approval.request')).toBe(true));
    const owner = ctx.store.nativeOwners.get(session.id)!; const events = ctx.store.allEvents(session.id);
    const savedSession = ctx.store.getSession(session.id);
    reject(new Error('original SDK model initialization failed')); const failed = await response;
    expect(failed.statusCode).toBe(409); expect(failed.json().error).toContain('original SDK model initialization failed');
    expect(sdk.close).not.toHaveBeenCalled(); expect(queries).toHaveLength(3); expect(permissionDone).toBe(false);
    expect(ctx.manager.getRuntime(session.id)).toBe(current);
    expect(ctx.store.nativeOwners.get(session.id)).toMatchObject({ ownerId: owner.ownerId, generation: owner.generation, state: owner.state });
    expect(ctx.store.allEvents(session.id)).toEqual(events); expect(ctx.store.getSession(session.id)).toEqual(savedSession);
    expect(adapter.nativeState(session.id).tasks).toHaveLength(2);
    const receipt = ctx.store.nativeActions.get(commandId, session.id);
    expect(receipt).toMatchObject({ state: 'uncertain' });
    expect(new Store(second).nativeActions.get(commandId, session.id)).toEqual(receipt);
    const beforeCount = queries.length;
    const retried = await ctx.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/native/actions`, headers: { cookie: ctx.cookie },
      payload: { commandId, revision: initial.revision, action: { type: 'model', model: 'requested-model' } } });
    expect(retried.json().receipt.state).toBe('uncertain'); expect(queries).toHaveLength(beforeCount);
    await ctx.close(); closed = true;
    const reopened = openDb(path);
    try { expect(new Store(reopened).nativeActions.get(commandId, session.id)).toEqual(receipt); }
    finally { reopened.close(); }
    console.log(JSON.stringify({ proof: 'Claude query handoff source HTTP/SQLite', originalGeneration: initial.runtime.generation,
      currentGeneration: owner.generation, currentTasks: 2, currentApprovalPreserved: true, currentQueryClosedByOldFailure: false,
      oldReceipt: 'uncertain', secondConnection: true, databaseReopen: true, noReplayOnRetry: true,
      actualSDKExecution: false, actualProvider: false }));
  } finally {
    reject(new Error('test cleanup')); await response; for (const query of queries) query.close();
    if (!closed) await ctx.close(); await permission; second.close(); mock.query.mockReset(); await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('HTTP keeps a disposed manager closed while its old configuration query finishes exiting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-claude-query-close-'));
  const path = join(directory, 'state.sqlite');
  const ctx = await createTestApp({}, undefined, {}, { dbPath: path });
  const second = openDb(path);
  const queries: { close: ReturnType<typeof vi.fn> }[] = [];
  let finishExit!: () => void; const exit = new Promise<void>(resolve => { finishExit = resolve; });
  let response: ReturnType<typeof ctx.app.inject> | undefined; let closed = false; let sessionId: string | undefined;
  const nativeId = '73c32b55-21a3-4d5f-bef0-dafc55b58872';
  mock.query.mockImplementation(({ options }: { options: Options }) => {
    const index = queries.length; let ended = false; let wake: (() => void) | undefined;
    const messages = [{ type: 'system', subtype: 'init', session_id: nativeId, model: options.model,
      permissionMode: options.permissionMode ?? 'default', slash_commands: [], capabilities: [] }] as unknown as SDKMessage[];
    const close = vi.fn(() => { ended = true; wake?.(); }); queries.push({ close });
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended || messages.length > 0) {
          const message = messages.shift(); if (message !== undefined) yield message;
          else await new Promise<void>(resolve => { wake = resolve; });
        }
        if (index === 0) await exit;
      }, close,
      initializationResult: async () => ({ claude_code_version: '2.1.322' }),
      supportedModels: async () => ['old-model', 'requested-model'].map(value => ({ value, displayName: value, description: 'controlled SDK catalog' })),
      supportedCommands: async () => [], supportedAgents: async () => [], accountInfo: async () => ({}), mcpServerStatus: async () => [],
    } as unknown as Query;
  });
  const adapter = new ClaudeAdapter();
  vi.spyOn(adapter.nativeHistory, 'info').mockRejectedValue(new Error('controlled history unavailable'));
  ctx.manager.registerAdapter(adapter);
  try {
    const workspace = ctx.store.createWorkspace('Claude explicit close handoff', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code', model: 'old-model', accessMode: 'plan' });
    sessionId = session.id;
    await vi.waitFor(() => expect(ctx.store.getSession(session.id)?.nativeId).toBe(nativeId));
    const initial = await ctx.manager.nativeControls(session.id); const commandId = 'claude-close-old-configuration';
    const request = { method: 'POST' as const, url: `/api/sessions/${session.id}/native/actions`, headers: { cookie: ctx.cookie },
      payload: { commandId, revision: initial.revision, action: { type: 'model', model: 'requested-model' } } };
    response = ctx.app.inject(request);
    await vi.waitFor(() => { expect(queries[0]!.close).toHaveBeenCalledOnce(); expect(adapter.debugProcesses()).toEqual([]); });
    await ctx.manager.dispose(session.id);
    const owner = ctx.store.nativeOwners.get(session.id); finishExit();
    const failed = await response;
    expect(failed.statusCode).toBe(409); expect(queries).toHaveLength(1);
    expect(adapter.debugProcesses()).toEqual([]); expect(ctx.manager.getRuntime(session.id)).toBeUndefined();
    expect(ctx.store.nativeOwners.get(session.id)).toEqual(owner);
    expect(ctx.store.getSession(session.id)?.model).toBe('old-model');
    const receipt = ctx.store.nativeActions.get(commandId, session.id);
    expect(receipt).toMatchObject({ state: 'uncertain' });
    expect(new Store(second).nativeActions.get(commandId, session.id)).toEqual(receipt);
    const retried = await ctx.app.inject(request);
    expect(retried.json().receipt.state).toBe('uncertain'); expect(queries).toHaveLength(1);
    await ctx.close(); closed = true;
    const reopened = openDb(path);
    try { expect(new Store(reopened).nativeActions.get(commandId, session.id)).toEqual(receipt); }
    finally { reopened.close(); }
    console.info(JSON.stringify({ proof: 'explicit close during query exit through source HTTP/Manager/SQLite',
      queryCount: queries.length, orphanWriterCount: adapter.debugProcesses().length, receipt: 'uncertain',
      duplicateRequestReplayed: false, secondConnection: true, databaseReopen: true, actualNativeOrProvider: false }));
  } finally {
    finishExit(); await response; for (const query of queries) query.close();
    if (sessionId !== undefined) await adapter.dispose(sessionId);
    if (!closed) await ctx.close(); second.close(); mock.query.mockReset();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
