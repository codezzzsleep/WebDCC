import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Fs from 'node:fs/promises';

const hook = vi.hoisted(() => ({ beforeList: undefined as ((path: string) => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof Fs>();
  return { ...actual, readdir: async (...args: Parameters<typeof Fs.readdir>) => { await hook.beforeList?.(String(args[0])); return actual.readdir(...args); } };
});
import { createTestApp } from './helpers.js';
const fs = await vi.importActual<typeof Fs>('node:fs/promises');
afterEach(() => { hook.beforeList = undefined; });

it('workspace directory listing rejects a replaced directory rather than returning external entry names', async () => {
  const ctx = await createTestApp();
  try {
    const root = join(ctx.dataDir, 'workspace'), docs = join(root, 'docs'), outside = join(ctx.dataDir, 'outside-list');
    await fs.mkdir(docs, { recursive: true }); await fs.mkdir(outside);
    await fs.writeFile(join(docs, 'inside.txt'), 'inside'); await fs.writeFile(join(outside, 'outside-only.txt'), 'outside');
    const workspace = ctx.store.createWorkspace('directory listing', root);
    hook.beforeList = async path => {
      if (path === docs || path.startsWith('/proc/self/fd/')) { hook.beforeList = undefined; await fs.rename(docs, join(ctx.dataDir, 'original-docs')); await fs.symlink(outside, docs); }
    };
    const response = await ctx.app.inject({ url: `/api/workspaces/${workspace.id}/fs?path=docs`, headers: { cookie: ctx.cookie } });
    console.info('controlled directory listing', JSON.stringify({ status: response.statusCode, body: response.json() }));
    expect(response.statusCode).toBe(409); expect(response.body).not.toContain('outside-only.txt');
  } finally { await ctx.close(); }
});

it('stable root and internal directory aliases retain directory-first sorting, case-insensitive filtering and canonical relative paths', async () => {
  const ctx = await createTestApp();
  try {
    const root = join(ctx.dataDir, 'workspace'), docs = join(root, 'docs'); await fs.mkdir(join(docs, 'z-folder'), { recursive: true });
    await fs.writeFile(join(docs, 'b.txt'), 'b'); await fs.writeFile(join(docs, 'a.txt'), 'a'); await fs.writeFile(join(docs, 'note.md'), 'note');
    await fs.symlink(docs, join(root, 'alias')); const workspace = ctx.store.createWorkspace('stable list', root);
    const get = (path: string) => ctx.app.inject({ url: `/api/workspaces/${workspace.id}/fs${path}`, headers: { cookie: ctx.cookie } });
    const result = await get('?path=alias'); expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ path: 'docs', entries: [{ name: 'z-folder', path: 'docs/z-folder', type: 'dir' }, { name: 'a.txt', path: 'docs/a.txt', type: 'file' }, { name: 'b.txt', path: 'docs/b.txt', type: 'file' }, { name: 'note.md', path: 'docs/note.md', type: 'file' }] });
    const filtered = await get('?path=docs&q=TXT'); expect(filtered.json().entries.map((entry: { name: string }) => entry.name)).toEqual(['a.txt', 'b.txt']);
    expect((await get('')).json().path).toBe('.');
    expect((await get('?path=docs&q=a&q=b')).statusCode).toBe(400);
  } finally { await ctx.close(); }
});

it('directory verification unavailable on another platform is an explicit error without changing entries', async () => {
  const ctx = await createTestApp(), platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    const root = join(ctx.dataDir, 'workspace'); await fs.mkdir(root); await fs.writeFile(join(root, 'inside.txt'), 'inside'); const workspace = ctx.store.createWorkspace('platform list', root);
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    const result = await ctx.app.inject({ url: `/api/workspaces/${workspace.id}/fs`, headers: { cookie: ctx.cookie } });
    expect(result.statusCode).toBe(501); expect(await fs.readdir(root)).toEqual(['inside.txt']);
  } finally { Object.defineProperty(process, 'platform', platform); await ctx.close(); }
});
