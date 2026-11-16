import { mkdir, readFile, rename, stat, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';

const timing = vi.hoisted(() => ({ before: undefined as ((operation: string, path: string) => Promise<void>) | undefined,
  failWrite: false, handles: [] as FileHandle[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof FsPromises>();
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      await timing.before?.('open', String(args[0])); const file = await fs.open(...args); timing.handles.push(file);
      if (timing.failWrite && String(args[0]).endsWith('/new-entry')) vi.spyOn(file, 'writeFile').mockRejectedValue(new Error('Controlled write failure'));
      return file;
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await timing.before?.('writeFile', String(args[0]));
      if (timing.failWrite && String(args[0]).endsWith('/new-entry')) throw new Error('Controlled write failure');
      return fs.writeFile(...args);
    },
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => { await timing.before?.('mkdir', String(args[0])); return fs.mkdir(...args); },
  };
});

let ctx: TestApp; let root: string; let outside: string; let workspaceId: string;
beforeEach(async () => {
  timing.before = undefined; timing.failWrite = false; timing.handles = [];
  ctx = await createTestApp(); root = join(ctx.dataDir, 'workspace'); outside = join(ctx.dataDir, 'outside');
  await mkdir(join(root, 'folder'), { recursive: true }); await mkdir(outside); workspaceId = ctx.store.createWorkspace('creation boundary', root).id;
});
afterEach(async () => {
  timing.before = undefined; timing.failWrite = false; vi.restoreAllMocks();
  await Promise.all(timing.handles.filter(file => file.fd !== -1).map(file => file.close())); await ctx.close();
});
const create = (path: string, kind = 'file', content: unknown = 'exact\r\n字节') => ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/fs`, headers: { cookie: ctx.cookie }, payload: { path, kind, content } });

it.each(['file', 'dir'])('a parent replaced just before %s creation never redirects the write outside or reports success', async kind => {
  timing.before = async (_operation, path) => {
    if (!path.endsWith('/new-entry')) return;
    timing.before = undefined; await rename(join(root, 'folder'), join(root, 'original')); await symlink(outside, join(root, 'folder'));
  };
  const response = await create('folder/new-entry', kind);
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toContain('路径');
  expect(await stat(join(outside, 'new-entry')).catch(() => undefined)).toBeUndefined();
  const original = await stat(join(root, 'original', 'new-entry'));
  expect(kind === 'dir' ? original.isDirectory() : original.isFile()).toBe(true);
  if (kind === 'file') expect(await readFile(join(root, 'original', 'new-entry'), 'utf8')).toBe('exact\r\n字节');
  expect(timing.handles.every(file => file.fd === -1)).toBe(true);
});

it('ordinary creates preserve exact file bytes and internal directory aliases, and existing entries are never replaced', async () => {
  await symlink('folder', join(root, 'alias'));
  const created = await create('alias/notes.txt'); expect(created.statusCode).toBe(200);
  expect(created.json()).toEqual({ path: 'folder/notes.txt', kind: 'file' });
  expect(await readFile(join(root, 'folder', 'notes.txt'), 'utf8')).toBe('exact\r\n字节');
  expect((await create('alias/notes.txt', 'file', 'overwrite')).statusCode).toBe(400);
  expect((await create('folder/new-dir', 'dir')).statusCode).toBe(200);
  expect((await create('folder/new-dir', 'dir')).statusCode).toBe(400);
  expect(timing.handles.every(file => file.fd === -1)).toBe(true);
});

it('external directory links, absolute/traversal paths and existing final symlinks cannot write outside', async () => {
  await writeFile(join(outside, 'existing'), 'outside-original'); await symlink(outside, join(root, 'escape'));
  await symlink(join(outside, 'existing'), join(root, 'folder', 'existing'));
  for (const path of ['escape/new-entry', '../outside/new-entry', join(outside, 'new-entry'), 'folder/existing']) expect((await create(path)).statusCode).toBe(400);
  expect(await readFile(join(outside, 'existing'), 'utf8')).toBe('outside-original');
  expect(await stat(join(outside, 'new-entry')).catch(() => undefined)).toBeUndefined();
});

it('invalid content is rejected before file creation', async () => {
  expect((await create('folder/new-entry', 'file', 42)).statusCode).toBe(400);
  expect(await stat(join(root, 'folder', 'new-entry')).catch(() => undefined)).toBeUndefined();
});

it('write failures retain failure status and close the actual parent and file descriptors', async () => {
  timing.failWrite = true;
  const response = await create('folder/new-entry'); expect(response.statusCode).toBe(500);
  expect(response.json().error).toBe('Controlled write failure');
  expect(await readFile(join(root, 'folder', 'new-entry'), 'utf8')).toBe('');
  expect(timing.handles.every(file => file.fd === -1)).toBe(true);
  expect(await stat(join(outside, 'new-entry')).catch(() => undefined)).toBeUndefined();
});

it('unverifiable platforms reject creation before changing the filesystem', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  try {
    expect((await create('folder/new-entry')).statusCode).toBe(501);
    expect(await stat(join(root, 'folder', 'new-entry')).catch(() => undefined)).toBeUndefined();
  } finally { Object.defineProperty(process, 'platform', platform); }
});
