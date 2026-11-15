import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, MAX_FILE_SIZE, FileStore } from '../src/files.js';
import { createTestApp, TEST_TOKEN, type TestApp } from './helpers.js';

let ctx: TestApp;
beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('NP-13 authenticated content and request boundaries', () => {
  it.each(['text/html', 'image/svg+xml', 'image/png'])('downloads active content even when declared as %s', async mime => {
    const file = await ctx.files.putBuffer(Buffer.from(`<script>fetch("/api/commands")</script><!--${mime}-->`), 'active.html', mime);
    for (const extra of [{}, { range: 'bytes=0-8' }, { 'if-none-match': `"${file.sha256}"` }]) {
      const response = await ctx.app.inject({ url: `/files/${file.id}`, headers: { cookie: ctx.cookie, ...extra } });
      expect([200, 206, 304]).toContain(response.statusCode);
      expect(response.headers['content-type']).toBe('application/octet-stream');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toContain('sandbox');
    }
  });

  it('serves a verified raster image inline despite a misleading declaration', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const file = await ctx.files.putBuffer(png, 'image.html', 'text/html');
    const response = await ctx.app.inject({ url: `/files/${file.id}`, headers: { cookie: ctx.cookie } });
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.rawPayload).toEqual(png);
  });

  it.each(['https://evil.example', 'null', 'http://localhost.evil.example'])('rejects mutation from %s before execution', async origin => {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie: ctx.cookie, origin }, payload: { name: 'blocked', path: ctx.dataDir } });
    expect(response.statusCode).toBe(403);
    expect(ctx.store.listWorkspaces()).toEqual([]);
  });

  it('rejects a cross-site request without Origin and a WebSocket with an alien Origin', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie: ctx.cookie, 'sec-fetch-site': 'cross-site' }, payload: {} })).statusCode).toBe(403);
    expect((await ctx.app.inject({ url: '/api/ws', headers: { cookie: ctx.cookie, origin: 'http://evil.example', upgrade: 'websocket' } })).statusCode).toBe(403);
  });

  it('rejects an unregistered Host even with a valid legacy cookie', async () => {
    const response = await ctx.app.inject({ url: '/api/meta', headers: { cookie: ctx.cookie, host: 'evil.example' } });
    expect(response.statusCode).toBe(403);
  });

  it('treats malformed cookie encoding as unauthenticated', async () => {
    const response = await ctx.app.inject({ url: '/api/meta', headers: { cookie: 'wdcc-auth=%ZZ' } });
    expect(response.statusCode).toBe(401);
  });

  it('supports a registered HTTPS origin through an explicitly trusted proxy', async () => {
    const proxy = await createTestApp({}, TEST_TOKEN, { publicOrigins: ['https://dcc.example'], trustProxy: ['127.0.0.1'] });
    try {
      const headers = { host: 'dcc.example', 'x-forwarded-proto': 'https', origin: 'https://dcc.example' };
      const login = await proxy.app.inject({ url: `/?token=${TEST_TOKEN}`, headers });
      expect(login.statusCode).toBe(302);
      expect(login.headers['set-cookie']).toContain('Secure');
      const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
      const mutation = await proxy.app.inject({ method: 'POST', url: '/api/workspaces', headers: { ...headers, cookie }, payload: { name: 'proxy', path: proxy.dataDir } });
      expect(mutation.statusCode).toBe(200);
      expect((await proxy.app.inject({ method: 'POST', url: '/api/workspaces', headers: { ...headers, cookie, origin: 'https://evil.example' }, payload: {} })).statusCode).toBe(403);
    } finally { await proxy.close(); }
  });
});

describe('NP-13 resumable upload integrity', () => {
  it.each([-1, 0.5, MAX_FILE_SIZE + 1])('rejects invalid declared size %s', async size => {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/uploads', headers: { cookie: ctx.cookie }, payload: { name: 'x', size } });
    expect([400, 413]).toContain(response.statusCode);
  });

  it('rejects malformed digest, MIME and names', async () => {
    for (const patch of [{ sha256: 'deadbeef' }, { mime: 123 }, { name: '../x' }, { name: 'a\r\nb' }]) {
      const response = await ctx.app.inject({ method: 'POST', url: '/api/uploads', headers: { cookie: ctx.cookie }, payload: { name: 'x', size: 1, ...patch } });
      expect(response.statusCode).toBe(400);
    }
  });

  it('rejects invalid indices and chunk lengths and preserves accepted bytes on a conflicting retry', async () => {
    const { uploadId } = await ctx.files.initUpload({ name: 'x', size: CHUNK_SIZE + 1, mime: 'application/octet-stream' });
    for (const index of [-1, 0.5, 2, Number.NaN]) await expect(ctx.files.writeChunk(uploadId, index, Buffer.alloc(1))).rejects.toMatchObject({ statusCode: 400 });
    await expect(ctx.files.writeChunk(uploadId, 0, Buffer.alloc(1))).rejects.toMatchObject({ statusCode: 400 });
    const chunk = Buffer.alloc(CHUNK_SIZE, 65);
    await ctx.files.writeChunk(uploadId, 0, chunk);
    await ctx.files.writeChunk(uploadId, 0, chunk);
    await expect(ctx.files.writeChunk(uploadId, 0, Buffer.alloc(CHUNK_SIZE, 66))).rejects.toMatchObject({ statusCode: 409 });
    await expect(ctx.files.completeUpload(uploadId)).rejects.toMatchObject({ statusCode: 400 });
    await ctx.files.writeChunk(uploadId, 1, Buffer.from('b'));
    const { fileId } = await ctx.files.completeUpload(uploadId);
    expect((await ctx.files.readAll(fileId))?.buffer.equals(Buffer.concat([chunk, Buffer.from('b')]))).toBe(true);
  });

  it('does not accept sparse indices even if their byte count matches the declaration', async () => {
    const { uploadId } = await ctx.files.initUpload({ name: 'sparse', size: 3, mime: 'application/octet-stream' });
    // Simulate an upload persisted by the old implementation.
    ctx.store.setUploadReceived(uploadId, [3]);
    await expect(ctx.files.completeUpload(uploadId)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('serializes parallel chunks, resumes from disk and releases quota on cancellation', async () => {
    const own = await createTestApp();
    try {
      const files = new FileStore(own.dataDir, own.store, { maxPendingBytes: CHUNK_SIZE + 1 });
      const { uploadId } = await files.initUpload({ name: 'parallel', size: CHUNK_SIZE + 1, mime: 'application/octet-stream' });
      await expect(files.initUpload({ name: 'quota', size: 1, mime: 'text/plain' })).rejects.toMatchObject({ statusCode: 413 });
      await Promise.all([files.writeChunk(uploadId, 0, Buffer.alloc(CHUNK_SIZE)), files.writeChunk(uploadId, 1, Buffer.from('x'))]);
      const resumed = new FileStore(own.dataDir, own.store);
      await resumed.init();
      expect(resumed.uploadStatus(uploadId).received).toEqual([0, 1]);
      await resumed.cancelUpload(uploadId);
      await expect(files.initUpload({ name: 'quota', size: 1, mime: 'text/plain' })).resolves.toHaveProperty('uploadId');
      await resumed.cleanupUploads(Date.now() + 48 * 60 * 60 * 1000);
      expect(own.store.listUploads()).toEqual([]);
    } finally { await own.close(); }
  });
});
