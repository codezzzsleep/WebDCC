import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { DshAdapter } from '../../adapters/dsh/src/adapter.js';
import type { CapabilitySnapshot } from '@webdcc/protocol';
import { CapabilityRegistry } from '../src/capability-registry.js';
import { createTestApp } from './helpers.js';

async function host() {
  let manifest = 'release-one';
  let missing = false;
  const methods: string[] = [];
  const server = createServer((request, response) => {
    methods.push(request.method ?? '');
    response.setHeader('content-type', 'text/html');
    response.end(missing ? '<html>No bootstrap</html>' : `<script>globalThis.__DSH_BOOT__ = ${JSON.stringify({ rev: manifest, release: { version: '0.2.2-rc.1', commit: 'fixture-commit' }, entries: [] })}</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture has no address');
  const url = `http://127.0.0.1:${address.port}/`;
  return {
    url, methods,
    adapter: () => new DshAdapter({ mode: 'attach', attachUrl: `${url}?token=fixture-private-token`, attachCookie: 'fixture-private-operator', attachBrowserCookie: 'dsh-auth-fixture=v1.private-browser' }),
    changeManifest: () => { manifest = 'release-two'; },
    removeBootstrap: () => { missing = true; },
    close: () => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

const dsh = (snapshot: CapabilitySnapshot) => {
  const runtime = snapshot.runtimes.find(runtime => runtime.agent === 'dsh');
  if (!runtime) throw new Error('Missing DSH runtime');
  return runtime;
};

it('binds the capability snapshot to the actual configured Host without claiming local OS or profile identity', async () => {
  const firstHost = await host();
  const secondHost = await host();
  const ctx = await createTestApp();
  try {
    ctx.manager.registerAdapter(firstHost.adapter());
    const registry = new CapabilityRegistry(ctx.store, ctx.manager);
    const first = await registry.snapshot();
    expect(dsh(first)).toMatchObject({ os: 'unknown', profile: 'current-host-profile', runtimeContext: { source: 'native-bootstrap', status: 'observed', profile: { scope: 'current-host-profile', status: 'unavailable-in-api' } } });
    ctx.manager.registerAdapter(secondHost.adapter());
    const second = await registry.snapshot();
    expect(dsh(first).hostId).not.toBe(dsh(second).hostId);
    expect(dsh(first).probe.version).toBe(dsh(second).probe.version);
    expect(second.revision).not.toBe(first.revision);
    await expect(registry.assertRevision(first.revision)).rejects.toMatchObject({ statusCode: 409, code: 'capability-stale' });
    expect(JSON.stringify(second)).not.toContain('fixture-private');
    expect(JSON.stringify(second)).not.toContain('private-browser');
    expect(firstHost.methods.every(method => method === 'GET')).toBe(true);
    expect(secondHost.methods.every(method => method === 'GET')).toBe(true);
    expect(second.capabilities.every(capability => !capability.structuredVerified && !capability.fallbackVerified)).toBe(true);
  } finally { await ctx.close(); await firstHost.close(); await secondHost.close(); }
});

it('keeps repeated observations stable but expires the API revision when the same Host publishes a new manifest', async () => {
  const target = await host();
  const ctx = await createTestApp();
  try {
    ctx.manager.registerAdapter(target.adapter());
    const registry = new CapabilityRegistry(ctx.store, ctx.manager);
    const first = await registry.snapshot();
    expect((await registry.snapshot()).revision).toBe(first.revision);
    await expect(registry.assertRevision(first.revision)).resolves.toHaveProperty('revision', first.revision);
    target.changeManifest();
    const second = await registry.snapshot();
    expect(dsh(second).hostId).toBe(dsh(first).hostId);
    expect(dsh(second).probe.version).toBe(dsh(first).probe.version);
    expect(dsh(second).runtimeContext?.hostFingerprint).not.toBe(dsh(first).runtimeContext?.hostFingerprint);
    expect(second.revision).not.toBe(first.revision);
    expect((await ctx.app.inject({ url: `/api/capabilities?revision=${first.revision}`, headers: { cookie: ctx.cookie } })).statusCode).toBe(409);
  } finally { await ctx.close(); await target.close(); }
});

it('expires the snapshot when an adapter is rebound or its native connection generation changes', async () => {
  const target = await host();
  const ctx = await createTestApp();
  try {
    const registry = new CapabilityRegistry(ctx.store, ctx.manager);
    ctx.manager.registerAdapter(target.adapter());
    const first = await registry.snapshot();
    const replacement = target.adapter();
    ctx.manager.registerAdapter(replacement);
    const second = await registry.snapshot();
    expect(dsh(second).hostId).toBe(dsh(first).hostId);
    expect(dsh(second).runtimeContext?.hostFingerprint).toBe(dsh(first).runtimeContext?.hostFingerprint);
    expect(second.revision).not.toBe(first.revision);
    const transport = replacement as unknown as { muxGeneration: number };
    transport.muxGeneration++;
    const third = await registry.snapshot();
    expect(third.revision).not.toBe(second.revision);
    await expect(registry.assertRevision(second.revision)).rejects.toMatchObject({ statusCode: 409 });
  } finally { await ctx.close(); await target.close(); }
});

it('drops stale release evidence when bootstrap becomes unavailable and retains an unverified configured target on probe failure', async () => {
  const target = await host();
  const ctx = await createTestApp();
  try {
    const adapter = target.adapter();
    ctx.manager.registerAdapter(adapter);
    const registry = new CapabilityRegistry(ctx.store, ctx.manager);
    const first = await registry.snapshot();
    expect(dsh(first).runtimeContext?.hostFingerprint).toBeDefined();
    target.removeBootstrap();
    const missing = await registry.snapshot();
    expect(dsh(missing)).toMatchObject({ hostId: dsh(first).hostId, os: 'unknown', runtimeContext: { status: 'unverified', profile: { status: 'unverified' } } });
    expect(dsh(missing).runtimeContext?.hostFingerprint).toBeUndefined();
    expect(missing.revision).not.toBe(first.revision);
    vi.spyOn(adapter, 'hostIdentity').mockRejectedValue(new Error('Host identity replaced during observation'));
    const failed = await registry.snapshot();
    expect(dsh(failed)).toMatchObject({ hostId: dsh(first).hostId, os: 'unknown', probe: { installed: false }, runtimeContext: { status: 'unverified' } });
    expect(dsh(failed).profile).not.toBe('native-default');
    expect(adapter.debugProcesses()).toEqual([]);
  } finally { await ctx.close(); await target.close(); }
});
