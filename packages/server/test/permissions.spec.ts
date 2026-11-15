import { expect, it } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent, AgentAdapter, CreateOpts } from '@webdcc/protocol';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

it('NP-07 a new native session with no selection preserves its configured non-default permission mode', async () => {
  const ctx = await createTestApp();
  const adapter = new FakeAdapter({ id: 'codex' });
  Object.defineProperty(adapter, 'kind', { value: 'real' });
  let callback!: (id: string, event: AdapterEvent) => void;
  let launch!: CreateOpts;
  adapter.onEvent = cb => { callback = cb; };
  adapter.create = async opts => { launch = opts; callback(opts.sessionId, { type: 'permissions', observation: { effective: 'workspace', source: 'thread/start', scope: 'thread' } }); return { nativeId: 'native' }; };
  adapter.dispose = async () => undefined;
  adapter.setAccessMode = async () => ({ accessMode: 'read-only' });
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    expect(launch).not.toHaveProperty('accessMode');
    expect(ctx.store.getSession(sessionId)?.permissions).toMatchObject({ requested: null, effective: 'workspace', phase: 'observed' });
    await ctx.manager.setAccessMode(sessionId, 'read-only');
    expect(ctx.store.getSession(sessionId)?.permissions).toMatchObject({ requested: 'read-only', effective: 'workspace', phase: 'pending' });
    callback(sessionId, { type: 'permissions', observation: { effective: 'read-only', source: 'turn/start', scope: 'turn' } });
    expect(ctx.store.getSession(sessionId)?.permissions).toMatchObject({ effective: 'read-only', phase: 'observed' });
  } finally { await ctx.close(); }
});

it('NP-07 failed permission changes retain the old effective mode and block native sends', async () => {
  const ctx = await createTestApp();
  const adapter = new FakeAdapter({ id: 'codex' });
  let sent = 0;
  adapter.send = async () => { sent++; };
  adapter.setAccessMode = async () => { throw Object.assign(new Error('native policy rejected'), { statusCode: 409 }); };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await expect(ctx.manager.setAccessMode(sessionId, 'workspace')).rejects.toThrow('rejected');
    expect(ctx.store.getSession(sessionId)?.permissions).toMatchObject({ requested: 'workspace', effective: 'read-only', phase: 'failed' });
    await expect(ctx.manager.send(sessionId, { text: 'cannot run' })).rejects.toMatchObject({ statusCode: 409 });
    expect(sent).toBe(0);
    expect(ctx.store.journal.queue(sessionId)).toEqual([]);
  } finally { await ctx.close(); }
});

it('NP-07 native disallowed profiles cannot be selected through colon aliases', async () => {
  const ctx = await createTestApp();
  const adapter = new FakeAdapter({ id: 'codex' });
  (adapter as AgentAdapter).listAccessModes = async () => [{ id: ':read-only', label: 'readonly', allowed: false }];
  ctx.manager.registerAdapter(adapter);
  try {
    const workspace = ctx.store.createWorkspace('blocked', ctx.dataDir);
    await expect(ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex', accessMode: 'read-only' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex', accessMode: ':read-only' })).rejects.toMatchObject({ statusCode: 400 });
    expect(ctx.store.listSessions()).toEqual([]);
  } finally { await ctx.close(); }
});

it('NP-04/07 serializes concurrent permission and model controls against the current native instance', async () => {
  const ctx = await createTestApp();
  const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  adapter.setAccessMode = async (_id, mode) => { calls.push('permission'); await gate; return { accessMode: mode }; };
  adapter.setModel = async () => { calls.push('model'); };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    const permission = ctx.manager.setAccessMode(sessionId, 'workspace');
    const model = ctx.manager.setModel(sessionId, 'new');
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toEqual(['permission']);
    release();
    await Promise.all([permission, model]);
    expect(calls).toEqual(['permission', 'model']);
  } finally { release(); await ctx.close(); }
});

it('NP-04/07 a native send in progress finishes before permission or model controls can replace its settings', async () => {
  const ctx = await createTestApp();
  const adapter = new FakeAdapter({ id: 'codex' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  adapter.send = async () => { calls.push('send'); await gate; };
  adapter.setAccessMode = async (_id, mode) => { calls.push('permission'); return { accessMode: mode }; };
  adapter.setModel = async () => { calls.push('model'); };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    const send = ctx.manager.send(sessionId, { text: 'first' });
    await new Promise(resolve => setImmediate(resolve));
    const permission = ctx.manager.setAccessMode(sessionId, 'workspace');
    const model = ctx.manager.setModel(sessionId, 'next');
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toEqual(['send']);
    release();
    await Promise.all([send, permission, model]);
    expect(calls).toEqual(['send', 'permission', 'model']);
  } finally { release(); await ctx.close(); }
});

it('NP-03/07 native completion cannot dispatch an ACKed queue across a pending or failed permission change, and retry releases it', async () => {
  const ctx = await createTestApp();
  const adapter = new FakeAdapter({ id: 'codex' });
  let callback!: (id: string, event: AdapterEvent) => void;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let rejected = true;
  let entered = false;
  let sends = 0;
  adapter.onEvent = cb => { callback = cb; };
  adapter.create = async opts => { callback(opts.sessionId, { type: 'permissions', observation: { effective: 'read-only', source: 'fixture', scope: 'thread' } }); return { nativeId: 'native' }; };
  adapter.send = async () => { sends++; };
  adapter.dispose = async () => undefined;
  adapter.setAccessMode = async (id, mode) => {
    entered = true;
    if (rejected) { await gate; throw new Error('native rejected'); }
    callback(id, { type: 'permissions', observation: { effective: mode, source: 'fixture', scope: 'thread' } });
    return { accessMode: mode };
  };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await ctx.manager.send(sessionId, { text: 'first' });
    const queued = await ctx.manager.send(sessionId, { text: 'durable queued text' }, 'DURABLE-QUEUE');
    expect(queued.queued).toBe(true);
    const change = ctx.manager.setAccessMode(sessionId, 'workspace');
    const failure = expect(change).rejects.toThrow('native rejected');
    await new Promise(resolve => setImmediate(resolve));
    expect(entered).toBe(true);
    callback(sessionId, { type: 'turn.end', status: 'interrupted' });
    await new Promise(resolve => setImmediate(resolve));
    expect(sends).toBe(1);
    release();
    await failure;
    await new Promise(resolve => setImmediate(resolve));
    expect(ctx.store.journal.queue(sessionId)).toMatchObject([{ turnId: queued.turnId, state: 'queued', input: { text: 'durable queued text' } }]);
    expect(sends).toBe(1);
    rejected = false;
    await ctx.manager.setAccessMode(sessionId, 'read-only');
    expect(sends).toBe(2);
    expect(ctx.store.journal.queue(sessionId)).toMatchObject([{ turnId: queued.turnId, state: 'native-accepted' }]);
  } finally { release(); await ctx.close(); }
});
