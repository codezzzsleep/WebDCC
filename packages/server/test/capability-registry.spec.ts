import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CapabilityRegistry, frozenNativeInventory } from '../src/capability-registry.js';
import manifest from '../src/native-inventory.json' with { type: 'json' };
import { createTestApp } from './helpers.js';

describe('NP-01 frozen capabilities', () => {
  it('classifies every pinned native method and keeps native surfaces in scope', () => {
    const schema = JSON.parse(readFileSync(manifest.sources.codex.path, 'utf8')) as { definitions: Record<string, { oneOf: { properties: { method: { enum: string[] } } }[] }> };
    const codex = frozenNativeInventory.filter(entry => entry.agent === 'codex').map(entry => entry.method);
    for (const name of ['ClientRequest', 'ServerRequest', 'ServerNotification']) {
      for (const method of schema.definitions[name]?.oneOf.map(branch => branch.properties.method.enum[0]) ?? []) expect(codex).toContain(method);
    }
    const catalog = JSON.parse(readFileSync(manifest.sources.dsh.path, 'utf8')) as { endpoints: Record<string, unknown> };
    expect(frozenNativeInventory.filter(entry => entry.agent === 'dsh' && entry.method !== 'native-web-surface').map(entry => entry.method).sort()).toEqual(Object.keys(catalog.endpoints).sort());
    expect(frozenNativeInventory.every(entry => entry.capabilityId && (entry.role !== 'internal' || entry.reason))).toBe(true);
    for (const source of [manifest.sources.codex, manifest.sources.dsh]) expect(createHash('sha256').update(readFileSync(source.path)).digest('hex')).toBe(source.sha256);
    expect(frozenNativeInventory.filter(entry => entry.method.startsWith('native-'))).toHaveLength(3);
    expect(frozenNativeInventory).toContainEqual({ agent: 'claude-code', method: 'Options.permissionMode', role: 'action', capabilityId: 'claude-code.configuration' });
  });

  it('never counts fake runtime or inventory presence as verified implementation', async () => {
    const ctx = await createTestApp();
    try {
      const registry = new CapabilityRegistry(ctx.store, ctx.manager);
      const first = await registry.snapshot();
      expect(first.runtimes.every(runtime => runtime.compatibility === 'test-only')).toBe(true);
      expect(first.capabilities.every(capability => !capability.structuredVerified && !capability.fallbackVerified)).toBe(true);
      expect((await registry.snapshot()).revision).toBe(first.revision);
      await expect(registry.assertRevision(first.revision)).resolves.toHaveProperty('revision', first.revision);
      const adapter = ctx.manager.adaptersList()[0];
      if (adapter === undefined) throw new Error('test adapter missing');
      const probe = await adapter.probe();
      adapter.probe = async () => ({ ...probe, version: 'changed' });
      await expect(registry.assertRevision(first.revision)).rejects.toMatchObject({ statusCode: 409 });
      expect((await ctx.app.inject({ url: `/api/capabilities?revision=${first.revision}`, headers: { cookie: ctx.cookie } })).statusCode).toBe(409);
      expect((await ctx.app.inject({ url: '/api/capabilities' })).statusCode).toBe(401);
    } finally { await ctx.close(); }
  });
});
