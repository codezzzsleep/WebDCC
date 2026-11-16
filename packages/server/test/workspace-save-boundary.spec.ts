import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Fs from 'node:fs/promises';

const hooks = vi.hoisted(() => ({ beforeReplace: undefined as (() => Promise<void>) | undefined, afterReplace: undefined as (() => Promise<void>) | undefined,
  beforeOpen: undefined as ((path: string) => Promise<void>) | undefined, failDirectorySync: false, noDescriptorPaths: false, handles: [] as Fs.FileHandle[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof Fs>();
  return { ...actual,
    open: async (...args: Parameters<typeof Fs.open>) => {
      await hooks.beforeOpen?.(String(args[0]));
      const handle = await actual.open(...args);
      if (String(args[0]).includes('webdcc-save-boundary-') || String(args[0]).startsWith('/proc/self/fd/')) hooks.handles.push(handle);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (hooks.failDirectorySync && typeof args[1] === 'number' && (args[1] & constants.O_DIRECTORY) !== 0) throw new Error('controlled directory sync failure');
        await sync();
      };
      return handle;
    },
    realpath: async (...args: Parameters<typeof Fs.realpath>) => {
      if (hooks.noDescriptorPaths && String(args[0]).startsWith('/proc/self/fd/')) throw Object.assign(new Error('controlled missing descriptor filesystem'), { code: 'ENOENT' });
      return actual.realpath(...args);
    },
    rename: async (...args: Parameters<typeof Fs.rename>) => {
    const replacing = String(args[0]).includes('.webdcc-');
    if (replacing) await hooks.beforeReplace?.();
    await actual.rename(...args);
    if (replacing) await hooks.afterReplace?.();
  } };
});
import { WorkspaceFiles, type FileOperation } from '../src/workspace-files.js';
import { createTestApp } from './helpers.js';

const actual = await vi.importActual<typeof Fs>('node:fs/promises');
const owned: string[] = [];
afterEach(async () => {
  hooks.beforeReplace = undefined; hooks.afterReplace = undefined; hooks.beforeOpen = undefined; hooks.failDirectorySync = false; hooks.noDescriptorPaths = false;
  const descriptors = hooks.handles.splice(0).map(handle => handle.fd);
  for (const path of owned.splice(0)) await actual.rm(path, { recursive: true, force: true });
  expect(descriptors.every(fd => fd === -1)).toBe(true);
});

async function fixture() {
  const base = await actual.mkdtemp(join(tmpdir(), 'webdcc-save-boundary-')); owned.push(base);
  const root = join(base, 'workspace'), parent = join(root, 'docs'), outside = join(base, 'outside'), retired = join(base, 'original-docs');
  await actual.mkdir(parent, { recursive: true }); await actual.mkdir(outside);
  await actual.writeFile(join(parent, 'note.txt'), 'original-inside');
  await actual.writeFile(join(outside, 'note.txt'), 'outside-only-fixture');
  const operations: FileOperation[] = [];
  const files = new WorkspaceFiles(event => operations.push(event));
  const loaded = await files.read('workspace', root, 'docs/note.txt');
  const replaceParent = async () => { await actual.rename(parent, retired); await actual.symlink(outside, parent); };
  return { base, root, parent, outside, retired, files, operations, loaded, replaceParent };
}

it.each(['beforeReplace', 'afterReplace'] as const)('save does not report outside content as the saved file when the parent changes %s', async stage => {
  const ctx = await fixture(); hooks[stage] = ctx.replaceParent;
  const result = await ctx.files.save('workspace', ctx.root, 'docs/note.txt', 'requested-inside-update', ctx.loaded.version!).then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error & { statusCode?: number } }));
  const observed = { returnedContent: result.value?.content, error: result.error?.message, statusCode: result.error?.statusCode, originalFile: await actual.readFile(join(ctx.retired, 'note.txt'), 'utf8'), outsideFile: await actual.readFile(join(ctx.outside, 'note.txt'), 'utf8'), operation: ctx.operations.at(-1) };
  console.info('controlled real filesystem save', JSON.stringify(observed));
  expect(result.error).toMatchObject({ statusCode: 409 });
  expect(result.value).toBeUndefined();
  expect(observed.originalFile).toBe('requested-inside-update');
  expect(observed.outsideFile).toBe('outside-only-fixture');
  expect(observed.operation).toMatchObject({ operation: 'save', outcome: 'conflict', replaced: true, after: createHash('sha256').update('requested-inside-update').digest('hex'), bytes: Buffer.byteLength('requested-inside-update') });
});

it.each(['note.txt', '.webdcc-'])('a parent moved before opening %s cannot be read as a different file or complete a save', async match => {
  const ctx = await fixture();
  hooks.beforeOpen = async path => {
    if (path.startsWith('/proc/self/fd/') && (match === 'note.txt' ? path.endsWith('/note.txt') : path.includes(match))) {
      hooks.beforeOpen = undefined; await ctx.replaceParent();
    }
  };
  await expect(ctx.files.save('workspace', ctx.root, 'docs/note.txt', 'requested', ctx.loaded.version!)).rejects.toMatchObject({ statusCode: 409 });
  expect(await actual.readFile(join(ctx.retired, 'note.txt'), 'utf8')).toBe('original-inside');
  expect(await actual.readFile(join(ctx.outside, 'note.txt'), 'utf8')).toBe('outside-only-fixture');
  expect(await actual.readdir(ctx.retired)).toEqual(['note.txt']);
  expect(ctx.operations.at(-1)).toMatchObject({ outcome: 'conflict' });
  expect(ctx.operations.at(-1)?.after).toBeUndefined();
  expect(ctx.operations.at(-1)?.replaced).toBeUndefined();
});

it('a root replaced with an ordinary directory after rename remains a conflict with the real replacement evidence', async () => {
  const ctx = await fixture(), retiredRoot = join(ctx.base, 'original-workspace');
  hooks.afterReplace = async () => {
    await actual.rename(ctx.root, retiredRoot); await actual.mkdir(join(ctx.root, 'docs'), { recursive: true });
    await actual.writeFile(join(ctx.root, 'docs/note.txt'), 'replacement-root-fixture');
  };
  await expect(ctx.files.save('workspace', ctx.root, 'docs/note.txt', 'requested', ctx.loaded.version!)).rejects.toMatchObject({ statusCode: 409 });
  expect(await actual.readFile(join(retiredRoot, 'docs/note.txt'), 'utf8')).toBe('requested');
  expect(await actual.readFile(join(ctx.root, 'docs/note.txt'), 'utf8')).toBe('replacement-root-fixture');
  expect(ctx.operations.at(-1)).toMatchObject({ outcome: 'conflict', replaced: true, bytes: 9 });
});

it('an external update after replacement is retained and never returned as successful confirmation of the requested payload', async () => {
  const ctx = await fixture();
  hooks.afterReplace = async () => { await actual.writeFile(join(ctx.parent, 'note.txt'), 'agent-follow-up'); };
  await expect(ctx.files.save('workspace', ctx.root, 'docs/note.txt', 'requested', ctx.loaded.version!)).rejects.toMatchObject({ statusCode: 409 });
  expect(await actual.readFile(join(ctx.parent, 'note.txt'), 'utf8')).toBe('agent-follow-up');
  expect(ctx.operations.at(-1)).toMatchObject({ outcome: 'conflict', replaced: true, after: createHash('sha256').update('requested').digest('hex'), bytes: 9 });
  expect(await actual.readdir(ctx.parent)).toEqual(['note.txt']);
});

it('directory sync failure after replacement preserves the applied payload as unconfirmed rather than reporting completion', async () => {
  const ctx = await fixture(); hooks.failDirectorySync = true;
  await expect(ctx.files.save('workspace', ctx.root, 'docs/note.txt', 'requested', ctx.loaded.version!)).rejects.toThrow('保存已替换原文件');
  expect(await actual.readFile(join(ctx.parent, 'note.txt'), 'utf8')).toBe('requested');
  expect(ctx.operations.at(-1)).toMatchObject({ outcome: 'conflict', replaced: true, bytes: 9 });
  expect(await actual.readdir(ctx.parent)).toEqual(['note.txt']);
});

it('unavailable descriptor verification blocks saves before writing and closes both opened directories', async () => {
  const ctx = await fixture(); hooks.noDescriptorPaths = true;
  await expect(ctx.files.save('workspace', ctx.root, 'docs/note.txt', 'requested', ctx.loaded.version!)).rejects.toMatchObject({ statusCode: 501 });
  expect(await actual.readFile(join(ctx.parent, 'note.txt'), 'utf8')).toBe('original-inside');
  expect(await actual.readdir(ctx.parent)).toEqual(['note.txt']);
  expect(ctx.operations.at(-1)).toMatchObject({ outcome: 'failed' });
  expect(ctx.operations.at(-1)?.replaced).toBeUndefined();
});

it('the authenticated production HTTP save reports applied-but-unconfirmed replacement and never returns outside bytes', async () => {
  const ctx = await fixture(), app = await createTestApp();
  try {
    const id = app.store.createWorkspace('controlled-save', ctx.root).id;
    hooks.afterReplace = ctx.replaceParent;
    const response = await app.app.inject({ method: 'PUT', url: `/api/workspaces/${id}/fs`, headers: { cookie: app.cookie }, payload: { path: 'docs/note.txt', content: 'requested', version: ctx.loaded.version } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('保存已替换原文件');
    expect(response.body).not.toContain('outside-only-fixture');
    expect(await actual.readFile(join(ctx.retired, 'note.txt'), 'utf8')).toBe('requested');
    expect(await actual.readFile(join(ctx.outside, 'note.txt'), 'utf8')).toBe('outside-only-fixture');
  } finally { await app.close(); }
});
