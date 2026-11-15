import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTestApp } from './helpers.js';

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
