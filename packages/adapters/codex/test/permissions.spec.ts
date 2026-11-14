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
  return { adapter, policy, request, events };
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
