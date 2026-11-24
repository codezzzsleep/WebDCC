import { afterEach, expect, it } from 'vitest';
import type { AgentAdapter, ProviderRuntimeConfig } from '@webdcc/protocol';
import { FakeAdapter } from '../../testing/fake-adapter/src/index.js';
import { createTestApp, type TestApp } from './helpers.js';
let ctx: TestApp | undefined;
afterEach(async () => { await ctx?.close(); ctx = undefined; });

it('legacy Provider models discover their own native efforts/default/modalities without persisting capabilities or borrowing another Provider', async () => {
  ctx = await createTestApp(); const app = ctx;
  const calls: ProviderRuntimeConfig[] = [];
  const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' });
  adapter.listModels = async (id, provider) => {
    expect(provider?.id).toBe(id); calls.push(provider!);
    return [{ id: 'same', label: 'Native label', reasoningEfforts: provider?.name === 'One' ? ['low', 'ultra'] : ['high'],
      defaultReasoningEffort: provider?.name === 'One' ? 'low' : 'high', inputModalities: ['text', 'image'], source: 'codex:0.172.0:model/list' }];
  };
  app.manager.registerAdapter(adapter);
  const create = async (name: string) => (await app.app.inject({ method: 'POST', url: '/api/providers', headers: { cookie: app.cookie },
    payload: { name, baseUrl: `https://${name.toLowerCase()}.invalid/v1`, protocols: ['openai-responses'], models: ['same', 'unknown'], apiKey: `fixture-${name}` } })).json<{id: string}>();
  const one = await create('One'); const two = await create('Two');
  const read = async (id: string) => (await app.app.inject({ method: 'GET', url: `/api/models?agent=codex&providerId=${id}`, headers: { cookie: app.cookie } })).json();
  const first = await read(one.id); const second = await read(two.id);
  expect(first.options[0]).toMatchObject({ id: 'same', reasoningEfforts: ['low', 'ultra'], defaultReasoningEffort: 'low', inputModalities: ['text', 'image'] });
  expect(second.options[0]).toMatchObject({ id: 'same', reasoningEfforts: ['high'], defaultReasoningEffort: 'high' });
  expect(first.options[1]).toEqual({ id: 'unknown', label: 'unknown', source: 'provider-config' });
  expect(calls.map(p => [p.id, p.apiKey])).toEqual([[one.id, 'fixture-One'], [two.id, 'fixture-Two']]);
  expect(JSON.stringify(first)).not.toContain('fixture-One');
  expect(app.store.listProviders().find(p => p.id === one.id)?.modelDetails.every(m => m.reasoningEfforts === undefined)).toBe(true);
});

it('explicit Provider choices including empty levels remain authoritative when native lookup fails or differs', async () => {
  ctx = await createTestApp(); const app = ctx;
  const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' });
  adapter.listModels = async () => [{ id: 'same', label: 'Native', reasoningEfforts: ['ultra'] }, { id: 'plain', label: 'Plain', reasoningEfforts: ['low'] }];
  app.manager.registerAdapter(adapter);
  const provider = (await app.app.inject({ method: 'POST', url: '/api/providers', headers: { cookie: app.cookie }, payload: {
    name: 'Manual', baseUrl: 'https://manual.invalid', protocols: ['openai-responses'], models: ['same','plain','unknown'],
    modelDetails: [{ id: 'same', name: 'Manual same', reasoningEfforts: ['high'] }, { id: 'plain', name: 'Manual plain', reasoningEfforts: [] }],
  } })).json<{ id: string }>();
  const read = async () => (await app.app.inject({ method: 'GET', url: `/api/models?agent=codex&providerId=${provider.id}`, headers: { cookie: app.cookie } })).json();
  expect((await read()).options.map((m: { reasoningEfforts?: string[] }) => m.reasoningEfforts)).toEqual([['high'], [], undefined]);
  adapter.listModels = async () => { throw new Error('Native unavailable'); };
  expect((await read()).options).toEqual([
    { id: 'same', label: 'Manual same', reasoningEfforts: ['high'], source: 'provider-config' },
    { id: 'plain', label: 'Manual plain', reasoningEfforts: [], source: 'provider-config' },
    { id: 'unknown', label: 'unknown', source: 'provider-config' },
  ]);
});

it('configuration changes are read again and incompatible or missing Providers never launch native discovery', async () => {
  ctx = await createTestApp(); const app = ctx; const calls: string[] = [];
  const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' });
  adapter.listModels = async (_id, provider) => { calls.push(provider!.baseUrl); return [{ id: 'same', label: 'same', reasoningEfforts: provider?.baseUrl.includes('updated') ? ['ultra'] : ['low'] }]; };
  app.manager.registerAdapter(adapter);
  const created = (await app.app.inject({ method: 'POST', url: '/api/providers', headers: { cookie: app.cookie }, payload: {
    name: 'Changing', baseUrl: 'https://before.invalid', protocols: ['openai-responses'], models: ['same'],
  } })).json<{ id: string }>();
  const read = async () => (await app.app.inject({ method: 'GET', url: `/api/models?agent=codex&providerId=${created.id}`, headers: { cookie: app.cookie } })).json();
  expect((await read()).options[0].reasoningEfforts).toEqual(['low']);
  await app.app.inject({ method: 'PATCH', url: `/api/providers/${created.id}`, headers: { cookie: app.cookie }, payload: { baseUrl: 'https://updated.invalid' } });
  expect((await read()).options[0].reasoningEfforts).toEqual(['ultra']);
  await app.app.inject({ method: 'PATCH', url: `/api/providers/${created.id}`, headers: { cookie: app.cookie }, payload: { protocols: ['anthropic-messages'] } });
  expect(await read()).toEqual({ models: [], options: [] });
  expect(calls).toEqual(['https://before.invalid','https://updated.invalid']);
});
