import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../adapters/codex/src/adapter.js';
import type { CapabilitySnapshot, ProbeResult } from '@webdcc/protocol';
import { CapabilityRegistry, frozenNativeInventory } from '../src/capability-registry.js';
import manifest from '../src/native-inventory.json' with { type: 'json' };
import { createTestApp } from './helpers.js';

describe('NP-01 frozen capabilities', () => {
  it.each([
    { version: '0.167.0', compatible: true, expected: 'compatible' },
    { version: '0.168.0', compatible: true, expected: 'compatible' },
    { version: '0.169.0', compatible: true, expected: 'compatible' },
    { version: '0.170.0', compatible: false, expected: 'incompatible' },
    { version: '0.167.0', compatible: false, expected: 'incompatible' },
    { version: undefined, compatible: true, expected: 'unknown' },
    { version: '0.167.0', compatible: undefined, expected: 'compatible' },
    { version: '0.170.0', compatible: undefined, expected: 'incompatible' },
  ])('classifies the observed version $version and explicit compatibility $compatible as $expected', async ({ version, compatible, expected }) => {
    const ctx = await createTestApp();
    try {
      const adapter = new CodexAdapter();
      adapter.probe = async () => ({ installed: true, pinnedVersion: '0.167.0', auth: 'unknown', ...(version === undefined ? {} : { version }), ...(compatible === undefined ? {} : { compatible }) });
      ctx.manager.registerAdapter(adapter);
      const snapshot = await new CapabilityRegistry(ctx.store, ctx.manager).snapshot();
      expect(snapshot.runtimes.find(runtime => runtime.agent === 'codex')).toMatchObject({ compatibility: expected, schemaHash: manifest.sources.codex.sha256, probe: { auth: 'unknown' } });
      expect(snapshot.inventory).toEqual(frozenNativeInventory);
      const capabilities = snapshot.capabilities.filter(capability => capability.agent === 'codex');
      expect(capabilities.every(capability => !capability.structuredImplemented && !capability.structuredVerified && !capability.fallbackVerified)).toBe(true);
      if (expected === 'compatible') expect(capabilities.every(capability => !capability.reason.includes('不兼容'))).toBe(true);
      else expect(capabilities.every(capability => capability.nativeAvailability !== 'available')).toBe(true);
    } finally { await ctx.close(); }
  });

  it('keeps unavailable runtimes blocked even when their probe reports a compatible version', async () => {
    const ctx = await createTestApp();
    try {
      const adapter = new CodexAdapter();
      let probe: ProbeResult = { installed: false, version: '0.169.0', pinnedVersion: '0.167.0', compatible: true, auth: 'unknown', notes: [] };
      adapter.probe = async () => probe;
      ctx.manager.registerAdapter(adapter);
      const registry = new CapabilityRegistry(ctx.store, ctx.manager);
      const missing = await registry.snapshot();
      expect(missing.runtimes.find(runtime => runtime.agent === 'codex')?.compatibility).toBe('unknown');
      expect(missing.capabilities.filter(capability => capability.agent === 'codex').every(capability => capability.nativeAvailability === 'environment-blocked')).toBe(true);
      probe = { ...probe, installed: true, auth: 'missing' };
      const unauthenticated = await registry.snapshot();
      expect(unauthenticated.runtimes.find(runtime => runtime.agent === 'codex')?.compatibility).toBe('compatible');
      expect(unauthenticated.capabilities.filter(capability => capability.agent === 'codex').every(capability => capability.nativeAvailability === 'environment-blocked' && !capability.structuredVerified && !capability.fallbackVerified)).toBe(true);
    } finally { await ctx.close(); }
  });

  it('refreshes the authenticated API revision after compatibility changes and preserves probe rejection evidence', async () => {
    const ctx = await createTestApp();
    try {
      const adapter = new CodexAdapter();
      let probe: ProbeResult = { installed: true, version: '0.169.0', pinnedVersion: '0.167.0', compatible: true, auth: 'unknown', notes: [] };
      adapter.probe = async () => probe;
      ctx.manager.registerAdapter(adapter);
      const get = (revision?: string) => ctx.app.inject({ url: `/api/capabilities${revision === undefined ? '' : `?revision=${revision}`}`, headers: { cookie: ctx.cookie } });
      const first = (await get()).json<CapabilitySnapshot>();
      expect(first.runtimes.find(runtime => runtime.agent === 'codex')?.compatibility).toBe('compatible');
      expect((await get(first.revision)).statusCode).toBe(200);
      probe = { ...probe, version: '0.167.0', compatible: false, notes: ['原生握手未通过审核合同'] };
      expect((await get(first.revision)).statusCode).toBe(409);
      const rejected = (await get()).json<CapabilitySnapshot>();
      expect(rejected.revision).not.toBe(first.revision);
      expect(rejected.runtimes.find(runtime => runtime.agent === 'codex')?.compatibility).toBe('incompatible');
      expect(rejected.capabilities.filter(capability => capability.agent === 'codex').every(capability => capability.reason.includes('原生握手未通过审核合同'))).toBe(true);
      probe = { ...probe, compatible: true, notes: [] };
      expect((await get(rejected.revision)).statusCode).toBe(409);
      expect((await get()).json<CapabilitySnapshot>().runtimes.find(runtime => runtime.agent === 'codex')?.compatibility).toBe('compatible');
    } finally { await ctx.close(); }
  });

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
