import { afterEach, expect, it, vi } from 'vitest';
import type { AdapterEvent } from '@webdcc/protocol';
import { CodexAdapter } from '../src/adapter.js';
import { JsonRpcStdio, type Frame } from '../src/rpc.js';
import type { ThreadResumeResponse } from '../src/schema/v2/ThreadResumeResponse.js';

afterEach(() => vi.restoreAllMocks());

function nativeFixture() {
  const policy: ThreadResumeResponse = {
    thread: {
      id: 'native', sessionId: 'native', forkedFromId: null, parentThreadId: null,
      preview: '', ephemeral: false, section: null, sectionEnteredAt: null,
      projectId: null, historyMode: 'paginated', modelProvider: 'fixture', model: 'fixture',
      reasoningEffort: null, createdAt: 0, updatedAt: 0, recencyAt: null,
      status: { type: 'idle' }, path: null, cwd: '/tmp/fixture', cliVersion: '0.167.0',
      originator: null, source: 'appServer', threadSource: null, agentNickname: null,
      agentRole: null, gitInfo: null, name: null, turns: [],
    },
    model: 'fixture', modelProvider: 'fixture', serviceTier: null,
    disabledPluginIds: [], cwd: '/tmp/fixture', instructionSources: [],
    approvalPolicy: 'on-request', approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite', writableRoots: ['/tmp/fixture'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    reasoningEffort: null, collaborationMode: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null,
  };
  let notification: (frame: Frame) => void = () => undefined;
  const request = vi.fn(async (method: string) => {
    if (method === 'initialize') return { userAgent: 'fixture', codexHome: '/tmp/fixture', platformFamily: 'unix', platformOs: 'linux' };
    if (method === 'thread/start') { notification({ method: 'thread/started', params: {} }); return structuredClone(policy); }
    if (method === 'thread/resume') return structuredClone(policy);
    if (method === 'turn/start') return { turn: { id: 'turn', rootTurnId: null, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null } };
    if (method === 'permissionProfile/list') return { data: [{ id: ':workspace', description: null, allowed: false }] };
    throw new Error(`unexpected method: ${method}`);
  });
  const rpc = { child: { pid: 0 }, request, notify: vi.fn(), onNotification: (cb: (frame: Frame) => void) => { notification = cb; }, onServerRequest: vi.fn(), kill: vi.fn(async () => undefined) };
  vi.spyOn(JsonRpcStdio, 'start').mockReturnValue(rpc as unknown as JsonRpcStdio);
  const adapter = new CodexAdapter();
  adapter.probe = async () => ({ installed: true, version: '0.167.0', compatible: true, auth: 'unknown' });
  const events: AdapterEvent[] = [];
  adapter.onEvent((_id, event) => events.push(event));
  return { adapter, policy, request, events, notify: (frame: Frame) => notification(frame) };
}

it('NP-07 a successful turn does not turn the requested sandbox into effective permission without native readback', async () => {
  const ctx = nativeFixture();
  try {
    await ctx.adapter.create({ sessionId: 'local', cwd: '/tmp/fixture', providerId: null });
    await ctx.adapter.setAccessMode('local', 'read-only');
    await ctx.adapter.send('local', { text: 'unchanged text' });
    expect(ctx.request.mock.calls.at(-1)).toEqual(['thread/resume', { threadId: 'native', excludeTurns: true }]);
    expect(ctx.events.filter(event => event.type === 'permissions').at(-1)).toMatchObject({ observation: { effective: 'workspace', source: 'thread/resume:policy-readback' } });
    ctx.request.mockImplementationOnce(async () => ({ turn: { id: 'turn', rootTurnId: null, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null } }));
    ctx.request.mockImplementationOnce(async () => { throw new Error('readback lost'); });
    await expect(ctx.adapter.send('local', { text: 'accepted' })).resolves.toBeUndefined();
    expect(ctx.events.filter(event => event.type === 'permissions').at(-1)).toMatchObject({ observation: { effective: null } });
  } finally { await ctx.adapter.dispose('local'); }
});

it('NP-07 inherit reads the current native default and sends no policy overrides after a previous turn changed it', async () => {
  const ctx = nativeFixture();
  try {
    await ctx.adapter.create({ sessionId: 'local', cwd: '/tmp/fixture', providerId: null });
    await ctx.adapter.setAccessMode('local', 'danger-full-access');
    ctx.policy.sandbox = { type: 'dangerFullAccess' };
    ctx.policy.approvalPolicy = 'never';
    await ctx.adapter.send('local', { text: 'first' });
    await ctx.adapter.setAccessMode('local', 'inherit');
    expect(ctx.events.filter(event => event.type === 'permissions').at(-1)).toMatchObject({ observation: { effective: 'danger-full-access' } });
    await ctx.adapter.send('local', { text: 'second' });
    const start = ctx.request.mock.calls.filter(([method]) => method === 'turn/start').at(-1)?.[1];
    expect(start).not.toHaveProperty('approvalPolicy');
    expect(start).not.toHaveProperty('sandboxPolicy');
    expect(start).not.toHaveProperty('approvalsReviewer');
  } finally { await ctx.adapter.dispose('local'); }
});

it('NP-07 catalog failures and native disallowed profiles never become selectable static defaults', async () => {
  const ctx = nativeFixture();
  expect(await ctx.adapter.listAccessModes()).toMatchObject([{ id: ':workspace', allowed: false }]);
  ctx.request.mockRejectedValue(new Error('offline'));
  expect((await ctx.adapter.listAccessModes()).every(option => option.allowed === false)).toBe(true);
});

it('NP-08 autonomous starts update the stop target and a delayed response cannot resurrect a completed turn', async () => {
  const ctx = nativeFixture();
  try {
    await ctx.adapter.create({ sessionId: 'local', cwd: '/tmp/fixture', providerId: null });
    const turn = { id: 'first', rootTurnId: null, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null };
    ctx.request.mockImplementationOnce(async () => {
      ctx.notify({ method: 'turn/started', params: { turn } });
      ctx.notify({ method: 'turn/completed', params: { turn: { ...turn, status: 'completed' } } });
      ctx.notify({ method: 'turn/started', params: { turn: { ...turn, id: 'autonomous' } } });
      return { turn };
    });
    await ctx.adapter.send('local', { text: 'original' });
    expect(ctx.events.filter(event => event.type === 'turn.start')).toHaveLength(2);
    ctx.request.mockImplementationOnce(async () => ({}));
    await ctx.adapter.interrupt('local');
    expect(ctx.request.mock.calls.at(-1)).toEqual(['turn/interrupt', { threadId: 'native', turnId: 'autonomous' }]);
    ctx.notify({ method: 'turn/completed', params: { turn: { ...turn, id: 'autonomous', status: 'interrupted' } } });
    const calls = ctx.request.mock.calls.length;
    await ctx.adapter.interrupt('local');
    expect(ctx.request.mock.calls).toHaveLength(calls);
  } finally { await ctx.adapter.dispose('local'); }
});

it('uses the native Review execution id for interrupt while projecting its items onto the accepted root operation', async () => {
  const ctx = nativeFixture();
  try {
    await ctx.adapter.create({ sessionId: 'local', cwd: '/tmp/fixture', providerId: null });
    const root = { id: 'review-root', rootTurnId: null, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null };
    ctx.request.mockImplementationOnce(async () => ({ thread: ctx.policy.thread }));
    ctx.request.mockImplementationOnce(async () => {
      ctx.notify({ method: 'item/started', params: { threadId: 'native', turnId: root.id, item: { type: 'enteredReviewMode', id: 'enter', review: 'current changes' } } });
      ctx.notify({ method: 'turn/started', params: { threadId: 'native', turn: { ...root, id: 'review-execution', rootTurnId: root.id } } });
      return { reviewThreadId: 'native', turn: root };
    });
    await ctx.adapter.executeNativeControl('local', { type: 'review', target: { type: 'uncommittedChanges' } });
    expect(ctx.events.filter(event => event.type === 'turn.start').every(event => event.nativeTurnId === root.id)).toBe(true);
    ctx.request.mockImplementationOnce(async () => ({}));
    await ctx.adapter.interrupt('local');
    expect(ctx.request.mock.calls.at(-1)).toEqual(['turn/interrupt', { threadId: 'native', turnId: 'review-execution' }]);
    ctx.notify({ method: 'turn/completed', params: { threadId: 'native', turn: { ...root, status: 'interrupted' } } });
    const calls = ctx.request.mock.calls.length;
    await ctx.adapter.interrupt('local');
    expect(ctx.request.mock.calls).toHaveLength(calls);
  } finally { await ctx.adapter.dispose('local'); }
});

it('binds an accepted Review root before its marker and ignores a delayed accepted result after a newer autonomous turn starts', async () => {
  const ctx = nativeFixture();
  try {
    await ctx.adapter.create({ sessionId: 'local', cwd: '/tmp/fixture', providerId: null });
    const root = { id: 'review-root', rootTurnId: null, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null };
    ctx.request.mockImplementationOnce(async () => ({ thread: ctx.policy.thread }));
    ctx.request.mockImplementationOnce(async () => ({ reviewThreadId: 'native', turn: root }));
    await ctx.adapter.executeNativeControl('local', { type: 'review', target: { type: 'uncommittedChanges' } });
    expect(ctx.events.filter(event => event.type === 'turn.start')).toMatchObject([{ nativeTurnId: root.id, native: { reviewThreadId: 'native', turn: root } }]);
    ctx.notify({ method: 'turn/completed', params: { threadId: 'native', turn: { ...root, status: 'completed' } } });
    const nextRoot = { ...root, id: 'next-review' };
    ctx.request.mockImplementationOnce(async () => ({ thread: ctx.policy.thread }));
    ctx.request.mockImplementationOnce(async () => {
      ctx.notify({ method: 'item/started', params: { threadId: 'native', turnId: nextRoot.id, item: { type: 'enteredReviewMode', id: 'next-enter', review: 'current changes' } } });
      ctx.notify({ method: 'turn/completed', params: { threadId: 'native', turn: { ...nextRoot, status: 'completed' } } });
      ctx.notify({ method: 'turn/started', params: { threadId: 'native', turn: { ...root, id: 'autonomous' } } });
      return { reviewThreadId: 'native', turn: nextRoot };
    });
    await ctx.adapter.executeNativeControl('local', { type: 'review', target: { type: 'uncommittedChanges' } });
    ctx.request.mockImplementationOnce(async () => ({}));
    await ctx.adapter.interrupt('local');
    expect(ctx.request.mock.calls.at(-1)).toEqual(['turn/interrupt', { threadId: 'native', turnId: 'autonomous' }]);
  } finally { await ctx.adapter.dispose('local'); }
});
