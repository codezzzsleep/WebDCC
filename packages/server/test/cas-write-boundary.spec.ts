import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Fs from 'node:fs';

const hooks = vi.hoisted(() => ({ beforeRename: undefined as (() => void) | undefined, afterRename: undefined as (() => void) | undefined }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof Fs>();
  return { ...actual, renameSync: (...args: Parameters<typeof Fs.renameSync>) => {
    const publishing = String(args[0]).includes('.webdcc-');
    if (publishing) hooks.beforeRename?.();
    actual.renameSync(...args);
    if (publishing) hooks.afterRename?.();
  } };
});
import { createTestApp } from './helpers.js';
const actualFs = await vi.importActual<typeof Fs>('node:fs');
afterEach(() => { hooks.beforeRename = undefined; hooks.afterRename = undefined; });

it.each([
  ['async', 'directory'], ['sync', 'directory'], ['async', 'object'], ['sync', 'object'],
] as const)('%s CAS writes reject an external %s link without changing its bytes or inserting a successful file', async (mode, kind) => {
  const ctx = await createTestApp();
  try {
    const payload = Buffer.from('NATIVE-DIFF'), hash = createHash('sha256').update(payload).digest('hex');
    const prefix = join(ctx.dataDir, 'files', hash.slice(0, 2)), outside = join(ctx.dataDir, 'outside-cas');
    await mkdir(outside);
    const victim = join(outside, kind === 'directory' ? hash : 'victim.txt'); await writeFile(victim, 'EXTERNAL');
    if (kind === 'directory') await symlink(outside, prefix);
    else { await mkdir(prefix); await symlink(victim, join(prefix, hash)); }
    const result = await Promise.resolve().then(() => mode === 'async' ? ctx.files.putBuffer(payload, 'change.diff', 'text/x-diff') : ctx.files.putBufferSync(payload, 'change.diff', 'text/x-diff')).then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as { statusCode?: number } }));
    const outsideContent = await readFile(victim, 'utf8');
    console.info('controlled production CAS writer', JSON.stringify({ mode, kind, error: result.error, inserted: result.value !== undefined, outsideContent }));
    expect(result.error).toMatchObject({ statusCode: 409 });
    expect(result.value).toBeUndefined();
    expect(outsideContent).toBe('EXTERNAL');
    expect(ctx.store.getFileBySha(hash)).toBeUndefined();
  } finally { await ctx.close(); }
});

it.each([
  ['async', 'beforeRename'], ['sync', 'beforeRename'], ['async', 'afterRename'], ['sync', 'afterRename'],
] as const)('%s CAS publication records the original committed object when its prefix changes %s', async (mode, stage) => {
  const ctx = await createTestApp();
  try {
    const payload = Buffer.from('COMMITTED'), hash = createHash('sha256').update(payload).digest('hex');
    const prefix = join(ctx.dataDir, 'files', hash.slice(0, 2)), retired = join(ctx.dataDir, 'retired-prefix'), outside = join(ctx.dataDir, 'outside-race');
    await mkdir(outside); await writeFile(join(outside, hash), 'EXTERNAL');
    hooks[stage] = () => { actualFs.renameSync(prefix, retired); actualFs.symlinkSync(outside, prefix); };
    const result = await Promise.resolve().then(() => mode === 'async' ? ctx.files.putBuffer(payload, 'change.diff', 'text/x-diff') : ctx.files.putBufferSync(payload, 'change.diff', 'text/x-diff')).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    expect(result.error).toMatchObject({ statusCode: 409, code: 'cas-published-unconfirmed', published: true, sha256: hash });
    expect(result.value).toBeUndefined();
    expect(ctx.store.getFileBySha(hash)).toBeUndefined();
    expect(await readFile(join(retired, hash), 'utf8')).toBe('COMMITTED');
    expect(await readFile(join(outside, hash), 'utf8')).toBe('EXTERNAL');
    expect(await readdir(retired)).toEqual([hash]);
  } finally { await ctx.close(); }
});

it('healthy CAS bytes are reused across sync/async aliases and explicit known-byte repair never writes a linked external object', async () => {
  const ctx = await createTestApp();
  try {
    const payload = Buffer.from('IDENTITY'), hash = createHash('sha256').update(payload).digest('hex');
    const original = ctx.files.putBufferSync(payload, 'original.txt', 'text/plain'), object = ctx.files.objectPath(hash);
    const identity = await lstat(object);
    const alias = await ctx.files.putBuffer(payload, 'alias.txt', 'application/octet-stream');
    expect(alias.id).not.toBe(original.id); expect(alias.sha256).toBe(original.sha256);
    expect((await lstat(object)).ino).toBe(identity.ino);
    const external = join(ctx.dataDir, 'outside-repair'); await writeFile(external, 'EXTERNAL');
    await rm(object); await symlink(external, object);
    const { uploadId } = await ctx.files.initUpload({ name: 'original.txt', size: payload.length, sha256: hash, mime: 'text/plain' });
    await ctx.files.writeChunk(uploadId, 0, payload); const completed = await ctx.files.completeUpload(uploadId);
    expect(completed.fileId).toBe(original.id);
    expect(await readFile(object, 'utf8')).toBe('IDENTITY');
    expect((await lstat(object)).isSymbolicLink()).toBe(false);
    expect(await readFile(external, 'utf8')).toBe('EXTERNAL');
  } finally { await ctx.close(); }
});
