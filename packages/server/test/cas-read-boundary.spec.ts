import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestApp } from './helpers.js';

const opened = vi.hoisted(() => ({ files: [] as FileHandle[] }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof fs>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args); opened.files.push(file); return file;
  } };
});
beforeEach(() => { opened.files = []; });
afterEach(async () => {
  const leaked = opened.files.filter(file => file.fd !== -1);
  await Promise.all(leaked.map(file => file.close()));
  expect(leaked).toEqual([]);
});

it.each(['download', 'admission'] as const)('rejects a CAS prefix replaced after directory validation before %s opens its object', async operation => {
  const ctx = await createTestApp();
  try {
    const bytes = Buffer.from('known attachment identity\r\n');
    const file = await ctx.files.putBuffer(bytes, 'identity.txt', 'text/plain');
    const prefix = dirname(ctx.files.objectPath(file.sha256));
    const external = join(ctx.dataDir, 'controlled-outside-cas');
    await fs.mkdir(external);
    // Equal bytes keep the existing SHA gate intact: this exercises path
    // authority, rather than alleging disclosure of arbitrary other content.
    await fs.writeFile(join(external, file.sha256), bytes);
    const lstat = fs.lstat;
    const hook = vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const result = await lstat(...args);
      if (String(args[0]) === prefix) {
        hook.mockRestore();
        await fs.rename(prefix, `${prefix}-moved`);
        await fs.symlink(external, prefix);
      }
      return result;
    });
    try {
      if (operation === 'download') {
        const response = await ctx.app.inject({ url: `/files/${file.id}`, headers: { cookie: ctx.cookie } });
        console.info('CAS read receipt', JSON.stringify({ operation, status: response.statusCode, returnedBytes: response.body, currentPath: await fs.realpath(ctx.files.objectPath(file.sha256)) }));
        expect(response.statusCode).toBe(409);
        expect(response.body).not.toBe(bytes.toString());
      } else {
        const result = await ctx.files.resolveAttachment({ type: 'file', fileId: file.id }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
        console.info('CAS read receipt', JSON.stringify({ operation, result }));
        expect(result.error).toMatchObject({ statusCode: 409 });
      }
      expect(await fs.readFile(join(external, file.sha256))).toEqual(bytes);
    } finally { hook.mockRestore(); }
  } finally { await ctx.close(); }
});

it('rejects a prefix changed after hashing and closes every pinned handle', async () => {
  const ctx = await createTestApp();
  try {
    const bytes = Buffer.from('hash gate remains valid');
    const file = await ctx.files.putBuffer(bytes, 'identity.txt', 'text/plain');
    const target = ctx.files.objectPath(file.sha256), prefix = dirname(target);
    const external = join(ctx.dataDir, 'controlled-outside-cas');
    await fs.mkdir(external); await fs.writeFile(join(external, file.sha256), bytes);
    const original = fs.lstat;
    let checks = 0, triggered = false;
    const hook = vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const result = await original(...args);
      if (String(args[0]) === target && ++checks === 2) {
        hook.mockRestore(); triggered = true;
        await fs.rename(prefix, `${prefix}-moved`); await fs.symlink(external, prefix);
      }
      return result;
    });
    try {
      await expect(ctx.files.readAll(file.id)).rejects.toMatchObject({ statusCode: 409 });
      expect(triggered).toBe(true);
    } finally { hook.mockRestore(); }
  } finally { await ctx.close(); }
});

it('rejects a files root replaced after opening the object without returning a successful attachment', async () => {
  const ctx = await createTestApp();
  try {
    const bytes = Buffer.from('root identity');
    const file = await ctx.files.putBuffer(bytes, 'identity.txt', 'text/plain');
    const root = join(ctx.dataDir, 'files');
    const external = join(ctx.dataDir, 'controlled-outside-root');
    await fs.mkdir(join(external, file.sha256.slice(0, 2)), { recursive: true });
    await fs.writeFile(join(external, file.sha256.slice(0, 2), file.sha256), bytes);
    const original = fs.open;
    let triggered = false;
    const hook = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith(`/${file.sha256}`)) {
        hook.mockRestore(); triggered = true;
        await fs.rename(root, `${root}-moved`); await fs.symlink(external, root);
      }
      return handle;
    });
    try {
      await expect(ctx.files.resolveAttachment({ type: 'file', fileId: file.id })).rejects.toMatchObject({ statusCode: 409 });
      expect(triggered).toBe(true);
    } finally { hook.mockRestore(); }
  } finally { await ctx.close(); }
});

it('the stream helper yields verified exact bytes and rejects an object symlink instead of streaming its target', async () => {
  const ctx = await createTestApp();
  try {
    const bytes = Buffer.from('exact stream bytes\r\n');
    const file = await ctx.files.putBuffer(bytes, 'identity.txt', 'text/plain');
    const found = await ctx.files.createReadStream(file.id);
    const chunks: Buffer[] = [];
    for await (const chunk of found!.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    const outside = join(ctx.dataDir, 'external-stream-fixture');
    await fs.writeFile(outside, 'not the file identity');
    await fs.rm(ctx.files.objectPath(file.sha256)); await fs.symlink(outside, ctx.files.objectPath(file.sha256));
    await expect(ctx.files.createReadStream(file.id)).rejects.toMatchObject({ statusCode: 409 });
    expect((await fs.readFile(outside)).toString()).toBe('not the file identity');
  } finally { await ctx.close(); }
});

it('returns a missing-object error and preserves empty-object range and ETag behavior', async () => {
  const ctx = await createTestApp();
  try {
    const empty = await ctx.files.putBuffer(Buffer.alloc(0), 'empty.txt', 'text/plain');
    const found = await ctx.app.inject({ url: `/files/${empty.id}`, headers: { cookie: ctx.cookie } });
    expect(found.statusCode).toBe(200); expect(found.rawPayload).toEqual(Buffer.alloc(0));
    expect((await ctx.app.inject({ url: `/files/${empty.id}`, headers: { cookie: ctx.cookie, 'if-none-match': `"${empty.sha256}"` } })).statusCode).toBe(304);
    await fs.rm(ctx.files.objectPath(empty.sha256));
    expect((await ctx.app.inject({ url: `/files/${empty.id}`, headers: { cookie: ctx.cookie } })).statusCode).toBe(404);
    await expect(ctx.files.resolveAttachment({ type: 'file', fileId: empty.id })).rejects.toMatchObject({ statusCode: 404 });
  } finally { await ctx.close(); }
});

it('fails closed when the platform cannot verify descriptors while leaving the stored object unchanged', async () => {
  const ctx = await createTestApp();
  try {
    const bytes = Buffer.from('ordinary object remains intact');
    const file = await ctx.files.putBuffer(bytes, 'identity.txt', 'text/plain');
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try { await expect(ctx.files.readAll(file.id)).rejects.toMatchObject({ statusCode: 501 }); }
    finally { platform.mockRestore(); }
    expect((await ctx.files.readAll(file.id))?.buffer).toEqual(bytes);
  } finally { await ctx.close(); }
});

it('rejects a replaced data root and preserves both the moved original and outside bytes', async () => {
  const ctx = await createTestApp();
  const moved = `${ctx.dataDir}-moved`;
  const external = await fs.mkdtemp(`${ctx.dataDir}-external-`);
  try {
    const bytes = Buffer.from('data root identity');
    const file = await ctx.files.putBuffer(bytes, 'identity.txt', 'text/plain');
    const externalPath = join(external, 'files', file.sha256.slice(0, 2), file.sha256);
    await fs.mkdir(dirname(externalPath), { recursive: true }); await fs.writeFile(externalPath, bytes);
    const original = fs.open;
    let triggered = false;
    const hook = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith(`/${file.sha256}`)) {
        hook.mockRestore(); triggered = true;
        await fs.rename(ctx.dataDir, moved); await fs.symlink(external, ctx.dataDir);
      }
      return handle;
    });
    try {
      await expect(ctx.files.readAll(file.id)).rejects.toMatchObject({ statusCode: 409 });
      expect(triggered).toBe(true);
      expect(await fs.readFile(externalPath)).toEqual(bytes);
      expect(await fs.readFile(join(moved, 'files', file.sha256.slice(0, 2), file.sha256))).toEqual(bytes);
    } finally { hook.mockRestore(); }
  } finally { await ctx.close(); await fs.rm(moved, { recursive: true, force: true }); await fs.rm(external, { recursive: true, force: true }); }
});

it('reports descriptor verification unavailable before reading if proc cannot resolve the pinned handle', async () => {
  const ctx = await createTestApp();
  try {
    const bytes = Buffer.from('proc verification identity');
    const file = await ctx.files.putBuffer(bytes, 'identity.txt', 'text/plain');
    const original = fs.realpath;
    let triggered = false;
    const hook = vi.spyOn(fs, 'realpath').mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
      if (String(args[0]).startsWith('/proc/self/fd/')) { triggered = true; throw Object.assign(new Error('controlled missing proc'), { code: 'ENOENT' }); }
      return original(...args);
    });
    try {
      await expect(ctx.files.readAll(file.id)).rejects.toMatchObject({ statusCode: 501 });
      expect(triggered).toBe(true);
    } finally { hook.mockRestore(); }
    expect((await ctx.files.readAll(file.id))?.buffer).toEqual(bytes);
  } finally { await ctx.close(); }
});

it('rejects a returned attachment path changed after object open, instead of attesting a path to different bytes', async () => {
  const ctx = await createTestApp();
  try {
    const bytes = Buffer.from('verified bytes');
    const file = await ctx.files.putBuffer(bytes, 'identity.txt', 'text/plain');
    const target = ctx.files.objectPath(file.sha256), prefix = dirname(target);
    const external = join(ctx.dataDir, 'controlled-outside-cas');
    await fs.mkdir(external); await fs.writeFile(join(external, file.sha256), 'unverified replacement bytes');
    const originalOpen = fs.open;
    const hook = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(`/${file.sha256}`)) {
        hook.mockRestore();
        await fs.rename(prefix, `${prefix}-moved`);
        await fs.symlink(external, prefix);
      }
      return handle;
    });
    try {
      const result = await ctx.files.resolveAttachment({ type: 'file', fileId: file.id }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      const currentBytes = (await fs.readFile(target)).toString();
      console.info('CAS path attestation receipt', JSON.stringify({ result, currentBytes }));
      expect(currentBytes).toBe('unverified replacement bytes');
      expect(result.error).toMatchObject({ statusCode: 409 });
    } finally { hook.mockRestore(); }
  } finally { await ctx.close(); }
});

it('rejects a path replaced during async handle cleanup before the verified attachment is returned', async () => {
  const ctx = await createTestApp();
  try {
    const bytes = Buffer.from('cleanup window identity');
    const file = await ctx.files.putBuffer(bytes, 'identity.txt', 'text/plain');
    const target = ctx.files.objectPath(file.sha256), prefix = dirname(target);
    const external = join(ctx.dataDir, 'controlled-cleanup-outside');
    await fs.mkdir(external); await fs.writeFile(join(external, file.sha256), 'replaced during cleanup');
    const original = fs.open;
    let triggered = false;
    const hook = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith(`/${file.sha256}`)) {
        hook.mockRestore();
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close(); triggered = true;
          await fs.rename(prefix, `${prefix}-moved`); await fs.symlink(external, prefix);
        };
      }
      return handle;
    });
    try {
      await expect(ctx.files.resolveAttachment({ type: 'file', fileId: file.id })).rejects.toMatchObject({ statusCode: 409 });
      expect(triggered).toBe(true);
      expect((await fs.readFile(target)).toString()).toBe('replaced during cleanup');
    } finally { hook.mockRestore(); }
  } finally { await ctx.close(); }
});
