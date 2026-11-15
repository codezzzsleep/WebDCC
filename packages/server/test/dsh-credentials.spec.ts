import { afterEach, expect, it } from 'vitest';
import type { DshSettingsView } from '@webdcc/protocol';
import { createTestApp } from './helpers.js';
import { settingsHost } from './fixtures/dsh-settings.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const host = await settingsHost(); cleanup.push(() => host.close());
  const ctx = await createTestApp(); cleanup.push(() => ctx.close());
  await ctx.dsh.save({ url: host.url, cookie: 'fixture-cookie', connectedAt: '2026-11-15T00:00:00Z' });
  const read = async (providerKey?: string) => (await ctx.app.inject({ url: `/api/dsh/provider${providerKey === undefined ? '' : `?providerKey=${providerKey}`}`, headers: { cookie: ctx.cookie } })).json<DshSettingsView>();
  const send = (url: string, payload: object, method: 'POST' | 'PATCH' = 'PATCH') => ctx.app.inject({ method, url, payload, headers: { cookie: ctx.cookie } });
  return { host, ctx, read, send, view: await read() };
}

it('a new Provider uses the explicit reference without changing other config, credentials or defaults', async () => {
  const { host, view, read, send } = await setup();
  const before = structuredClone(host.state);
  const input = { targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: 'new', model: 'new-model', api: 'openai-completions', baseURL: 'https://new.example/v1', apiKeyEnv: 'DEDICATED_REVIEW_KEY' };
  expect((await send('/api/dsh/provider/create-preview', input, 'POST')).statusCode).toBe(200);
  expect(host.state).toEqual(before);
  const created = await send('/api/dsh/provider', input, 'POST'); expect(created.statusCode).toBe(200);
  const current = created.json<DshSettingsView>();
  expect(current.provider).toMatchObject({ apiKeyEnv: 'DEDICATED_REVIEW_KEY', models: [{ id: 'new-model' }] });
  expect(current.defaultModel).toEqual(view.defaultModel);
  const secret = 'only a fixture secret';
  const result = await send('/api/dsh/provider/credential', { targetId: current.target.id, expectedRevision: current.providerRevision, providerKey: 'new', apiKeyEnv: 'DEDICATED_REVIEW_KEY', apiKey: secret });
  expect(result.statusCode).toBe(200); expect(result.body).not.toContain(secret);
  expect(host.credentials.get('DEDICATED_REVIEW_KEY')).toBe(secret);
  expect(host.credentials.get('FIXTURE_KEY')).toBe('original fixture key');
  expect(host.credentials.get('OTHER_KEY')).toBe('other fixture key');
  expect((await read('new')).provider['apiKeyEnv']).toBe('DEDICATED_REVIEW_KEY');
  expect(host.calls.find(call => call.method === 'credentials/set')).toMatchObject({ args: { ref: 'DEDICATED_REVIEW_KEY', value: secret } });
});

it('changing a reference is previewed and CAS-written; omitted refs stay unchanged', async () => {
  const { host, view, read, send } = await setup();
  const input = { targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: 'target', model: 'b', apiKeyEnv: 'TARGET_NEW_KEY' };
  const before = structuredClone(host.state);
  const preview = await send('/api/dsh/provider/preview', input, 'POST');
  expect(preview.json()).toMatchObject({ changes: [{ path: ['providers', 'target', 'apiKeyEnv'], before: 'FIXTURE_KEY', after: 'TARGET_NEW_KEY' }] });
  expect(host.state).toEqual(before);
  expect((await send('/api/dsh/provider', input)).statusCode).toBe(200);
  const current = await read();
  expect((await send('/api/dsh/provider', { ...input, expectedRevision: current.providerRevision, apiKeyEnv: undefined, maxTokens: 333 })).statusCode).toBe(200);
  expect((await read()).provider['apiKeyEnv']).toBe('TARGET_NEW_KEY');
  expect(host.calls.filter(call => call.method === 'credentials/set')).toEqual([]);
});

it('shared refs, missing new refs and invalid names are refused without credential writes', async () => {
  const { host, view, send } = await setup();
  const providers = host.state.namespaces[0]!.value['providers'] as Record<string, Record<string, unknown>>;
  providers['other']!['apiKeyEnv'] = 'OTHER_KEY';
  const common = { targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: 'target', model: 'b' };
  expect((await send('/api/dsh/provider', { ...common, apiKeyEnv: 'OTHER_KEY' })).statusCode).toBe(409);
  expect((await send('/api/dsh/provider', { ...common, apiKeyEnv: 'bad ref' })).statusCode).toBe(400);
  expect((await send('/api/dsh/provider', { ...common, providerKey: 'new', baseURL: 'https://new.example', api: 'openai-completions' }, 'POST')).statusCode).toBe(400);
  providers['other']!['apiKeyEnv'] = 'FIXTURE_KEY';
  expect((await send('/api/dsh/provider/credential', { targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: 'target', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'new fixture key' })).statusCode).toBe(409);
  expect(host.calls.filter(call => call.method === 'credentials/set')).toEqual([]);
  expect(host.credentials.get('FIXTURE_KEY')).toBe('original fixture key');
});

it('stale revisions, changed refs and changed Host identities refuse key writes', async () => {
  const { host, ctx, view, send } = await setup();
  const input = { targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: 'target', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'new fixture key' };
  expect((await send('/api/dsh/provider/credential', { ...input, apiKeyEnv: 'WRONG_REF' })).statusCode).toBe(409);
  host.state.namespaces[0]!.revision++;
  expect((await send('/api/dsh/provider/credential', input)).statusCode).toBe(409);
  await ctx.dsh.save({ url: host.url, cookie: 'fixture-cookie', connectedAt: '2026-11-15T00:01:00Z' });
  expect((await send('/api/dsh/provider/credential', { ...input, expectedRevision: 2 })).statusCode).toBe(409);
  expect(host.calls.filter(call => call.method === 'credentials/set')).toEqual([]);
});

it('native credential errors cannot echo the secret or trigger a local credential fallback', async () => {
  const { host, view, send } = await setup(); host.rejectCredentials(true);
  const secret = 'native error must not expose this fixture';
  const result = await send('/api/dsh/provider/credential', { targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: 'target', apiKeyEnv: 'FIXTURE_KEY', apiKey: secret });
  expect(result.statusCode).toBe(502); expect(result.body).not.toContain(secret);
  expect(host.credentials.get('FIXTURE_KEY')).toBe('original fixture key');
  expect(host.credentials.get('OTHER_KEY')).toBe('other fixture key');
});

it('a reviewed reference cannot be switched by another WebDCC write while its key is being saved', async () => {
  const { host, view, send, read } = await setup();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  host.beforeCredentialSet(async () => { entered(); await gate; });
  const key = send('/api/dsh/provider/credential', { targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: 'target', apiKeyEnv: 'FIXTURE_KEY', apiKey: 'concurrent fixture key' });
  await ready;
  const binding = send('/api/dsh/provider', { targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: 'target', model: 'b', apiKeyEnv: 'TARGET_NEW_KEY' });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(host.calls.filter(call => call.method === 'settings/mutate')).toEqual([]);
  release();
  expect((await key).statusCode).toBe(200); expect((await binding).statusCode).toBe(200);
  expect(host.credentials.get('FIXTURE_KEY')).toBe('concurrent fixture key');
  expect(host.credentials.has('TARGET_NEW_KEY')).toBe(false);
  expect((await read()).provider['apiKeyEnv']).toBe('TARGET_NEW_KEY');
  expect(host.credentials.get('OTHER_KEY')).toBe('other fixture key');
});

it('splitting a legacy shared reference leaves the other Provider and its original key intact', async () => {
  const { host, view, read, send } = await setup();
  const providers = host.state.namespaces[0]!.value['providers'] as Record<string, Record<string, unknown>>;
  providers['other']!['apiKeyEnv'] = 'FIXTURE_KEY'; const other = structuredClone(providers['other']);
  expect((await send('/api/dsh/provider', { targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: 'target', model: 'b', apiKeyEnv: 'TARGET_ONLY_KEY' })).statusCode).toBe(200);
  const current = await read();
  expect((await send('/api/dsh/provider/credential', { targetId: current.target.id, expectedRevision: current.providerRevision, providerKey: 'target', apiKeyEnv: 'TARGET_ONLY_KEY', apiKey: 'isolated fixture key' })).statusCode).toBe(200);
  expect(host.credentials.get('FIXTURE_KEY')).toBe('original fixture key');
  expect(host.credentials.get('TARGET_ONLY_KEY')).toBe('isolated fixture key');
  expect((host.state.namespaces[0]!.value['providers'] as Record<string, unknown>)['other']).toEqual(other);
});

it('native schema defaults may enrich new providers, but must not replace the requested reference', async () => {
  const { host, view, send } = await setup();
  const input = { targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: 'new', model: 'new-model', api: 'openai-completions', baseURL: 'https://new.example/v1', apiKeyEnv: 'DEDICATED_KEY' };
  host.normalizeWrite(value => { const provider = (value['providers'] as Record<string, Record<string, unknown>>)['new']!; provider['defaultInput'] = ['text']; (provider['models'] as Record<string, unknown>[])[0]!['input'] = []; });
  expect((await send('/api/dsh/provider', input, 'POST')).statusCode).toBe(200);
  host.normalizeWrite(value => { (value['providers'] as Record<string, Record<string, unknown>>)['wrong']!['apiKeyEnv'] = 'OPENAI_API_KEY'; });
  expect((await send('/api/dsh/provider', { ...input, providerKey: 'wrong', expectedRevision: 2 }, 'POST')).statusCode).toBe(409);
  expect(host.calls.filter(call => call.method === 'credentials/set')).toHaveLength(0);
});
