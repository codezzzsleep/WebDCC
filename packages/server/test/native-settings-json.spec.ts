import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { DshSettingsView } from '@webdcc/protocol';
import { createTestApp } from './helpers.js';
import { settingsHost } from './fixtures/dsh-settings.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const host = await settingsHost(); cleanups.push(() => host.close());
  const ctx = await createTestApp(); cleanups.push(() => ctx.close());
  await ctx.dsh.save({ url: host.url, cookie: 'fixture-cookie', connectedAt: new Date().toISOString() });
  const view: DshSettingsView = (await ctx.app.inject({ url: '/api/dsh/provider', headers: { cookie: ctx.cookie } })).json();
  const input = { targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: 'target', model: 'b' };
  return { host, ctx, input };
}
const provider = (value: Record<string, unknown>) => (value['providers'] as Record<string, { models: Record<string, unknown>[] }>)['target']!;
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)]));
  return value;
}
async function evidence(name: string, value: unknown): Promise<void> {
  const directory = process.env['WDCC_SETTINGS_JSON_EVIDENCE_DIR'];
  if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
}

it('a successful native settings write remains confirmed when model and nested effort keys are reordered', async () => {
  const { host, ctx, input } = await setup(); const before = structuredClone(host.state);
  host.normalizeWrite(value => { provider(value).models = provider(value).models.map(model => reversed(model) as Record<string, unknown>); });
  const response = await ctx.app.inject({ method: 'PATCH', url: '/api/dsh/provider', headers: { cookie: ctx.cookie }, payload: { ...input, maxTokens: 444 } });
  await evidence('key-order-confirmation', { before, after: host.state, calls: host.calls, response: { status: response.statusCode, body: response.json() } });
  expect(response.statusCode).toBe(200);
  expect(response.json<DshSettingsView>().provider['models']).toEqual([
    { id: 'a', name: 'Model A', reasoningEfforts: { high: 'high' }, contextWindow: 111, unknown: 'keep A' },
    { id: 'b', name: 'Model B', reasoningEfforts: { low: 'low', high: 'high' }, maxTokens: 444, unknown: 'keep B' },
  ]);
  expect(host.calls.filter(call => call.method === 'settings/mutate')).toHaveLength(1);
  expect(host.state.namespaces[1]).toEqual(before.namespaces[1]);
});

it('equivalent nested effort maps are a no-op despite their property order', async () => {
  const { host, ctx, input } = await setup(); const before = structuredClone(host.state);
  const response = await ctx.app.inject({ method: 'PATCH', url: '/api/dsh/provider', headers: { cookie: ctx.cookie }, payload: { ...input, reasoningEfforts: ['high', 'low'] } });
  await evidence('key-order-noop', { before, after: host.state, calls: host.calls, response: { status: response.statusCode, body: response.json() } });
  expect(response.statusCode).toBe(200); expect(host.calls.filter(call => call.method === 'settings/mutate')).toHaveLength(0);
  expect(host.state).toEqual(before);
});

const different: { name: string; normalize: (value: Record<string, unknown>) => void }[] = [
  { name: 'number', normalize: value => { provider(value).models[1]!['maxTokens'] = 445; } },
  { name: 'type', normalize: value => { provider(value).models[1]!['maxTokens'] = '444'; } },
  { name: 'missing', normalize: value => { delete provider(value).models[1]!['maxTokens']; } },
  { name: 'null', normalize: value => { provider(value).models[1]!['maxTokens'] = null; } },
  { name: 'additional-field', normalize: value => { provider(value).models[1]!['changed'] = true; } },
  { name: 'array-order', normalize: value => { provider(value).models.reverse(); } },
];
it.each(different)('native $name changes still return explicit unconfirmed status', async ({ name, normalize }) => {
  const { host, ctx, input } = await setup(); host.normalizeWrite(normalize);
  const response = await ctx.app.inject({ method: 'PATCH', url: '/api/dsh/provider', headers: { cookie: ctx.cookie }, payload: { ...input, maxTokens: 444 } });
  await evidence(`unconfirmed-${name}`, { state: host.state, calls: host.calls, response: { status: response.statusCode, body: response.json() } });
  expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ error: expect.stringContaining('未确认') });
  expect(host.calls.filter(call => call.method === 'settings/mutate')).toHaveLength(1);
});
