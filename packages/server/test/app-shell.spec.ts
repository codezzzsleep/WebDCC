import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

it('serves a current authenticated recovery shell and prevents HTML/worker HTTP caching', async () => {
  const webDist = await mkdtemp(join(tmpdir(), 'wdcc-shell-'));
  for (const [name, body] of Object.entries({ 'index.html': '<html><head></head><body>current-shell</body></html>', 'sw.js': '// worker', 'registerSW.js': '// legacy registration' })) await writeFile(join(webDist, name), body);
  const ctx = await createTestApp({}, undefined, {}, { webDist });
  try {
    expect((await ctx.app.inject('/api/app')).statusCode).toBe(401);
    const to = '/new?w=workspace&agent=codex#</script><script>alert(1)</script>';
    const response = await ctx.app.inject({ url: `/api/app?to=${encodeURIComponent(to)}`, headers: { cookie: ctx.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.body).toContain('current-shell');
    expect(response.body).toContain('window.__wdccAppRecovery');
    expect(response.body).toContain('\\u003c/script>');
    expect(response.body).not.toContain('</script><script>alert');
    for (const url of ['/', '/new?w=workspace', '/index.html', '/sw.js', '/registerSW.js']) {
      const found = await ctx.app.inject({ url, headers: { cookie: ctx.cookie } });
      expect(found.statusCode, `${url}: ${found.body}`).toBe(200);
      expect(found.headers['cache-control']).toBe('no-store');
    }
    for (const target of ['https://evil.invalid', '//evil.invalid', '/\\evil.invalid', '/new\nignored', '/api/app', '/api', '/new/../api/app']) {
      const invalid = await ctx.app.inject({ url: `/api/app?to=${encodeURIComponent(target)}`, headers: { cookie: ctx.cookie } });
      expect(invalid.statusCode, target).toBe(400);
    }
    expect((await ctx.app.inject({ url: '/api/app?to=/new&to=//evil.invalid', headers: { cookie: ctx.cookie } })).statusCode).toBe(400);
  } finally { await ctx.close(); await rm(webDist, { recursive: true, force: true }); }
});

it('does not serve a recovery shell when no frontend is built', async () => {
  const ctx = await createTestApp();
  try { expect((await ctx.app.inject({ url: '/api/app', headers: { cookie: ctx.cookie } })).statusCode).toBe(404); }
  finally { await ctx.close(); }
});
