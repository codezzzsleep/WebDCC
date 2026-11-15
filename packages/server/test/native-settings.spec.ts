import { afterEach, expect, it } from 'vitest';
import type { DshProviderUpdate, DshSettingsView } from '@webdcc/protocol';
import { createTestApp } from './helpers.js';
import { settingsHost } from './fixtures/dsh-settings.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const host = await settingsHost(); cleanups.push(() => host.close());
  const ctx = await createTestApp(); cleanups.push(() => ctx.close());
  await ctx.dsh.save({ url: host.url, cookie: 'fixture-cookie', connectedAt: new Date().toISOString() });
  const view: DshSettingsView = (await ctx.app.inject({ url: '/api/dsh/provider', headers: { cookie: ctx.cookie } })).json();
  const input: DshProviderUpdate = { targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: 'target', model: 'b' };
  const patch = (value: unknown, url = '/api/dsh/provider') => ctx.app.inject({ method: 'PATCH', url, headers: { cookie: ctx.cookie }, payload: value as object });
  return { host, ctx, view, input, patch };
}

it('NP-12 a preview is read-only and editing model B preserves A, its name, omitted effort, other providers and the default model', async () => {
  const { host, ctx, input, patch } = await setup();
  const before = structuredClone(host.state);
  const payload = { ...input, contextWindow: 333 };
  const preview = await ctx.app.inject({ method: 'POST', url: '/api/dsh/provider/preview', headers: { cookie: ctx.cookie }, payload });
  expect(preview.statusCode).toBe(200);
  expect(preview.json()).toMatchObject({ target: { url: host.url, scope: 'host-profile' }, changes: [{ path: ['providers', 'target', 'models', '1'] }] });
  expect(host.state).toEqual(before);
  const response = await patch(payload);
  expect(response.statusCode).toBe(200);
  const current = response.json<DshSettingsView>();
  expect(current.provider['models']).toEqual([
    { id: 'a', name: 'Model A', reasoningEfforts: { high: 'high' }, contextWindow: 111, unknown: 'keep A' },
    { id: 'b', name: 'Model B', reasoningEfforts: { low: 'low', high: 'high' }, contextWindow: 333, maxTokens: 222, unknown: 'keep B' },
  ]);
  expect(current.defaultModel).toEqual({ provider: 'target', model: 'a', reasoningEffort: 'high' });
  expect(host.state.namespaces[1]).toEqual(before.namespaces[1]);
  expect((host.state.namespaces[0]!.value['providers'] as Record<string, unknown>)['other']).toEqual((before.namespaces[0]!.value['providers'] as Record<string, unknown>)['other']);
  expect(host.calls.filter(call => call.method === 'settings/mutate')).toHaveLength(1);
});

it('NP-12 stale browser revisions and changed Host identity return 409 without native writes', async () => {
  const { ctx, host, view, input, patch } = await setup();
  host.state.namespaces[0]!.revision++;
  expect((await patch({ ...input, maxTokens: 444 })).statusCode).toBe(409);
  expect((await patch({ providerKey: 'target', model: 'b', expectedRevision: 2 })).statusCode).toBe(400);
  await ctx.dsh.save({ url: host.url, cookie: 'new-fixture-cookie', connectedAt: '2026-11-14T12:00:00Z' });
  expect((await patch({ ...input, expectedRevision: view.providerRevision + 1, maxTokens: 444 })).statusCode).toBe(409);
  expect(host.calls.filter(call => call.method === 'settings/mutate')).toEqual([]);
});

it('NP-12 concurrent native writes use the reviewed revision and a native CAS refusal returns 409', async () => {
  const { host, input, patch } = await setup();
  const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => patch({ ...input, maxTokens: 500 + i })));
  expect(responses.filter(response => response.statusCode === 200)).toHaveLength(1);
  expect(responses.filter(response => response.statusCode === 409)).toHaveLength(9);
  expect(host.state.namespaces[0]!.revision).toBe(2);
  expect(host.state.namespaces[1]!.revision).toBe(1);
});

it('NP-12 renames preserve unknown fields, duplicate IDs are refused, and the current default cannot be left dangling', async () => {
  const { input, patch } = await setup();
  expect((await patch({ ...input, previousModel: 'b', model: 'a' })).statusCode).toBe(409);
  expect((await patch({ ...input, previousModel: 'a', model: 'c' })).statusCode).toBe(409);
  const response = await patch({ ...input, previousModel: 'b', model: 'c' });
  expect(response.statusCode).toBe(200);
  expect((response.json<DshSettingsView>().provider['models'] as object[])[1]).toMatchObject({ id: 'c', name: 'Model B', unknown: 'keep B' });
});

it('NP-12 changing the default is a separate single-namespace action that preserves omitted reasoning', async () => {
  const { host, view, patch } = await setup();
  const before = structuredClone(host.state.namespaces[0]);
  const response = await patch({ targetId: view.target.id, expectedRevision: view.defaultModelRevision, providerKey: 'target', model: 'b' }, '/api/dsh/default-model');
  expect(response.statusCode).toBe(200);
  expect(response.json<DshSettingsView>().defaultModel).toEqual({ provider: 'target', model: 'b', reasoningEffort: 'high' });
  expect(host.state.namespaces[0]).toEqual(before);
  expect(host.calls.filter(call => call.method === 'settings/mutate')).toMatchObject([{ args: { ns: 'agent-default-model', ops: [{ op: 'set', path: ['model'], value: 'b' }] } }]);
});

it('NP-12 hidden credentials are never restated in array writes or previews', async () => {
  const { host, ctx, input, patch } = await setup();
  host.state.namespaces[0]!.secrets.push({ path: ['providers', 'target', 'models', '0', 'apiKey'], set: true });
  const payload = { ...input, maxTokens: 444 };
  expect((await ctx.app.inject({ method: 'POST', url: '/api/dsh/provider/preview', headers: { cookie: ctx.cookie }, payload })).statusCode).toBe(409);
  expect((await patch(payload)).statusCode).toBe(409);
  expect((await patch({ ...input, apiKey: 'fixture-secret' })).statusCode).toBe(400);
  expect(host.calls.filter(call => call.method === 'settings/mutate')).toEqual([]);
});

it('NP-12 an acknowledged native write with an unchanged live value is unconfirmed, and a rejected write preserves config', async () => {
  const { host, input, patch } = await setup();
  const before = structuredClone(host.state);
  host.ignoreWrites(true);
  const response = await patch({ ...input, maxTokens: 444 });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ error: expect.stringContaining('未确认') });
  expect(host.state).toEqual(before);
  host.ignoreWrites(false); host.rejectWrites(true);
  expect((await patch({ ...input, maxTokens: 444 })).statusCode).toBe(409);
  expect(host.state).toEqual(before);
});

it('NP-12 explicit resets remove only selected model overrides and Provider fields do not affect global defaults', async () => {
  const { host, input, patch } = await setup();
  const before = structuredClone(host.state.namespaces[1]);
  const response = await patch({ ...input, reasoningEfforts: null, maxTokens: null, baseURL: 'https://changed.example/v1' });
  expect(response.statusCode).toBe(200);
  expect((response.json<DshSettingsView>().provider['models'] as Record<string, unknown>[])[1]).toEqual({ id: 'b', name: 'Model B', unknown: 'keep B' });
  expect(host.state.namespaces[1]).toEqual(before);
  expect(host.calls.filter(call => call.method === 'settings/mutate')).toHaveLength(1);
});
