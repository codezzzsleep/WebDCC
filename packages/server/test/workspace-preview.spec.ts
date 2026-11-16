import { mkdir, readFile, rename, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTestApp } from './helpers.js';

const timing = vi.hoisted(() => ({ beforeOpen: undefined as ((path: string) => Promise<void>) | undefined, handles: [] as FileHandle[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof FsPromises>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    await timing.beforeOpen?.(String(args[0]));
    const file = await fs.open(...args); timing.handles.push(file); return file;
  } };
});

it('authenticated HTML preview serves scoped local resources without changing raw downloads', async () => {
  const ctx = await createTestApp();
  try {
    const root = join(ctx.dataDir, 'preview'); await mkdir(join(root, 'pages'), { recursive: true });
    const workspace = ctx.store.createWorkspace('preview', root);
    const html = '<h1>页面效果</h1><link rel="stylesheet" href="/style.css"><script type="module" src="./app.js"></script>';
    await writeFile(join(root, 'pages/index.html'), html);
    await writeFile(join(root, 'pages/app.js'), 'import { value } from "/value.js"; document.title = value;');
    await writeFile(join(root, 'value.js'), 'export const value = "loaded";');
    await writeFile(join(root, 'style.css'), 'h1{background:url("/picture.svg")}');
    const endpoint = `/api/workspaces/${workspace.id}/preview`;
    expect((await ctx.app.inject({ method: 'POST', url: endpoint, payload: { path: 'pages/index.html' } })).statusCode).toBe(401);
    const created = await ctx.app.inject({ method: 'POST', url: endpoint, headers: { cookie: ctx.cookie }, payload: { path: 'pages/index.html' } });
    expect(created.statusCode).toBe(200);
    const url = created.json().url as string; const prefix = url.slice(0, url.indexOf('/pages/')) + '/';
    const page = await ctx.app.inject({ url });
    expect(page.statusCode).toBe(200); expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(page.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(page.headers['set-cookie']).toBeUndefined(); expect(page.body).toContain(`href="${prefix}style.css"`);
    const css = await ctx.app.inject({ url: prefix + 'style.css', headers: { origin: 'null' } });
    expect(css.statusCode).toBe(200); expect(css.body).toContain(prefix + 'picture.svg');
    const script = await ctx.app.inject({ url: prefix + 'pages/app.js', headers: { origin: 'null' } });
    expect(script.statusCode).toBe(200); expect(script.headers['access-control-allow-origin']).toBe('*');
    expect(script.body).toContain(prefix + 'value.js');
    const raw = await ctx.app.inject({ url: `/api/workspaces/${workspace.id}/raw?path=pages/index.html`, headers: { cookie: ctx.cookie } });
    expect(raw.rawPayload).toEqual(Buffer.from(html)); expect(raw.headers['content-disposition']).toContain('attachment;');
  } finally { await ctx.close(); }
});

it('temporary unsaved HTML renders separately and cannot escape or outlive its workspace grant', async () => {
  const ctx = await createTestApp();
  try {
    const root = join(ctx.dataDir, 'preview'); await mkdir(root);
    const workspace = ctx.store.createWorkspace('preview', root);
    await writeFile(join(root, 'index.htm'), '<h1>saved</h1>');
    await writeFile(join(ctx.dataDir, 'outside.html'), '<h1>outside</h1>');
    await symlink(join(ctx.dataDir, 'outside.html'), join(root, 'outside.html'));
    const created = await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/preview`, headers: { cookie: ctx.cookie }, payload: { path: 'index.htm', content: '<h1>unsaved</h1>' } });
    const url = created.json().url as string; const prefix = url.slice(0, url.lastIndexOf('/') + 1);
    expect((await ctx.app.inject({ url })).body).toContain('<h1>unsaved</h1>');
    expect(await readFile(join(root, 'index.htm'), 'utf8')).toBe('<h1>saved</h1>');
    expect((await ctx.app.inject({ url: prefix + 'outside.html' })).statusCode).toBe(404);
    expect((await ctx.app.inject({ url: '/workspace-preview/not-a-grant/index.htm' })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url })).statusCode).toBe(404);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(created.json().expiresAt + 1);
    try { expect((await ctx.app.inject({ url })).statusCode).toBe(403); } finally { clock.mockRestore(); }
  } finally { await ctx.close(); }
});

it.each(['create', 'resource'])('preview %s rejects a replaced ancestor before reading outside HTML', async stage => {
  timing.beforeOpen = undefined; timing.handles = [];
  const ctx = await createTestApp();
  try {
    const root = join(ctx.dataDir, 'preview'), outside = join(ctx.dataDir, 'outside');
    await mkdir(join(root, 'pages'), { recursive: true }); await mkdir(outside);
    await writeFile(join(root, 'pages/index.html'), '<h1>inside-only</h1>');
    await writeFile(join(outside, 'index.html'), '<h1>outside-secret</h1>');
    const workspace = ctx.store.createWorkspace('preview-boundary', root);
    const create = () => ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/preview`, headers: { cookie: ctx.cookie }, payload: { path: 'pages/index.html' } });
    const grant = stage === 'resource' ? await create() : undefined;
    if (grant) expect(grant.statusCode).toBe(200);
    timing.beforeOpen = async path => {
      if (!path.endsWith('/pages/index.html')) return;
      timing.beforeOpen = undefined;
      await rename(join(root, 'pages'), join(root, 'original-pages'));
      await symlink(outside, join(root, 'pages'));
    };
    const reply = stage === 'create' ? await create() : await ctx.app.inject({ url: grant!.json().url });
    expect(reply.statusCode).toBe(409); expect(reply.body).not.toContain('outside-secret');
    expect(await readFile(join(outside, 'index.html'), 'utf8')).toBe('<h1>outside-secret</h1>');
    expect(timing.handles.every(file => file.fd === -1)).toBe(true);
  } finally { timing.beforeOpen = undefined; await ctx.close(); }
});
