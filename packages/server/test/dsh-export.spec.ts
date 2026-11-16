import { afterEach, expect, it, vi } from 'vitest';
import { createTestApp } from './helpers.js';
import { DshNativeSurface } from '../src/dsh-native-surface.js';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AgentAdapter } from '@webdcc/protocol';

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
