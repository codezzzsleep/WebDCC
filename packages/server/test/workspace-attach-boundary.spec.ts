import { chmod, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Fs from 'node:fs/promises';

const hook = vi.hoisted(() => ({ afterCopy: undefined as (() => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof Fs>();
  return { ...actual, rename: async (...args: Parameters<typeof Fs.rename>) => { await actual.rename(...args); if (String(args[0]).includes('.webdcc-')) await hook.afterCopy?.(); } };
});
import { createTestApp } from './helpers.js';
afterEach(() => { hook.afterCopy = undefined; });

it.each(['directory', 'file'] as const)('workspace attachment copy rejects an external %s link without overwriting outside content', async kind => {
  const ctx = await createTestApp();
  try {
    const root = join(ctx.dataDir, 'workspace'), outside = join(ctx.dataDir, 'outside-attach');
    await mkdir(root); await mkdir(outside);
    const workspace = ctx.store.createWorkspace('attachment copy', root);
    const file = await ctx.files.putBuffer(Buffer.from('ATTACHMENT'), 'file.txt', 'text/plain');
    const filename = `${file.id}-file.txt`, victim = join(outside, kind === 'directory' ? filename : 'victim.txt');
    await writeFile(victim, 'EXTERNAL'); await mkdir(join(root, '.webdcc'));
    if (kind === 'directory') await symlink(outside, join(root, '.webdcc/uploads'));
    else { await mkdir(join(root, '.webdcc/uploads')); await symlink(victim, join(root, '.webdcc/uploads', filename)); }
    const result = await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/attach`, headers: { cookie: ctx.cookie }, payload: { fileId: file.id } });
    const outsideContent = await readFile(victim, 'utf8');
    console.info('controlled workspace attachment copy', JSON.stringify({ kind, status: result.statusCode, response: result.json(), outsideContent }));
    expect(result.statusCode).toBe(409);
    expect(outsideContent).toBe('EXTERNAL');
  } finally { await ctx.close(); }
});

it('normal and repeated copies retain exact Chinese/CRLF bytes, returned identity and existing mode', async () => {
  const ctx = await createTestApp();
  try {
    const root = join(ctx.dataDir, 'workspace'); await mkdir(root); const workspace = ctx.store.createWorkspace('copy', root);
    const payload = Buffer.from('中文\r\n原文\r\n'), file = await ctx.files.putBuffer(payload, '文件.txt', 'text/plain');
    const request = () => ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/attach`, headers: { cookie: ctx.cookie }, payload: { fileId: file.id } });
    const first = await request(); expect(first.statusCode).toBe(200);
    const path = join(root, first.json().path); expect((await readFile(path)).equals(payload)).toBe(true);
    await chmod(path, 0o640); await writeFile(path, 'user change');
    const repeated = await request(); expect(repeated.statusCode).toBe(200); expect(repeated.json()).toEqual(first.json());
    expect((await readFile(path)).equals(payload)).toBe(true); expect((await lstat(path)).mode & 0o777).toBe(0o640);
    await chmod(path, 0o444); expect((await request()).statusCode).toBe(403); expect((await readFile(path)).equals(payload)).toBe(true);
    expect(await readdir(join(root, '.webdcc/uploads'))).toEqual([`${file.id}-文件.txt`]);
  } finally { await ctx.close(); }
});

it.each([
  'r'.repeat(240) + '.md',
  '参'.repeat(78) + '.md',
  '📄'.repeat(60) + '.md',
  'q'.repeat(225) + '.md',
  'q'.repeat(226) + '.md',
])('a legal long name gets a stable UTF-8 workspace alias while original metadata and bytes remain intact (%s)', async name => {
  const ctx = await createTestApp();
  try {
    const root = join(ctx.dataDir, 'workspace'); await mkdir(root); const workspace = ctx.store.createWorkspace('long name', root);
    const bytes = Buffer.from('\uFEFF长文件名\r\noriginal bytes\r\n');
    const file = await ctx.files.putBuffer(bytes, name, 'text/markdown');
    const request = () => ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/attach`, headers: { cookie: ctx.cookie }, payload: { fileId: file.id } });
    const result = await request(); expect(result.statusCode).toBe(200);
    const path = result.json().path as string; const leaf = path.split('/').at(-1)!;
    expect(Buffer.byteLength(leaf)).toBeLessThanOrEqual(255);
    expect(Buffer.from(leaf).toString()).toBe(leaf); expect(leaf).not.toContain('\uFFFD');
    expect(leaf.startsWith(file.id + '-')).toBe(true); expect(leaf.endsWith('.md')).toBe(true);
    if (Buffer.byteLength(`${file.id}-${name}`) <= 255) expect(leaf).toBe(`${file.id}-${name}`);
    expect(result.json()).toMatchObject({ name, fileId: file.id, size: bytes.length });
    expect((await readFile(join(root, path))).equals(bytes)).toBe(true);
    expect((await ctx.files.readAll(file.id))?.file.name).toBe(name);
    expect((await request()).json()).toEqual(result.json());
  } finally { await ctx.close(); }
});

it('long workspace aliases distinguish explicit names that differ beyond their truncated prefix', async () => {
  const ctx = await createTestApp();
  try {
    const root = join(ctx.dataDir, 'workspace'); await mkdir(root); const workspace = ctx.store.createWorkspace('name collision', root);
    const file = await ctx.files.putBuffer(Buffer.from('original bytes'), 'original.md', 'text/markdown');
    const paths: string[] = [];
    for (const ending of ['甲', '乙']) {
      const result = await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/attach`, headers: { cookie: ctx.cookie }, payload: { fileId: file.id, name: '参'.repeat(78) + ending + '.md' } });
      expect(result.statusCode).toBe(200); paths.push(result.json().path);
    }
    expect(paths[0]).not.toBe(paths[1]);
    for (const path of paths) expect(await readFile(join(root, path), 'utf8')).toBe('original bytes');
  } finally { await ctx.close(); }
});

it('a directory moved after atomic copy preserves the applied original copy and reports conflict without touching the replacement', async () => {
  const ctx = await createTestApp();
  try {
    const root = join(ctx.dataDir, 'workspace'), outside = join(ctx.dataDir, 'outside'); await mkdir(root); await mkdir(outside);
    const workspace = ctx.store.createWorkspace('copy race', root), file = await ctx.files.putBuffer(Buffer.from('COPIED'), 'file.txt', 'text/plain');
    const name = `${file.id}-file.txt`, retired = join(ctx.dataDir, 'original-uploads'); await writeFile(join(outside, name), 'EXTERNAL');
    hook.afterCopy = async () => { await rename(join(root, '.webdcc/uploads'), retired); await symlink(outside, join(root, '.webdcc/uploads')); };
    const result = await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/attach`, headers: { cookie: ctx.cookie }, payload: { fileId: file.id } });
    expect(result.statusCode).toBe(409); expect(result.json().error).toContain('附件已复制到原目录');
    expect(await readFile(join(retired, name), 'utf8')).toBe('COPIED'); expect(await readFile(join(outside, name), 'utf8')).toBe('EXTERNAL');
    expect(await readdir(retired)).toEqual([name]);
  } finally { await ctx.close(); }
});

it.each([42, 'bad\0name', 'bad\nname', 'x'.repeat(300)])('invalid copy name is rejected before creating attachment directories (%j)', async name => {
  const ctx = await createTestApp();
  try {
    const root = join(ctx.dataDir, 'workspace'); await mkdir(root); const workspace = ctx.store.createWorkspace('invalid name', root), file = await ctx.files.putBuffer(Buffer.from('data'), 'file.txt', 'text/plain');
    const result = await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/attach`, headers: { cookie: ctx.cookie }, payload: { fileId: file.id, name } });
    expect(result.statusCode).toBe(400); expect(await readdir(root)).toEqual([]);
  } finally { await ctx.close(); }
});
