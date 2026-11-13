import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';
it('absolute workspace image links and the raw API return image bytes with authentication and path boundaries', async () => {
  const ctx = await createTestApp();
  try {
    const root = join(ctx.dataDir, 'images');
    const { mkdir } = await import('node:fs/promises'); await mkdir(root);
    const workspace = ctx.store.createWorkspace('pictures', root);
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const path = join(root, '中文.png'); await writeFile(path, bytes);
    for (const url of [encodeURI(path), `/api/workspaces/${workspace.id}/raw?path=${encodeURIComponent(path)}`]) {
      expect((await ctx.app.inject({ url })).statusCode).toBe(401);
      const response = await ctx.app.inject({ url, headers: { cookie: ctx.cookie } });
      expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toBe('image/png');
      expect(response.rawPayload).toEqual(bytes); expect(response.headers['x-content-type-options']).toBe('nosniff');
    }
    const outside = join(ctx.dataDir, 'outside.png'); await writeFile(outside, bytes); await symlink(outside, join(root, 'escape.png'));
    const escape = await ctx.app.inject({ url: `/api/workspaces/${workspace.id}/raw?path=escape.png`, headers: { cookie: ctx.cookie } });
    expect(escape.statusCode).toBe(400);
    expect((await ctx.app.inject({ url: outside, headers: { cookie: ctx.cookie } })).statusCode).toBe(404);
  } finally { await ctx.close(); }
});
