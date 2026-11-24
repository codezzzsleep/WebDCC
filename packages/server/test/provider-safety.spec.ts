import type * as FsPromises from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderRegistry } from '../src/providers.js';
import { Store } from '../src/store.js';
import { openDb } from '../src/db.js';
import { createTestApp, type TestApp } from './helpers.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const clean of cleanup.splice(0)) await clean(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'provider-safety-'));
  const db = openDb(':memory:'); const store = new Store(db); const registry = new ProviderRegistry(store, dir);
  cleanup.push(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, registry };
}
const input = { name: 'fixture', baseUrl: 'https://fixture.invalid', protocols: ['openai-responses'], models: ['fixture'], apiKey: 'sk-wdcc-test-key-one' };

it.each(['{"secret":"private-fragment",', '[]', 'null', '1', '{"provider:one":7}', '{"__proto__":"unsafe"}', '{"constructor":"unsafe"}'])('rejects invalid vault without logging or overwriting content: %s', async raw => {
  const { dir, registry } = await fixture(); await writeFile(join(dir, 'secrets.json'), raw);
  const error = await registry.init().catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain('private-fragment');
  expect(await readFile(join(dir, 'secrets.json'), 'utf8')).toBe(raw);
});

it('initializes only missing vault, serializes concurrent registries and saves private keys across restart', async () => {
  const { dir, store, registry } = await fixture(); await registry.init();
  const other = new ProviderRegistry(store, dir); await other.init();
  const providers = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? registry : other).create({ ...input, apiKey: `sk-wdcc-test-${i}` })));
  expect(providers.map(p => registry.runtimeConfig(p.id)?.apiKey)).toEqual(Array.from({ length: 20 }, (_, i) => `sk-wdcc-test-${i}`));
  expect(providers.map(p => other.runtimeConfig(p.id)?.apiKey)).toEqual(Array.from({ length: 20 }, (_, i) => `sk-wdcc-test-${i}`));
  const restarted = new ProviderRegistry(store, dir); await restarted.init();
  expect(providers.map(p => restarted.runtimeConfig(p.id)?.apiKey)).toEqual(Array.from({ length: 20 }, (_, i) => `sk-wdcc-test-${i}`));
  expect((await stat(join(dir, 'secrets.json'))).mode & 0o777).toBe(0o600);
  expect((await readdir(dir)).some(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toBe(false);
});

it('SQL failure after atomic key staging preserves the old SQL reference and credential on restart; next write recovers', async () => {
  const { dir, store, registry } = await fixture(); await registry.init(); const p = await registry.create(input);
  const oldRef = store.getProvider(p.id)!.secretRef;
  const failure = vi.spyOn(store, 'updateProvider').mockImplementationOnce(() => { throw new Error('SQL unavailable'); });
  await expect(registry.update(p.id, { apiKey: 'sk-wdcc-test-key-two', name: 'new' })).rejects.toThrow('SQL unavailable');
  expect(store.getProvider(p.id)!.secretRef).toBe(oldRef);
  expect(registry.runtimeConfig(p.id)?.apiKey).toBe('sk-wdcc-test-key-one');
  const restarted = new ProviderRegistry(store, dir); await restarted.init();
  expect(restarted.runtimeConfig(p.id)?.apiKey).toBe('sk-wdcc-test-key-one');
  failure.mockRestore(); await restarted.update(p.id, { apiKey: 'sk-wdcc-test-key-three' });
  const again = new ProviderRegistry(store, dir); await again.init();
  expect(again.runtimeConfig(p.id)?.apiKey).toBe('sk-wdcc-test-key-three');
  await again.update(p.id, { apiKey: '' });
  expect(again.runtimeConfig(p.id)?.apiKey).toBeUndefined();
});

it('an interrupted writer lock rejects new writes without changing SQL or vault, and explicit recovery allows retry', async () => {
  const { dir, store, registry } = await fixture(); await registry.init(); const p = await registry.create(input);
  const before = await readFile(join(dir, 'secrets.json'), 'utf8');
  await writeFile(join(dir, 'secrets.json.lock'), '');
  await expect(registry.update(p.id, { apiKey: 'sk-wdcc-test-key-two' })).rejects.toMatchObject({ statusCode: 409 });
  expect(await readFile(join(dir, 'secrets.json'), 'utf8')).toBe(before);
  expect(store.getProvider(p.id)?.name).toBe('fixture');
  await rm(join(dir, 'secrets.json.lock')); await registry.update(p.id, { apiKey: 'sk-wdcc-test-key-two' });
  expect(registry.runtimeConfig(p.id)?.apiKey).toBe('sk-wdcc-test-key-two');
});

it('read IO failure after init fails closed and leaves existing SQL/key state intact', async () => {
  const { dir, store, registry } = await fixture(); await registry.init(); const p = await registry.create(input);
  await rm(join(dir, 'secrets.json'));
  await expect(registry.update(p.id, { name: 'changed' })).rejects.toThrow('无法读取');
  expect(store.getProvider(p.id)?.name).toBe('fixture'); expect(() => registry.runtimeConfig(p.id)).toThrow('拒绝使用过期凭据');
});

it('DELETE rejects bound Providers before removing key, keeps session route/history and permits unused deletion', async () => {
  const ctx: TestApp = await createTestApp(); cleanup.push(ctx.close);
  const p = (await ctx.app.inject({ method: 'POST', url: '/api/providers', headers: { cookie: ctx.cookie }, payload: input })).json<{ id: string }>();
  const w = ctx.store.createWorkspace('w', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: w.id, agent: 'codex', providerId: p.id });
  ctx.store.appendEvent({ sessionId: session.id, turnId: 'turn', itemKey: 'message', kind: 'assistant.message', data: { text: 'retained' } });
  const before = await readFile(join(ctx.dataDir, 'secrets.json'), 'utf8');
  const result = await ctx.app.inject({ method: 'DELETE', url: `/api/providers/${p.id}`, headers: { cookie: ctx.cookie } });
  expect(result.statusCode).toBe(409); expect(ctx.store.getSession(session.id)?.providerId).toBe(p.id);
  expect(ctx.store.allEvents(session.id)).toHaveLength(1); expect(await readFile(join(ctx.dataDir, 'secrets.json'), 'utf8')).toBe(before);
  expect(() => ctx.store.deleteProvider(p.id)).toThrow('无法删除');
  const unused = (await ctx.app.inject({ method: 'POST', url: '/api/providers', headers: { cookie: ctx.cookie }, payload: input })).json<{ id: string }>();
  expect((await ctx.app.inject({ method: 'DELETE', url: `/api/providers/${unused.id}`, headers: { cookie: ctx.cookie } })).statusCode).toBe(204);
  expect(ctx.store.getProvider(unused.id)).toBeUndefined();
});

it('atomic rename failure preserves the original vault and SQL, then recovers without a stale in-memory key', async () => {
  const { dir, store, registry } = await fixture(); await registry.init(); const p = await registry.create(input);
  const before = await readFile(join(dir, 'secrets.json'), 'utf8');
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('fixture rename failure'), { code: 'EIO' }));
  await expect(registry.update(p.id, { apiKey: 'sk-wdcc-test-failed', name: 'changed' })).rejects.toThrow('fixture rename failure');
  expect(await readFile(join(dir, 'secrets.json'), 'utf8')).toBe(before);
  expect(store.getProvider(p.id)?.name).toBe('fixture'); expect(registry.runtimeConfig(p.id)?.apiKey).toBe('sk-wdcc-test-key-one');
  expect((await readdir(dir)).some(name => name.endsWith('.tmp'))).toBe(false);
  await registry.update(p.id, { apiKey: 'sk-wdcc-test-recovered' });
  expect(registry.runtimeConfig(p.id)?.apiKey).toBe('sk-wdcc-test-recovered');
});
