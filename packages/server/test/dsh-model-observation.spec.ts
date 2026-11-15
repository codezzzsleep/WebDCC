import { DshAdapter } from '@webdcc/adapter-dsh';
import { expect, it, vi } from 'vitest';
import { createTestApp } from './helpers.js';

it('synchronizes the exact native Provider/model with effort instead of showing a stale same-name route', async () => {
  const ctx = await createTestApp();
  try {
    const route = (provider: string) => `dsh:${Buffer.from(JSON.stringify([provider, 'same'])).toString('base64url')}`;
    const workspace = ctx.store.createWorkspace('native model observation', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh', model: route('one'), reasoningEffort: 'low' });
    ctx.store.updateSession(session.id, { nativeId: 'native' });
    const native = DshAdapter.replay(session.id);
    native.feed({ i: 1, t: 1, dir: 'in', ch: 'mux:$events', frame: { value: { type: 'snapshot', header: { id: 'native' }, cursor: -1, records: [], hasMore: false } } });
    Object.assign(native.adapter, { client: { isConnected: true, connect: async () => undefined,
      rpc: async (endpoint: string) => endpoint === 'session/state' ? { cursor: 2, active: true, running: false, queue: [], pendingInput: [] }
        : endpoint === 'session/projections' ? { kind: 'sequenced', asOfSeq: 2, values: { modelSelection: { lastUsed: { provider: 'one', model: 'same', reasoningEffort: 'low' }, next: { provider: 'two', model: 'same', reasoningEffort: 'max' } } } }
          : endpoint === 'session/modelCatalog' ? { default: { provider: 'one', model: 'same' }, groups: [{ id: 'one', models: [{ id: 'same' }] }, { id: 'two', models: [{ id: 'same' }] }] } : {},
    } });
    vi.spyOn(native.adapter, 'hostIdentity').mockResolvedValue({ status: 'verified', version: '0.2.2-rc.1', source: 'native-bootstrap', fingerprint: 'host', url: 'http://test/' });
    native.adapter.resume = async () => undefined; native.adapter.send = async () => undefined; native.adapter.dispose = async () => undefined;
    native.adapter.nativeCatalog = async () => ({});
    ctx.manager.registerAdapter(native.adapter);
    await ctx.manager.send(session.id, { text: 'start' });
    const state = await ctx.manager.nativeControls(session.id);
    expect(state.state).toMatchObject({ selected: { provider: 'two', model: 'same', reasoningEffort: 'max' } });
    expect(ctx.store.getSession(session.id)).toMatchObject({ model: route('two'), reasoningEffort: 'max' });
    const client = (native.adapter as unknown as { client: { rpc: (endpoint: string, args: Record<string, unknown>) => Promise<unknown> } }).client;
    client.rpc = async (endpoint, args) => endpoint === 'session/modelCatalog'
      ? { default: { provider: 'one', model: 'same' }, groups: [{ id: 'one', models: [{ id: 'same' }] }] }
      : endpoint === 'session/selectModel' ? { selected: args['request'] } : {};
    const result = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { op: 'set-model', clientCommandId: 'ALIAS', sessionId: session.id, model: route('one') } });
    expect(result.json()).toMatchObject({ ok: true, value: { model: 'same' } });
    expect(ctx.store.getSession(session.id)?.model).toBe('same');
  } finally { await ctx.close(); }
});
