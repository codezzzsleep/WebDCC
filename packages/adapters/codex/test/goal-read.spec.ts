import { expect, it } from 'vitest';
import type { AdapterEvent } from '@webdcc/protocol';
import { CodexAdapter } from '../src/adapter.js';
import type { JsonRpcStdio } from '../src/rpc.js';
import type { ThreadGoal } from '../src/schema/v2/ThreadGoal.js';

const thread = { id: 'native', cwd: '/workspace', preview: '', ephemeral: false, modelProvider: 'fixture',
  createdAt: 1, updatedAt: 1, status: { type: 'idle' }, cliVersion: '0.169.0', source: 'appServer',
  projectId: null, sessionId: 'native-session', turns: [] };
const oldGoal: ThreadGoal = { threadId: 'native', objective: 'Old goal', status: 'paused', tokenBudget: 100,
  tokensUsed: 0, timeUsedSeconds: 0, createdAt: 100, updatedAt: 101 };
const newGoal: ThreadGoal = { ...oldGoal, objective: 'New native goal', createdAt: 200, updatedAt: 201 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(value => { resolve = value; });
  return { promise, resolve };
}
type Runtime = { rpc: JsonRpcStdio; nativeId: string };
function fixture(request: (method: string) => Promise<unknown>) {
  const replay = CodexAdapter.replay('session', 'native');
  const sessions = (replay.adapter as unknown as { sessions: Map<string, Runtime> }).sessions;
  const runtime = sessions.get('session')!;
  runtime.rpc = { isClosed: false, request } as unknown as JsonRpcStdio;
  const events: AdapterEvent[] = [];
  replay.adapter.onEvent((_id, event) => events.push(event));
  let index = 0;
  const observe = (goal: ThreadGoal | null) => replay.feed({ i: ++index, t: index, dir: 'in', ch: 'rpc', frame: goal
    ? { method: 'thread/goal/updated', params: { threadId: 'native', turnId: null, goal } }
    : { method: 'thread/goal/cleared', params: { threadId: 'native' } } });
  const restore = () => (replay.adapter as unknown as { restoreHistory(id: string, value: Runtime): Promise<void> }).restoreHistory('session', runtime);
  return { adapter: replay.adapter, observe, restore, events,
    replace: () => sessions.set('session', { ...runtime }),
    disconnect: () => { (runtime.rpc as unknown as { isClosed: boolean }).isClosed = true; } };
}

it.each([newGoal, null])('rereads a goal snapshot when a newer update or clear arrives while thread/read is pending (%j)', async nextGoal => {
  const gate = deferred<{ thread: typeof thread }>();
  const started = deferred<void>();
  let currentGoal: ThreadGoal | null = oldGoal;
  let threadReads = 0; let goalReads = 0;
  const f = fixture(async method => {
    if (method === 'thread/read') { if (++threadReads === 1) { started.resolve(); return gate.promise; } return { thread }; }
    if (method === 'thread/goal/get') { goalReads++; return { goal: currentGoal }; }
    throw new Error('Unexpected method ' + method);
  });
  const pending = f.adapter.nativeState('session');
  await started.promise;
  currentGoal = nextGoal; f.observe(nextGoal); gate.resolve({ thread });
  await expect(pending).resolves.toMatchObject({ goal: nextGoal });
  expect(goalReads).toBe(2);
});

it('reads an unchanged native goal once without a model input', async () => {
  const calls: string[] = [];
  const f = fixture(async method => { calls.push(method); return method === 'thread/read' ? { thread } : { goal: oldGoal }; });
  await expect(f.adapter.nativeState('session')).resolves.toMatchObject({ goal: oldGoal });
  expect(calls).toEqual(['thread/read', 'thread/goal/get']);
});

it('bounds retries when native goal observations keep changing instead of publishing an obsolete snapshot', async () => {
  let reads = 0;
  const f = fixture(async method => {
    if (method === 'thread/read') { reads++; f.observe({ ...newGoal, updatedAt: 201 + reads }); return { thread }; }
    if (method === 'thread/goal/get') return { goal: oldGoal };
    throw new Error('Unexpected method ' + method);
  });
  await expect(f.adapter.nativeState('session')).rejects.toMatchObject({ statusCode: 409, code: 'native-state-changed' });
  expect(reads).toBe(3);
});

it('keeps a failed reread unconfirmed instead of returning the previous goal or submitting an input', async () => {
  const calls: string[] = []; let reads = 0;
  const f = fixture(async method => {
    calls.push(method);
    if (method === 'thread/read') { if (++reads === 1) f.observe(newGoal); return { thread }; }
    if (method === 'thread/goal/get') {
      if (reads === 2) throw new Error('Native read unavailable');
      return { goal: oldGoal };
    }
    throw new Error('Unexpected method ' + method);
  });
  await expect(f.adapter.nativeState('session')).rejects.toThrow('Native read unavailable');
  expect(calls).toEqual(['thread/read', 'thread/goal/get', 'thread/read', 'thread/goal/get']);
});

it('does not return a native goal snapshot after its runtime is replaced', async () => {
  const gate = deferred<{ thread: typeof thread }>(); const started = deferred<void>();
  const f = fixture(async method => {
    if (method === 'thread/read') { started.resolve(); return gate.promise; }
    if (method === 'thread/goal/get') return { goal: oldGoal };
    throw new Error('Unexpected method ' + method);
  });
  const pending = f.adapter.nativeState('session'); await started.promise;
  f.replace(); gate.resolve({ thread });
  await expect(pending).rejects.toMatchObject({ statusCode: 409 });
});

it.each([oldGoal, null])('does not project an obsolete CLI-return goal read after accepting a new goal (%j)', async goal => {
  const gate = deferred<{ goal: ThreadGoal | null }>(); const started = deferred<void>();
  const f = fixture(async method => {
    if (method === 'thread/turns/list') return { data: [], nextCursor: null };
    if (method === 'thread/goal/get') { started.resolve(); return gate.promise; }
    throw new Error('Unexpected method ' + method);
  });
  const pending = f.restore(); await started.promise;
  f.observe(newGoal); gate.resolve({ goal }); await pending;
  expect(f.events.filter(event => event.type === 'item.complete' && event.kind === 'goal').map(event => event.type === 'item.complete' ? event.data : undefined))
    .toMatchObject([{ objective: newGoal.objective, status: 'paused' }]);
});

it('keeps a goal cleared during a CLI-return read cleared after the obsolete get returns', async () => {
  const gate = deferred<{ goal: ThreadGoal }>(); const started = deferred<void>();
  const f = fixture(async method => {
    if (method === 'thread/turns/list') return { data: [], nextCursor: null };
    if (method === 'thread/goal/get') { started.resolve(); return gate.promise; }
    throw new Error('Unexpected method ' + method);
  });
  f.observe(oldGoal); f.events.length = 0;
  const pending = f.restore(); await started.promise;
  f.observe(null); gate.resolve({ goal: oldGoal }); await pending;
  expect(f.events.filter(event => event.type === 'item.complete' && event.kind === 'goal').map(event => event.type === 'item.complete' ? event.data : undefined))
    .toMatchObject([{ objective: '', status: 'cleared', goalId: 'native:100' }]);
});

it.each(['replace', 'disconnect'] as const)('does not project a CLI-return goal read after its native runtime %s', async action => {
  const gate = deferred<{ goal: ThreadGoal }>(); const started = deferred<void>();
  const f = fixture(async method => {
    if (method === 'thread/turns/list') return { data: [], nextCursor: null };
    if (method === 'thread/goal/get') { started.resolve(); return gate.promise; }
    throw new Error('Unexpected method ' + method);
  });
  const pending = f.restore(); await started.promise;
  f[action](); gate.resolve({ goal: oldGoal });
  await expect(pending).rejects.toMatchObject({ code: 'uncertain' });
  expect(f.events.some(event => event.type === 'item.complete' && event.kind === 'goal')).toBe(false);
});
