import { afterEach, expect, it } from 'vitest';
import type { DshSettingsView } from '@webdcc/protocol';
import { createTestApp } from './helpers.js';
import { settingsHost } from './fixtures/dsh-settings.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup() {
  const host = await settingsHost(); cleanups.push(() => host.close());
  const ctx = await createTestApp(); cleanups.push(() => ctx.close());
  let runtime: { url: string; browserCookie: string; connectedAt: string } | null = {
    url: host.url, browserCookie: 'fixture-cookie', connectedAt: '2026-11-28T12:00:00Z',
  };
  Object.assign(ctx.manager.adapter('dsh')!, { nativeBrowserConnection: () => runtime });
  const get = (url: string) => ctx.app.inject({ url, headers: { cookie: ctx.cookie } });
  return { ctx, host, get, stop: () => { runtime = null; }, replace: () => { runtime = { ...runtime!, connectedAt: '2026-11-28T12:01:00Z' }; } };
}

it('an owned running DSH exposes its Provider and native revision edits without creating an attach record', async () => {
  const { ctx, host, get } = await setup();
  expect((await get('/api/dsh')).json()).toMatchObject({ mode: 'spawn', connected: true, url: host.url });
  const response = await get('/api/dsh/provider');
  expect(response.statusCode).toBe(200);
  const view = response.json<DshSettingsView>();
  const update = await ctx.app.inject({ method: 'PATCH', url: '/api/dsh/provider', headers: { cookie: ctx.cookie }, payload: {
    targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: 'target', model: 'b', maxTokens: 444,
  } });
  expect(update.statusCode).toBe(200);
  expect((update.json<DshSettingsView>().provider['models'] as { id: string; maxTokens?: number }[]).find(model => model.id === 'b')?.maxTokens).toBe(444);
  expect(ctx.dsh.connection).toBeNull();
  expect((await get('/api/dsh')).body).not.toContain('fixture-cookie');
});

it('an installed but stopped owned Host stays disconnected and does not use a stale attach record', async () => {
  const { ctx, host, get, stop } = await setup();
  await ctx.dsh.save({ url: host.url, cookie: 'stale-attach', connectedAt: '2026-11-27T12:00:00Z' });
  stop();
  expect((await get('/api/dsh')).json()).toMatchObject({ mode: 'spawn', connected: false, url: null });
  expect((await get('/api/dsh/provider')).statusCode).toBe(503);
  expect(host.calls).toEqual([]);
});

it('replacing the owned Host invalidates an earlier Provider editor before writing', async () => {
  const { ctx, host, get, replace } = await setup();
  const view = (await get('/api/dsh/provider')).json<DshSettingsView>();
  replace();
  const response = await ctx.app.inject({ method: 'PATCH', url: '/api/dsh/provider', headers: { cookie: ctx.cookie }, payload: {
    targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: 'target', model: 'b', maxTokens: 444,
  } });
  expect(response.statusCode).toBe(409);
  expect(host.calls.filter(call => call.method === 'settings/mutate')).toEqual([]);
});
