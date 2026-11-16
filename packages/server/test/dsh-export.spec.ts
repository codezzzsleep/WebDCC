import { afterEach, expect, it, vi } from 'vitest';
import { createTestApp } from './helpers.js';
import { DshNativeSurface } from '../src/dsh-native-surface.js';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AgentAdapter } from '@webdcc/protocol';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { DshSurfaceConnection } from '../src/dsh-native-surface.js';

afterEach(() => vi.restoreAllMocks());
it('an authenticated completed export downloads native bytes; retry never repeats the command and identity drift refuses the file', async () => {
  const ctx = await createTestApp();
  try {
    let commands = 0;
    const adapter: AgentAdapter = new FakeAdapter({ id: 'dsh' });
    adapter.slashCommands = async () => [{ name: '/export', route: 'native-control' }];
    adapter.executeSlashControl = async () => { commands++; return { confirmed: true, form: 'dsh-export', download: { kind: 'dsh-session-log', nativeId: 'export-native' } }; };
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('export', ctx.dataDir);
    const created = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    ctx.store.updateSession(created.id, { nativeId: 'export-native' });
    const catalog = await ctx.manager.slashCommandCatalog(created.id);
    const result = await ctx.manager.executeSlashControl(created.id, { commandId: 'export-command', revision: catalog.revision, line: '/export' });
    expect(result.receipt.state).toBe('completed');
    const bytes = Buffer.from('504b030400000000ff0013', 'hex');
    const native = vi.spyOn(DshNativeSurface.prototype, 'sessionExport').mockImplementation(async id => {
      expect(id).toBe('export-native');
      return new Response(bytes, { headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="native.zip"', 'set-cookie': 'native-secret=never-forward' } });
    });
    const url = `/api/sessions/${created.id}/dsh-export?commandId=export-command`;
    expect((await ctx.app.inject({ url })).statusCode).toBe(401); expect(native).not.toHaveBeenCalled();
    for (let count = 0; count < 2; count++) {
      const download = await ctx.app.inject({ url, headers: { cookie: ctx.cookie } });
      expect(download.statusCode).toBe(200); expect(download.rawPayload).toEqual(bytes);
      expect(download.headers['content-disposition']).toBe('attachment; filename="native.zip"');
      expect(download.headers['set-cookie']).toBeUndefined();
    }
    expect(commands).toBe(1);
    const other = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    expect((await ctx.app.inject({ url: `/api/sessions/${other.id}/dsh-export?commandId=export-command`, headers: { cookie: ctx.cookie } })).statusCode).toBe(404);
    native.mockResolvedValueOnce(new Response('native session missing', { status: 404 }));
    const absent = await ctx.app.inject({ url, headers: { cookie: ctx.cookie } });
    expect(absent.statusCode).toBe(404); expect(absent.body).toBe('native session missing');
    native.mockImplementationOnce(async () => { ctx.store.updateSession(created.id, { nativeId: 'replacement' }); return new Response(bytes); });
    expect((await ctx.app.inject({ url, headers: { cookie: ctx.cookie } })).statusCode).toBe(409);
    const before = native.mock.calls.length;
    expect((await ctx.app.inject({ url, headers: { cookie: ctx.cookie } })).statusCode).toBe(409);
    expect(native).toHaveBeenCalledTimes(before); expect(commands).toBe(1);
  } finally { await ctx.close(); }
});

it('export uses the current owned Host credential and revokes it without falling back to stale persisted attach credentials', async () => {
  const bytes = Buffer.from('504b030400000000ff0013', 'hex');
  const cookies: string[] = [];
  const native = createServer((request, response) => {
    cookies.push(request.headers.cookie ?? '');
    if (request.url === '/') {
      response.setHeader('content-type', 'text/html');
      response.end(`<script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: 'runtime-host', release: { version: '0.2.2-rc.1' }, entries: [] })}</script>`);
    } else if (request.url?.startsWith('/api/session.export')) {
      response.setHeader('content-type', 'application/zip');
      response.setHeader('set-cookie', 'dsh-auth-private=never-forward');
      response.end(bytes);
    } else { response.statusCode = 404; response.end(); }
  });
  native.listen(0, '127.0.0.1'); await once(native, 'listening');
  const url = `http://127.0.0.1:${(native.address() as { port: number }).port}/`;
  const ctx = await createTestApp();
  try {
    await ctx.dsh.save({ url, cookie: 'dsh-auth-host=v2.stale', browserCookie: 'dsh-auth-host=v1.stale', connectedAt: '2026-11-15T00:00:00Z' });
    let runtime: DshSurfaceConnection | null | undefined = { url, browserCookie: 'dsh-auth-host=v1.current', connectedAt: 'owned-host-one' };
    const adapter = new FakeAdapter({ id: 'dsh' }) as AgentAdapter & { nativeBrowserConnection: () => typeof runtime };
    adapter.nativeBrowserConnection = () => runtime;
    adapter.slashCommands = async () => [{ name: '/export', route: 'native-control' }];
    adapter.executeSlashControl = async () => ({ confirmed: true, form: 'dsh-export', download: { kind: 'dsh-session-log', nativeId: 'runtime-native' } });
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('runtime-export', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    ctx.store.updateSession(session.id, { nativeId: 'runtime-native' });
    const catalog = await ctx.manager.slashCommandCatalog(session.id);
    await ctx.manager.executeSlashControl(session.id, { commandId: 'runtime-export', revision: catalog.revision, line: '/export' });
    const path = `/api/sessions/${session.id}/dsh-export?commandId=runtime-export`;
    expect((await ctx.app.inject({ url: path })).statusCode).toBe(401); expect(cookies).toEqual([]);
    const download = await ctx.app.inject({ url: path, headers: { cookie: ctx.cookie } });
    expect(download.statusCode).toBe(200); expect(download.rawPayload).toEqual(bytes); expect(download.headers['set-cookie']).toBeUndefined();
    expect(cookies).toEqual(['dsh-auth-host=v1.current', 'dsh-auth-host=v1.current']);
    runtime = null;
    expect((await ctx.app.inject({ url: path, headers: { cookie: ctx.cookie } })).statusCode).toBe(401);
    expect(cookies).toHaveLength(2);
    runtime = { url, browserCookie: 'dsh-auth-host=v1.replacement', connectedAt: 'owned-host-two' };
    expect((await ctx.app.inject({ url: path, headers: { cookie: ctx.cookie } })).statusCode).toBe(200);
    expect(cookies.slice(-2)).toEqual(['dsh-auth-host=v1.replacement', 'dsh-auth-host=v1.replacement']);
    runtime = undefined;
    expect((await ctx.app.inject({ url: path, headers: { cookie: ctx.cookie } })).statusCode).toBe(200);
    expect(cookies.slice(-2)).toEqual(['dsh-auth-host=v1.stale', 'dsh-auth-host=v1.stale']);
  } finally {
    await ctx.close(); native.closeIdleConnections(); await new Promise<void>(resolve => native.close(() => resolve()));
  }
});
