import { lstat, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

it('an upload directory replaced with an external symlink cannot overwrite an external chunk path', async () => {
  const ctx = await createTestApp();
  try {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/uploads', headers: { cookie: ctx.cookie }, payload: { name: 'file.txt', size: 6, mime: 'text/plain' } });
    const { uploadId } = response.json() as { uploadId: string };
    const directory = join(ctx.dataDir, 'uploads', uploadId), outside = join(ctx.dataDir, 'outside-fixture');
    await mkdir(outside); await writeFile(join(outside, '0'), 'EXTERN');
    await rename(directory, join(ctx.dataDir, 'original-upload')); await symlink(outside, directory);
    const chunk = await ctx.app.inject({ method: 'PUT', url: `/api/uploads/${uploadId}/chunks/0`, headers: { cookie: ctx.cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('NEWBYT') });
    const outsideContent = await readFile(join(outside, '0'), 'utf8');
    console.info('controlled upload slot write', JSON.stringify({ status: chunk.statusCode, outsideContent, uploadStatus: ctx.files.uploadStatus(uploadId) }));
    expect(chunk.statusCode).toBe(409);
    expect(outsideContent).toBe('EXTERN');
    expect(ctx.files.uploadStatus(uploadId).received).toEqual([]);
  } finally { await ctx.close(); }
});

it.each(['directory', 'chunk'] as const)('upload completion rejects an external %s symlink without publishing its bytes', async kind => {
  const ctx = await createTestApp();
  try {
    const initialized = await ctx.files.initUpload({ name: 'file.txt', size: 6, mime: 'text/plain' });
    await ctx.files.writeChunk(initialized.uploadId, 0, Buffer.from('INSIDE'));
    const directory = join(ctx.dataDir, 'uploads', initialized.uploadId), outside = join(ctx.dataDir, 'outside-fixture');
    await mkdir(outside); await writeFile(join(outside, '0'), 'EXTERN');
    if (kind === 'directory') { await rename(directory, join(ctx.dataDir, 'original-upload')); await symlink(outside, directory); }
    else { await unlink(join(directory, '0')); await symlink(join(outside, '0'), join(directory, '0')); }
    const complete = await ctx.app.inject({ method: 'POST', url: `/api/uploads/${initialized.uploadId}/complete`, headers: { cookie: ctx.cookie } });
    const { fileId } = complete.json() as { fileId?: string };
    const published = fileId === undefined ? undefined : await ctx.app.inject({ url: `/files/${fileId}`, headers: { cookie: ctx.cookie } });
    console.info('controlled upload slot completion', JSON.stringify({ kind, status: complete.statusCode, publishedContent: published?.body, storage: ctx.store.fileStorageUsage() }));
    expect(complete.statusCode).toBe(409);
    expect(fileId).toBeUndefined();
    expect(ctx.store.fileStorageUsage().stored).toBe(0);
    expect(await readFile(join(outside, '0'), 'utf8')).toBe('EXTERN');
  } finally { await ctx.close(); }
});

it('a substituted uploads root blocks writes and cancellation without discarding pending recovery or changing outside data', async () => {
  const ctx = await createTestApp();
  try {
    const { uploadId } = await ctx.files.initUpload({ name: 'file.txt', size: 6, mime: 'text/plain' });
    const outside = join(ctx.dataDir, 'outside-root'); await mkdir(join(outside, uploadId), { recursive: true });
    await writeFile(join(outside, uploadId, '0'), 'EXTERN');
    await rename(join(ctx.dataDir, 'uploads'), join(ctx.dataDir, 'original-uploads')); await symlink(outside, join(ctx.dataDir, 'uploads'));
    await expect(ctx.files.writeChunk(uploadId, 0, Buffer.from('NEWBYT'))).rejects.toMatchObject({ statusCode: 409 });
    await expect(ctx.files.cancelUpload(uploadId)).rejects.toMatchObject({ statusCode: 409 });
    expect(ctx.files.uploadStatus(uploadId).received).toEqual([]);
    expect(await readFile(join(outside, uploadId, '0'), 'utf8')).toBe('EXTERN');
  } finally { await ctx.close(); }
});

it('cancelling a linked slot removes only the link and its pending metadata, retaining outside content', async () => {
  const ctx = await createTestApp();
  try {
    const { uploadId } = await ctx.files.initUpload({ name: 'file.txt', size: 6, mime: 'text/plain' });
    const slot = join(ctx.dataDir, 'uploads', uploadId), outside = join(ctx.dataDir, 'outside-cancel');
    await mkdir(outside); await writeFile(join(outside, '0'), 'EXTERN');
    await rename(slot, join(ctx.dataDir, 'original-slot')); await symlink(outside, slot);
    await ctx.files.cancelUpload(uploadId);
    expect(await lstat(slot).catch(() => undefined)).toBeUndefined();
    expect(ctx.store.getUpload(uploadId)).toBeUndefined();
    expect(await readFile(join(outside, '0'), 'utf8')).toBe('EXTERN');
  } finally { await ctx.close(); }
});

it('a missing acknowledged chunk can be explicitly rewritten, then completed with the original bytes', async () => {
  const ctx = await createTestApp();
  try {
    const { uploadId } = await ctx.files.initUpload({ name: 'file.txt', size: 6, mime: 'text/plain' });
    await ctx.files.writeChunk(uploadId, 0, Buffer.from('INSIDE'));
    await unlink(join(ctx.dataDir, 'uploads', uploadId, '0'));
    await ctx.files.writeChunk(uploadId, 0, Buffer.from('INSIDE'));
    expect(ctx.files.uploadStatus(uploadId).received).toEqual([0]);
    const completed = await ctx.files.completeUpload(uploadId);
    expect((await ctx.files.readAll(completed.fileId))?.buffer.toString()).toBe('INSIDE');
    expect(await readdir(join(ctx.dataDir, 'uploads'))).toEqual([]);
  } finally { await ctx.close(); }
});

it('unsupported platform verification blocks upload writes while initialization retains pending uploads and existing file access', async () => {
  const ctx = await createTestApp();
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    const { uploadId } = await ctx.files.initUpload({ name: 'file.txt', size: 6, mime: 'text/plain' });
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    await expect(ctx.files.init()).resolves.toBeUndefined();
    await expect(ctx.files.writeChunk(uploadId, 0, Buffer.from('INSIDE'))).rejects.toMatchObject({ statusCode: 501 });
    await expect(ctx.files.initUpload({ name: 'other.txt', size: 0, mime: 'text/plain' })).rejects.toMatchObject({ statusCode: 501 });
    expect(ctx.files.uploadStatus(uploadId).received).toEqual([]);
    expect(await readdir(join(ctx.dataDir, 'uploads', uploadId))).toEqual([]);
  } finally { Object.defineProperty(process, 'platform', platform); await ctx.close(); }
});
