import { afterEach, expect, it, vi } from 'vitest';
import { attachDshBrowser, identityFromDshBootstrap, readDshHostIdentity, requireDshBaseline } from '../src/identity.js';
afterEach(() => vi.unstubAllGlobals());
const page = (version = '0.2.2-rc.1') => `<html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: 'native-revision', release: { version, commit: 'built-commit' }, entries: [] })}</script></head></html>`;
it('Host identity comes from its JSON bootstrap and never from the local CLI version', () => {
  expect(identityFromDshBootstrap('https://host.test/dsh/?token=hidden', page())).toMatchObject({ url: 'https://host.test/dsh/', version: '0.2.2-rc.1', commit: 'built-commit', source: 'native-bootstrap', status: 'verified' });
  expect(identityFromDshBootstrap('https://host.test/dsh/', page('0.3.0')).status).toBe('incompatible');
  expect(() => requireDshBaseline(identityFromDshBootstrap('https://host.test/dsh/', '<html>missing</html>'))).toThrow('release');
  expect(identityFromDshBootstrap('https://host.test/dsh/', '<script>globalThis["__DSH_BOOT__"] = (globalThis.secret=true)</script>').status).toBe('unknown');
  expect(globalThis).not.toHaveProperty('secret');
});
it('the fixed Host browser exchange keeps credentials out of the identity and refuses redirects', async () => {
  const calls: { url: string; redirect: unknown }[] = [];
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), redirect: init.redirect });
    if (String(url).includes('?token=')) return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth-test=v1.private.signature; HttpOnly' } });
    return new Response(page());
  });
  const cookie = await attachDshBrowser('https://host.test/dsh/', 'test-token');
  const identity = await readDshHostIdentity('https://host.test/dsh/', cookie);
  expect(identity.status).toBe('verified');
  expect(JSON.stringify(identity)).not.toContain('private');
  expect(calls).toEqual([{ url: 'https://host.test/dsh/?token=test-token', redirect: 'manual' }, { url: 'https://host.test/dsh/', redirect: 'manual' }]);
  vi.stubGlobal('fetch', async () => new Response(null, { status: 302, headers: { location: 'https://other.test/' } }));
  expect((await readDshHostIdentity('https://host.test/dsh/', cookie)).status).toBe('unknown');
});
