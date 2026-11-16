import { expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterEvent, CreateOpts } from '@webdcc/protocol';
const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mock.query }));
import { ClaudeAdapter } from '../src/adapter.js';
import { createTestApp } from '../../../server/test/helpers.js';

function controller(initial: (Record<string, unknown> | Error | 'end')[] = []) {
  const steps = [...initial]; let wake: (() => void) | undefined; let ended = false;
  const q = { async *[Symbol.asyncIterator]() {
    try {
      for (;;) {
        const step = steps.shift();
        if (step === 'end') return;
        if (step instanceof Error) throw step;
        if (step !== undefined) yield step as unknown as SDKMessage;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    } finally { ended = true; }
  }, close: vi.fn(() => { steps.push('end'); wake?.(); }), initializationResult: async () => ({}),
    push(step: Record<string, unknown> | Error | 'end') { steps.push(step); wake?.(); }, ended: () => ended };
  return q;
}

it.each(['error', 'empty', 'record-rejected'])('an idle SDK %s exit closes the query/input and removes the failed runtime before a retry', async mode => {
  const q = controller(mode === 'error' ? [new Error('Before initialization')] : mode === 'empty' ? ['end'] : [{ type: 'system', subtype: 'init', session_id: 'native', slash_commands: [] }]);
  let prompt!: AsyncIterable<SDKUserMessage>;
  mock.query.mockImplementation((args: { prompt: AsyncIterable<SDKUserMessage> }) => { prompt = args.prompt; return q as unknown as Query; });
  const adapter = new ClaudeAdapter(); const events: AdapterEvent[] = []; adapter.onEvent((_id, event) => events.push(event));
  const opts: CreateOpts = { sessionId: 'local', cwd: '.', providerId: null,
    ...(mode === 'record-rejected' ? { nativeEvents: { record: () => ({ envelopeId: 1, accepted: false }) } } : {}) };
  try {
    await adapter.create(opts); await vi.waitFor(() => expect(q.ended()).toBe(true));
    const iterator = prompt[Symbol.asyncIterator](); let inputDone = false;
    const pending = iterator.next().then(result => { inputDone = result.done === true; return result; });
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    console.info(JSON.stringify({ proof: 'controlled-SDK-production-adapter-query-cleanup', baseline: '60a3d1', mode,
      queryCloseCalls: q.close.mock.calls.length, trackedRuntimeEntries: adapter.debugProcesses().length, inputDone,
      transportNotifications: events.filter(event => event.type === 'transport.closed').length, nativeProcessCount: 'not-measured', realSDKQuery: false }));
    await vi.waitFor(() => expect(q.close).toHaveBeenCalledOnce());
    expect(adapter.debugProcesses()).toEqual([]);
    await vi.waitFor(() => expect(inputDone).toBe(true)); expect((await pending).done).toBe(true);
    expect(events.filter(event => event.type === 'transport.closed')).toHaveLength(1);
    const replacement = controller(); mock.query.mockReturnValue(replacement as unknown as Query);
    await adapter.create({ sessionId: 'local', cwd: '.', providerId: null });
    expect(mock.query).toHaveBeenCalledTimes(2); expect(replacement.close).not.toHaveBeenCalled();
    await adapter.dispose('local'); expect(replacement.close).toHaveBeenCalledOnce();
  } finally { await adapter.dispose('local'); mock.query.mockReset(); }
});

it('a failed active query denies pending approval, preserves active-work uncertainty and closes once', async () => {
  const q = controller(); let options!: Options;
  mock.query.mockImplementation((args: { options: Options }) => { options = args.options; return q as unknown as Query; });
  const adapter = new ClaudeAdapter(); const events: AdapterEvent[] = []; adapter.onEvent((_id, event) => events.push(event));
  try {
    await adapter.create({ sessionId: 'local', cwd: '.', providerId: null }); await adapter.send('local', { text: 'original input' });
    const pending = options.canUseTool!('Bash', { command: 'pwd' }, { signal: new AbortController().signal, toolUseID: 'tool', requestId: 'request' });
    q.push(new Error('Active SDK failure'));
    await vi.waitFor(() => expect(q.ended()).toBe(true));
    expect(await pending).toMatchObject({ behavior: 'deny' });
    await vi.waitFor(() => expect(q.close).toHaveBeenCalledOnce());
    expect(events.filter(event => event.type === 'transport.closed')).toEqual([expect.objectContaining({ activeWork: true })]);
    expect(events.filter(event => event.type === 'item.complete' && event.kind === 'error')).toHaveLength(1);
    expect(events.some(event => event.type === 'turn.end' && event.status === 'failed')).toBe(false);
    await adapter.dispose('local'); expect(q.close).toHaveBeenCalledOnce();
  } finally { await adapter.dispose('local'); mock.query.mockReset(); }
});

it('resuming a native session fails when the SDK exits before readiness, rather than reporting success after timeout', async () => {
  const q = controller([new Error('Resume initialization failed')]); mock.query.mockReturnValue(q as unknown as Query);
  const adapter = new ClaudeAdapter();
  try {
    await expect(adapter.resume({ sessionId: 'local', cwd: '.', providerId: null, nativeId: 'saved-native' })).rejects.toMatchObject({ statusCode: 503 });
    expect(q.close).toHaveBeenCalledOnce(); expect(adapter.debugProcesses()).toEqual([]);
  } finally { await adapter.dispose('local'); mock.query.mockReset(); }
});

it('the actual manager releases an idle exited query and creates a new SDK consumer for the next original input', async () => {
  const ctx = await createTestApp(); const queries: ReturnType<typeof controller>[] = []; const inputs: AsyncIterable<SDKUserMessage>[] = [];
  mock.query.mockImplementation((args: { prompt: AsyncIterable<SDKUserMessage> }) => {
    const q = controller([{ type: 'system', subtype: 'init', session_id: 'native', permissionMode: 'default', slash_commands: [] }]);
    queries.push(q); inputs.push(args.prompt); return q as unknown as Query;
  });
  try {
    const adapter = new ClaudeAdapter(); ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('query recovery', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code', accessMode: 'default' });
    await vi.waitFor(() => expect(ctx.store.getSession(session.id)?.nativeId).toBe('native'));
    queries[0]!.push('end');
    await vi.waitFor(() => expect(ctx.manager.getRuntime(session.id)).toBeUndefined());
    expect(queries[0]!.close).toHaveBeenCalledOnce(); expect(ctx.store.nativeOwners.get(session.id)?.state).toBe('released');
    await ctx.manager.send(session.id, { text: '  exact\n原文  ' }, 'SDK-RECOVERY-INPUT');
    expect(queries).toHaveLength(2);
    const offered = await inputs[1]![Symbol.asyncIterator]().next();
    expect(offered.value).toMatchObject({ type: 'user', message: { content: '  exact\n原文  ' } });
    expect(offered.value?.uuid).toMatch(/^[0-9a-f-]{36}$/);
    queries[1]!.push({ type: 'result', subtype: 'success', session_id: 'native', is_error: false, result: 'controlled result' });
    // The manager intentionally retains the turn for its 1.5s final-frame window.
    await vi.waitFor(() => expect(ctx.store.getSession(session.id)?.status).toBe('idle'), { timeout: 5_000 });
  } finally { await ctx.close(); mock.query.mockReset(); }
});

it('an unsuccessful explicit close retains a fenced runtime until the same query is successfully closed', async () => {
  const q = controller(); mock.query.mockReturnValue(q as unknown as Query);
  const adapter = new ClaudeAdapter();
  try {
    await adapter.create({ sessionId: 'local', cwd: '.', providerId: null });
    q.close.mockImplementationOnce(() => { throw new Error('Close unconfirmed'); });
    await expect(adapter.dispose('local')).rejects.toThrow('Close unconfirmed');
    expect(adapter.debugProcesses()).toHaveLength(1);
    await expect(adapter.create({ sessionId: 'local', cwd: '.', providerId: null })).rejects.toMatchObject({ statusCode: 409 });
    await expect(adapter.send('local', { text: 'cannot enter an unclosed query' })).rejects.toMatchObject({ statusCode: 503 });
    await adapter.dispose('local');
    expect(q.close).toHaveBeenCalledTimes(2); expect(mock.query).toHaveBeenCalledOnce(); expect(adapter.debugProcesses()).toEqual([]);
  } finally { q.close(); await adapter.dispose('local').catch(() => undefined); mock.query.mockReset(); }
});

it('a closing query rejects late SDK approval and new writer creation before its close completes', async () => {
  const q = controller(); let options!: Options; let release: (() => void) | undefined; let disposal: Promise<void> | undefined;
  mock.query.mockImplementation((args: { options: Options }) => { options = args.options; return q as unknown as Query; });
  q.close.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); q.push('end'); });
  const adapter = new ClaudeAdapter(); const events: AdapterEvent[] = []; adapter.onEvent((_id, event) => events.push(event));
  try {
    await adapter.create({ sessionId: 'local', cwd: '.', providerId: null }); disposal = adapter.dispose('local');
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(adapter.create({ sessionId: 'local', cwd: '.', providerId: null })).rejects.toMatchObject({ statusCode: 409 });
    await expect(options.canUseTool!('Bash', { command: 'pwd' }, { signal: new AbortController().signal, toolUseID: 'late', requestId: 'late-request' })).resolves.toMatchObject({ behavior: 'deny' });
    expect(events.some(event => event.type === 'item.complete' && event.kind === 'approval.request')).toBe(false);
    release?.(); await disposal;
    expect(q.close).toHaveBeenCalledOnce(); expect(adapter.debugProcesses()).toEqual([]);
  } finally { release?.(); await disposal; await adapter.dispose('local'); mock.query.mockReset(); }
});
