import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyReply } from 'fastify';
import type * as FsPromises from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceFiles } from '../src/workspace-files.js';
import { sendWorkspaceAsset, workspaceAsset } from '../src/workspace-assets.js';

const timing = vi.hoisted(() => ({ beforeOpen: undefined as ((path: string) => Promise<void>) | undefined, handles: [] as FileHandle[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof FsPromises>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    await timing.beforeOpen?.(String(args[0]));
    const file = await fs.open(...args); timing.handles.push(file); return file;
  } };
});

let base: string; let root: string; let outside: string;
beforeEach(async () => {
  timing.beforeOpen = undefined; timing.handles = [];
  base = await mkdtemp(join(tmpdir(), 'wdcc-workspace-read-')); root = join(base, 'workspace'); outside = join(base, 'outside');
  await mkdir(join(root, 'folder'), { recursive: true }); await mkdir(outside);
  await writeFile(join(root, 'folder', 'proof.txt'), 'inside-only'); await writeFile(join(outside, 'proof.txt'), 'outside-fixture');
});
afterEach(async () => {
  timing.beforeOpen = undefined;
  await Promise.all(timing.handles.filter(file => file.fd !== -1).map(file => file.close()));
  await rm(base, { recursive: true, force: true });
});

async function replaceAncestor() {
  await rename(join(root, 'folder'), join(root, 'original')); await symlink(outside, join(root, 'folder'));
}
function reply() {
  const headers: Record<string, unknown> = {}; const chunks: Buffer[] = [];
  return { headers, chunks, header(name: string, value: unknown) { headers[name] = value; return this; },
    async send(stream: AsyncIterable<Buffer>) { for await (const bytes of stream) chunks.push(bytes); return this; } };
}

it('raw assets reject an ancestor symlink replaced after canonical path validation, before returning outside bytes', async () => {
  const target = await workspaceAsset(root, 'folder/proof.txt'); await replaceAncestor();
  const response = reply();
  await expect(sendWorkspaceAsset(response as unknown as FastifyReply, target, root)).rejects.toMatchObject({ statusCode: 409 });
  expect(response.chunks).toEqual([]);
  expect(timing.handles.every(file => file.fd === -1)).toBe(true);
});

it('text reads reject an ancestor replaced between realpath/stat and file open', async () => {
  timing.beforeOpen = async path => { if (path.endsWith('/proof.txt')) { timing.beforeOpen = undefined; await replaceAncestor(); } };
  await expect(new WorkspaceFiles().read('workspace', root, 'folder/proof.txt')).rejects.toMatchObject({ statusCode: 409 });
  expect(timing.handles.every(file => file.fd === -1)).toBe(true);
});

it('text size, content and hash describe the same opened file when its path is replaced before open', async () => {
  const content = 'replacement inside the workspace';
  timing.beforeOpen = async path => {
    if (path.endsWith('/proof.txt')) {
      timing.beforeOpen = undefined; await rename(join(root, 'folder', 'proof.txt'), join(root, 'folder', 'old.txt'));
      await writeFile(join(root, 'folder', 'proof.txt'), content);
    }
  };
  const result = await new WorkspaceFiles().read('workspace', root, 'folder/proof.txt');
  expect(result.content).toBe(content); expect(result.size).toBe(Buffer.byteLength(content));
  expect(result.version).toBe((await import('node:crypto')).createHash('sha256').update(content).digest('hex'));
  expect(timing.handles.every(file => file.fd === -1)).toBe(true);
});

it('raw header failures close the verified file without sending bytes', async () => {
  const response = reply(); response.header = () => { throw new Error('Header failure'); };
  await expect(sendWorkspaceAsset(response as unknown as FastifyReply, await workspaceAsset(root, 'folder/proof.txt'), root)).rejects.toThrow('Header failure');
  expect(timing.handles.every(file => file.fd === -1)).toBe(true);
  expect(response.chunks).toEqual([]);
});

it('raw and text retain in-workspace symlink content and safe download headers', async () => {
  await symlink('folder/proof.txt', join(root, 'alias.txt'));
  const response = reply();
  await sendWorkspaceAsset(response as unknown as FastifyReply, await workspaceAsset(root, 'alias.txt'), root);
  expect(Buffer.concat(response.chunks).toString()).toBe('inside-only');
  expect(response.headers['content-disposition']).toContain('attachment');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect((await new WorkspaceFiles().read('workspace', root, 'alias.txt')).content).toBe('inside-only');
  expect(await readFile(join(outside, 'proof.txt'), 'utf8')).toBe('outside-fixture');
});

it('raw final symlink replacement and non-regular files are rejected and all handles close', async () => {
  const target = await workspaceAsset(root, 'folder/proof.txt');
  await rename(target, join(root, 'folder', 'old.txt')); await symlink(join(outside, 'proof.txt'), target);
  await expect(sendWorkspaceAsset(reply() as unknown as FastifyReply, target, root)).rejects.toMatchObject({ statusCode: 409 });
  await expect(sendWorkspaceAsset(reply() as unknown as FastifyReply, join(root, 'folder'), root)).rejects.toMatchObject({ statusCode: 400 });
  expect(timing.handles.every(file => file.fd === -1)).toBe(true);
});

it('hosts without descriptor path verification reject reads without opening unverified files', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  try {
    await expect(new WorkspaceFiles().read('workspace', root, 'folder/proof.txt')).rejects.toMatchObject({ statusCode: 501 });
    expect(timing.handles).toEqual([]);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

