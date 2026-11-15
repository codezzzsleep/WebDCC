import { expect, it, vi } from 'vitest';
import type { AdapterEvent } from '@webdcc/protocol';
import { DshAdapter } from '../src/adapter.js';
import type { DshHostClient } from '../src/host.js';

const route = (provider: string, model = 'same') => `dsh:${Buffer.from(JSON.stringify([provider, model])).toString('base64url')}`;
function host(options: { cached?: boolean; result?: unknown; error?: Error } = {}) {
  const replay = DshAdapter.replay('web');
  replay.feed({ i: 1, t: 0, dir: 'in', ch: 'mux:$events', frame: { value: { type: 'snapshot', header: { id: 'native' }, cursor: -1, records: [], hasMore: false } } });
  let next: { provider: string; model: string; reasoningEffort?: string } = { provider: 'two', model: 'same', reasoningEffort: 'max' };
  const writes: unknown[] = []; const events: AdapterEvent[] = [];
  replay.adapter.onEvent((_id, event) => events.push(event));
  const rpc = async (endpoint: string, args: Record<string, unknown>) => {
    if (endpoint === 'session/state') return { cursor: 2, active: true, running: false, queue: [], pendingInput: [] };
    if (endpoint === 'session/projections') return { ...(options.cached ? { kind: 'cached' } : {}), asOfSeq: 2,
      values: { modelSelection: { lastUsed: { provider: 'one', model: 'same', reasoningEffort: 'low' }, next } } };
    if (endpoint === 'session/modelCatalog') return { groups: [
      { id: 'one', models: [{ id: 'same', reasoning: { efforts: [{ id: 'low' }] } }] },
      { id: 'two', models: [{ id: 'same', reasoning: { efforts: [{ id: 'off' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'off' } }, { id: 'plain' }] },
    ] };
    if (endpoint === 'session/selectModel') {
      writes.push(args);
      if (options.error) throw options.error;
      const request = args['request'] as typeof next;
      const response = options.result === undefined ? { selected: request } : options.result;
      const selected = (response as { selected?: typeof next })?.selected;
      if (selected !== undefined) next = selected;
      return response;
    }
    return {};
  };
  Object.assign(replay.adapter, { client: { connect: async () => undefined, isConnected: true, rpc } as unknown as DshHostClient });
  vi.spyOn(replay.adapter, 'hostIdentity').mockResolvedValue({ status: 'verified', version: '0.2.2-rc.1', source: 'native-bootstrap', fingerprint: 'test-host', url: 'http://host.test/' });
  return { adapter: replay.adapter, writes, events };
}

it('DSH efforts follow the exact Provider/model and preserve the native next selection instead of lastUsed', async () => {
  const ctx = host();
  const catalog = await ctx.adapter.listModels();
  expect(catalog.find(model => model.id === route('one'))?.reasoningEfforts).toEqual(['low']);
  expect(catalog.find(model => model.id === route('two'))?.reasoningEfforts).toEqual(['off', 'high', 'max']);
  await ctx.adapter.setReasoningEffort('web', 'high');
  expect(ctx.writes).toEqual([{ request: { sessionId: 'native', provider: 'two', model: 'same', reasoningEffort: 'high' } }]);
  expect(await ctx.adapter.nativeState('web')).toMatchObject({ selected: { provider: 'two', model: 'same', reasoningEffort: 'high' } });
  expect(ctx.events.some(event => event.type === 'item.complete' && (event.native as { source?: string })?.source === 'session/selectModel:selected')).toBe(true);
});

it('unadvertised effort and unavailable reasoning capability fail before any native selection write', async () => {
  const ctx = host();
  await expect(ctx.adapter.setReasoningEffort('web', 'medium')).rejects.toMatchObject({ statusCode: 400, code: 'native-control-rejected' });
  expect(ctx.writes).toEqual([]);
  await ctx.adapter.setModel('web', route('two', 'plain'));
  expect(await ctx.adapter.nativeState('web')).toMatchObject({ selected: { model: 'plain' } });
  expect((await ctx.adapter.nativeState('web') as { selected: unknown }).selected).not.toHaveProperty('reasoningEffort');
  await expect(ctx.adapter.setReasoningEffort('web', 'high')).rejects.toMatchObject({ statusCode: 400 });
  expect(ctx.writes).toHaveLength(1);
});

it('DSH never acknowledges a reasoning choice from the request when selected is missing or differs', async () => {
  for (const result of [{}, { selected: { provider: 'two', model: 'same', reasoningEffort: 'off' } }]) {
    const ctx = host({ result });
    await expect(ctx.adapter.setReasoningEffort('web', 'high')).rejects.toMatchObject({ code: 'uncertain', statusCode: 409 });
    expect(ctx.writes).toHaveLength(1);
    expect(ctx.events.filter(event => event.type === 'item.complete' && (event.native as { source?: string })?.source === 'session/selectModel:selected')).toHaveLength(0);
  }
});

it('cached projections and lost native selection responses do not invent a successful control', async () => {
  const cached = host({ cached: true });
  await expect(cached.adapter.setReasoningEffort('web', 'high')).rejects.toMatchObject({ statusCode: 409 });
  expect(cached.writes).toEqual([]);
  const lost = host({ error: new Error('native response lost') });
  await expect(lost.adapter.setReasoningEffort('web', 'high')).rejects.toThrow('native response lost');
  expect(lost.events.filter(event => event.type === 'item.complete' && (event.native as { source?: string })?.source === 'session/selectModel:selected')).toHaveLength(0);
});

it('an observed native route change during catalog preflight cannot make a reasoning click select the old Provider', async () => {
  const ctx = host();
  const client = (ctx.adapter as unknown as { client: DshHostClient }).client; const rpc = client.rpc;
  let changed = false;
  client.rpc = async <T>(endpoint: string, args: Record<string, unknown>) => {
    if (endpoint === 'session/projections' && changed) return { asOfSeq: 3, values: { modelSelection: { lastUsed: null, next: { provider: 'one', model: 'same', reasoningEffort: 'low' } } } } as T;
    if (endpoint === 'session/modelCatalog' && !changed) { changed = true; await ctx.adapter.nativeState('web'); }
    return rpc<T>(endpoint, args);
  };
  await expect(ctx.adapter.setReasoningEffort('web', 'high')).rejects.toMatchObject({ statusCode: 409 });
  expect(ctx.writes).toEqual([]);
});
