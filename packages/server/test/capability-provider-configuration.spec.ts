import type { CapabilitySnapshot } from '@webdcc/protocol';
import { expect, it } from 'vitest';
import { CapabilityRegistry } from '../src/capability-registry.js';
import { createTestApp } from './helpers.js';

it.each([
  { name: 'legacy base URL', patch: { baseUrl: 'https://changed.example.test/v1' } },
  { name: 'protocol-specific endpoint', patch: { endpoints: JSON.stringify({ 'openai-responses': 'https://changed.example.test/responses' }) } },
  { name: 'enabled protocols', patch: { protocols: ['anthropic-messages'] } },
  { name: 'native model catalog path', patch: { codexCatalogPath: '/controlled/catalog-two.json' } },
])('invalidates the authenticated capability revision after changing $name with the same model IDs', async ({ patch }) => {
  const ctx = await createTestApp();
  try {
    ctx.store.createProvider({ id: 'provider-config-revision', name: 'Controlled provider',
      baseUrl: 'https://original.example.test/v1', endpoints: JSON.stringify({ 'openai-responses': 'https://original.example.test/responses' }),
      protocols: ['openai-responses'], models: ['same-model'], secretRef: 'controlled-unset-key',
      codexCatalogPath: '/controlled/catalog-one.json' });
    const registry = new CapabilityRegistry(ctx.store, ctx.manager);
    const get = (revision?: string) => ctx.app.inject({ url: `/api/capabilities${revision === undefined ? '' : `?revision=${revision}`}`, headers: { cookie: ctx.cookie } });
    const before = (await get()).json<CapabilitySnapshot>();
    expect((await get(before.revision)).statusCode).toBe(200);
    expect(ctx.store.updateProvider('provider-config-revision', patch)).toMatchObject(patch);
    const fresh = (await get()).json<CapabilitySnapshot>();
    const stale = await get(before.revision);
    expect(stale.statusCode).toBe(409);
    expect(fresh.revision).not.toBe(before.revision);
    await expect(registry.assertRevision(before.revision)).rejects.toMatchObject({ statusCode: 409, code: 'capability-stale' });
    expect((await get(fresh.revision)).statusCode).toBe(200);
    expect(fresh.runtimes.every(runtime => runtime.compatibility === 'test-only')).toBe(true);
    expect(fresh.capabilities.every(capability => !capability.structuredVerified && !capability.fallbackVerified)).toBe(true);
  } finally { await ctx.close(); }
});

it('keeps stable and display-only changes usable while existing model changes still invalidate the revision', async () => {
  const ctx = await createTestApp();
  try {
    ctx.store.createProvider({ id: 'stable-provider-config', name: 'Original label', baseUrl: 'https://original.example.test/v1',
      protocols: ['openai-responses'], models: ['original-model'], secretRef: 'controlled-private-reference', codexCatalogPath: null });
    const registry = new CapabilityRegistry(ctx.store, ctx.manager);
    const before = await registry.snapshot();
    expect((await registry.snapshot()).revision).toBe(before.revision);
    ctx.store.updateProvider('stable-provider-config', { name: 'New display label' });
    await expect(registry.assertRevision(before.revision)).resolves.toHaveProperty('revision', before.revision);
    expect(JSON.stringify(before)).not.toContain('controlled-private-reference');
    expect(JSON.stringify(before)).not.toContain('original.example.test');
    ctx.store.updateProvider('stable-provider-config', { models: ['changed-model'] });
    await expect(registry.assertRevision(before.revision)).rejects.toMatchObject({ statusCode: 409 });
    const changed = await registry.snapshot();
    ctx.store.updateProvider('stable-provider-config', { modelDetails: [{ id: 'changed-model', name: 'Changed model', reasoningEfforts: ['high'] }] });
    await expect(registry.assertRevision(changed.revision)).rejects.toMatchObject({ statusCode: 409 });
  } finally { await ctx.close(); }
});
