import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAdapter } from '@webdcc/adapter-codex';
import { currentCodexSubagents, codexSubagentRecoveryText, reduceTurn, type TraceFrame, type UserInput } from '@webdcc/protocol';
import { createTestApp } from './helpers.js';
import { SessionManager } from '../src/manager.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function fixture() {
  const ctx = await createTestApp();
  const workspace = ctx.store.createWorkspace('parent/child replay', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
  ctx.store.updateSession(session.id, { nativeId: 'parent' });
  const replay = CodexAdapter.replay(session.id, 'parent');
  let index = 0;
  const feed = (method: string, params: Record<string, unknown>) => replay.feed({ i: ++index, t: index, dir: 'in', ch: 'rpc', frame: { method, params } } satisfies TraceFrame);
  const sent: UserInput[] = [];
  replay.adapter.resume = async () => undefined; replay.adapter.dispose = async () => undefined;
  replay.adapter.create = async opts => ({ nativeId: `controlled-handoff-${opts.sessionId}` });
  replay.adapter.send = async (id, input) => {
    sent.push(input);
    if (id === session.id) feed('turn/started', { threadId: 'parent', turn: { id: `parent-${sent.length}`, status: 'inProgress' } });
  };
  replay.adapter.interrupt = async () => { feed('turn/completed', { threadId: 'parent', turn: { id: `parent-${sent.length}`, status: 'interrupted' } }); };
  ctx.manager.registerAdapter(replay.adapter);
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.spyOn(Math, 'random').mockReturnValue(0);
  ctx.manager.watchdog.configure({ enabled: true, baseDelaySeconds: 5, maxDelaySeconds: 10 });
  const spawn = (childId: string) => {
    feed('item/completed', { threadId: 'parent', turnId: 'parent-1', item: { type: 'subAgentActivity', id: `spawn-${childId}`, kind: 'started', agentThreadId: childId, agentPath: `/root/${childId}`, model: 'recorded-model' } });
    feed('turn/started', { threadId: childId, turn: { id: `${childId}-1`, rootTurnId: 'parent-1', status: 'inProgress' } });
  };
  const finish = (threadId: string, id: string, status: string) => feed('turn/completed', { threadId, turn: { id, status,
    ...(status === 'failed' ? { error: { message: 'stream disconnected before completion: stream closed before response.completed' } } : {}) } });
  return { ctx, session, replay, feed, sent, spawn, finish, children: () => currentCodexSubagents(ctx.store.allEvents(session.id)) };
}

it('child retries/results cannot replace the failed parent, cancel its job or complete its recovery', async () => {
  const f = await fixture();
  try {
    const initial = await f.ctx.manager.send(f.session.id, { text: 'original task' });
    f.spawn('child-a'); f.spawn('child-b');
    f.finish('child-b', 'child-b-1', 'failed');
    f.feed('turn/started', { threadId: 'child-b', turn: { id: 'child-b-2', rootTurnId: 'parent-1', status: 'inProgress' } });
    f.feed('error', { threadId: 'parent', turnId: 'parent-1', willRetry: true, error: { message: 'Reconnecting... 1/5' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.sent).toHaveLength(1); expect(f.ctx.store.watchdogJob(f.session.id)).toBeUndefined();
    expect(f.ctx.manager.getRuntime(f.session.id)?.turnId).toBe(initial.turnId);
    f.finish('parent', 'parent-1', 'failed'); f.finish('parent', 'parent-1', 'failed');
    expect(f.ctx.store.watchdogJob(f.session.id)).toMatchObject({ status: 'scheduled', failedTurnId: initial.turnId });
    expect(f.ctx.manager.getRuntime(f.session.id)?.turnId).toBeNull();
    for (const childId of ['child-a', 'child-b']) {
      const nativeTurnId = childId === 'child-a' ? 'child-a-1' : 'child-b-2';
      f.feed('item/completed', { threadId: childId, turnId: nativeTurnId, item: { type: 'agentMessage', id: 'same-item-id', text: `${childId} result`, phase: 'final_answer' } });
      f.finish(childId, nativeTurnId, 'completed');
    }
    f.finish('child-b', 'child-b-1', 'failed'); // Late old failure cannot overwrite child-b-2.
    f.feed('turn/started', { threadId: 'child-b', turn: { id: 'child-b-1', rootTurnId: 'parent-1', status: 'inProgress' } });
    const events = f.ctx.store.allEvents(f.session.id);
    expect(events.filter(event => event.kind === 'turn.started')).toHaveLength(1);
    expect(reduceTurn(events.filter(event => event.turnId === initial.turnId)).answer).toEqual([]);
    expect(f.children().map(child => [child.childId, child.nativeStatus, child.results[0]?.text])).toEqual([
      ['child-a', 'completed', 'child-a result'], ['child-b', 'completed', 'child-b result'],
    ]);
    expect(f.children()[1]?.turns['child-b-1']?.status).toBe('failed');
    expect(codexSubagentRecoveryText('failed', f.children())).toBe('父轮次失败，子任务已完成，待恢复汇总');
    expect(f.ctx.store.watchdogJob(f.session.id)?.status).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.sent.map(input => input.text)).toEqual(['original task', '继续']);
    expect(f.ctx.store.getSession(f.session.id)?.nativeId).toBe('parent');
    expect(f.ctx.store.watchdogJob(f.session.id)?.status).toBe('recovering');
    f.finish('child-a', 'child-a-1', 'completed');
    expect(f.ctx.store.watchdogJob(f.session.id)?.status).toBe('recovering');
    f.feed('item/completed', { threadId: 'parent', turnId: 'parent-2', item: { type: 'agentMessage', id: 'summary', text: 'parent summary of existing results', phase: 'final_answer' } });
    f.finish('parent', 'parent-2', 'completed');
    await vi.advanceTimersByTimeAsync(1500); // Existing native completion settle window.
    expect(f.ctx.store.watchdogJob(f.session.id)?.status).toBe('recovered');
    expect(f.children()).toHaveLength(2);
  } finally { f.ctx.manager.watchdog.stop(); vi.useRealTimers(); await f.ctx.close(); }
});

it.each(['stop', 'archive', 'cancel', 'manual', 'disable', 'approval', 'question'])('child completion cannot revive recovery after %s', async action => {
  const f = await fixture();
  try {
    await f.ctx.manager.send(f.session.id, { text: 'original task' }); f.spawn('child');
    if (action === 'approval' || action === 'question') {
      // Native request handling stays pending; the Watchdog never answers it.
      if (action === 'question') f.replay.feed({ i: 999, t: 999, dir: 'in', ch: 'rpc', frame: { id: 'q', method: 'item/tool/requestUserInput', params: { threadId: 'parent', turnId: null, questions: [{ id: 'q', question: 'choose' }] } } });
      else f.replay.feed({ i: 999, t: 999, dir: 'in', ch: 'rpc', frame: { id: 'a', method: 'item/commandExecution/requestApproval', params: { threadId: 'parent', turnId: 'parent-1', command: 'ls' } } });
    }
    f.finish('parent', 'parent-1', 'failed');
    if (action === 'stop') await f.ctx.manager.interrupt(f.session.id);
    if (action === 'archive') await f.ctx.manager.archive(f.session.id, true);
    if (action === 'cancel') f.ctx.manager.watchdog.cancel(f.session.id);
    if (action === 'manual') await f.ctx.manager.send(f.session.id, { text: 'manual continuation' });
    if (action === 'disable') f.ctx.manager.watchdog.configure({ enabled: false });
    f.finish('child', 'child-1', 'completed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sent.map(input => input.text)).toEqual(action === 'manual' ? ['original task', 'manual continuation'] : ['original task']);
    expect(f.replay.replies).toEqual([]);
  } finally { f.ctx.manager.watchdog.stop(); vi.useRealTimers(); await f.ctx.close(); }
});

it('resource handoff records existing task identities/results in addition to the parent history', async () => {
  const f = await fixture();
  try {
    await f.ctx.manager.send(f.session.id, { text: 'original task' }); f.spawn('child');
    f.feed('item/completed', { threadId: 'child', turnId: 'child-1', item: { type: 'agentMessage', id: 'result', text: 'completed work', phase: 'final_answer' } });
    f.finish('child', 'child-1', 'completed');
    f.feed('turn/completed', { threadId: 'parent', turn: { id: 'parent-1', status: 'failed', error: { message: 'The requested item was created under a different OpenAI resource. Use the same resource that created the item to access it.' } } });
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(f.ctx.store.watchdogJob(f.session.id)?.status).toBe('handed-off'));
    const targetId = f.ctx.store.watchdogJob(f.session.id)?.targetSessionId;
    if (targetId === undefined) throw new Error('missing handoff target');
    const prompt = f.ctx.store.allEvents(targetId).find(event => event.kind === 'user.message')?.data as { text: string };
    const path = /已有原生子任务及结果：([^\n]+)/.exec(prompt.text)?.[1];
    expect(path).toBeDefined();
    const record = JSON.parse(await readFile(path!, 'utf8'));
    expect(record.children[0]).toMatchObject({ childId: 'child', parentThreadId: 'parent', nativeTurnId: 'child-1', nativeStatus: 'completed', results: [{ itemId: 'result', text: 'completed work' }] });
    expect(f.ctx.store.getSession(targetId)?.parentId).toBe(f.session.id);
  } finally { f.ctx.manager.watchdog.stop(); vi.useRealTimers(); await f.ctx.close(); }
});

it('restart restores the scheduled parent recovery and existing child identities/results without repeating the task', async () => {
  const f = await fixture(); let next: SessionManager | undefined;
  try {
    await f.ctx.manager.send(f.session.id, { text: 'original task' }); f.spawn('child');
    f.feed('item/completed', { threadId: 'child', turnId: 'child-1', item: { type: 'agentMessage', id: 'partial', text: 'retained before restart', phase: 'commentary' } });
    f.finish('parent', 'parent-1', 'failed');
    await f.ctx.manager.disposeAll();
    const native = CodexAdapter.replay(f.session.id, 'parent', f.children());
    const resumed: UserInput[] = [];
    native.adapter.resume = async opts => { expect(opts.restoreCodexSubagents).toMatchObject([{ childId: 'child', parentThreadId: 'parent', results: [{ itemId: 'partial', text: 'retained before restart' }] }]); };
    native.adapter.dispose = async () => undefined;
    native.adapter.send = async (_id, input) => { resumed.push(input); native.feed({ i: 1, t: 1, dir: 'in', ch: 'rpc', frame: { method: 'turn/started', params: { threadId: 'parent', turn: { id: 'parent-restored', status: 'inProgress' } } } }); };
    next = new SessionManager(f.ctx.store, { idleDisposeMin: 0, watchdogDataDir: f.ctx.dataDir }); next.registerAdapter(native.adapter);
    await vi.advanceTimersByTimeAsync(5000);
    expect(resumed.map(input => input.text)).toEqual(['继续']);
    native.feed({ i: 2, t: 2, dir: 'in', ch: 'rpc', frame: { method: 'turn/completed', params: { threadId: 'child', turn: { id: 'child-1', status: 'completed' } } } });
    expect(f.children()).toMatchObject([{ childId: 'child', nativeStatus: 'completed', results: [{ text: 'retained before restart' }] }]);
    expect(f.ctx.store.watchdogJob(f.session.id)?.status).toBe('recovering');
    expect(f.ctx.store.allEvents(f.session.id).filter(event => event.kind === 'turn.started')).toHaveLength(2);
  } finally { await next?.disposeAll(); f.ctx.manager.watchdog.stop(); vi.useRealTimers(); await f.ctx.close(); }
});
