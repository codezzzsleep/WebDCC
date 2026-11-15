import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.close();
});

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

describe('A6-6f 可续传上传', () => {
  it('分块上传、断点续传、sha256 校验与不可变缓存头', async () => {
    const chunkSize = 1024 * 1024;
    const payload = randomBytes(chunkSize * 2);
    const digest = sha256(payload);

    const init = await ctx.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { cookie: ctx.cookie },
      payload: { name: 'big.bin', size: payload.byteLength, sha256: digest, mime: 'application/octet-stream' },
    });
    expect(init.statusCode).toBe(200);
    const { uploadId, chunkSize: returnedChunk } = init.json() as { uploadId: string; chunkSize: number };
    expect(returnedChunk).toBe(chunkSize);

    // 第一块
    const first = await ctx.app.inject({
      method: 'PUT',
      url: `/api/uploads/${uploadId}/chunks/0`,
      headers: { cookie: ctx.cookie, 'content-type': 'application/octet-stream' },
      payload: payload.subarray(0, chunkSize),
    });
    expect(first.statusCode).toBe(200);

    // 模拟断网：查状态，只剩第一块
    const status = await ctx.app.inject({ method: 'GET', url: `/api/uploads/${uploadId}`, headers: { cookie: ctx.cookie } });
    expect((status.json() as { received: number[] }).received).toEqual([0]);

    // 续传第二块
    const second = await ctx.app.inject({
      method: 'PUT',
      url: `/api/uploads/${uploadId}/chunks/1`,
      headers: { cookie: ctx.cookie, 'content-type': 'application/octet-stream' },
      payload: payload.subarray(chunkSize),
    });
    expect(second.statusCode).toBe(200);

    const complete = await ctx.app.inject({
      method: 'POST',
      url: `/api/uploads/${uploadId}/complete`,
      headers: { cookie: ctx.cookie },
    });
    expect(complete.statusCode).toBe(200);
    const { fileId, url } = complete.json() as { fileId: string; url: string };
    expect(url).toBe(`/files/${fileId}`);

    const file = await ctx.app.inject({ method: 'GET', url, headers: { cookie: ctx.cookie } });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(payload)).toBe(true);
    expect(String(file.headers['cache-control'])).toContain('immutable');
    expect(String(file.headers['cache-control'])).toContain('private');
    expect(file.headers['etag']).toBe(`"${digest}"`);

    // 秒传：同样的 sha256 直接返回现成 fileId
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { cookie: ctx.cookie },
      payload: { name: 'big2.bin', size: payload.byteLength, sha256: digest, mime: 'application/octet-stream' },
    });
    const aliasId = (again.json() as { existingFileId?: string }).existingFileId!;
    expect(ctx.store.getFile(aliasId)).toMatchObject({ name: 'big2.bin', sha256: digest });
    expect(ctx.store.getFile(fileId)).toMatchObject({ name: 'big.bin', sha256: digest });
    expect(ctx.store.fileStorageUsage().stored).toBe(payload.length);

    // Range 请求
    const ranged = await ctx.app.inject({
      method: 'GET',
      url,
      headers: { cookie: ctx.cookie, range: 'bytes=0-15' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.rawPayload.equals(payload.subarray(0, 16))).toBe(true);
  });

  it('sha256 不匹配时拒绝', async () => {
    const payload = randomBytes(1024);
    const init = await ctx.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { cookie: ctx.cookie },
      payload: { name: 'bad.bin', size: payload.byteLength, sha256: '0'.repeat(64), mime: 'application/octet-stream' },
    });
    const { uploadId } = init.json() as { uploadId: string };
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/uploads/${uploadId}/chunks/0`,
      headers: { cookie: ctx.cookie, 'content-type': 'application/octet-stream' },
      payload,
    });
    const complete = await ctx.app.inject({
      method: 'POST',
      url: `/api/uploads/${uploadId}/complete`,
      headers: { cookie: ctx.cookie },
    });
    expect(complete.statusCode).toBe(400);
  });

  it('没有客户端 sha256 时由服务端完成校验并保存', async () => {
    const payload = Buffer.from('insecure-http-upload');
    const init = await ctx.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { cookie: ctx.cookie },
      payload: { name: 'fallback.txt', size: payload.byteLength, mime: 'text/plain' },
    });
    expect(init.statusCode).toBe(200);
    const { uploadId } = init.json() as { uploadId: string };
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/uploads/${uploadId}/chunks/0`,
      headers: { cookie: ctx.cookie, 'content-type': 'application/octet-stream' },
      payload,
    });
    const complete = await ctx.app.inject({ method: 'POST', url: `/api/uploads/${uploadId}/complete`, headers: { cookie: ctx.cookie } });
    expect(complete.statusCode).toBe(200);
  });

  it('无 Cookie 访问上传与文件一律 401', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/files/whatever' });
    expect(response.statusCode).toBe(401);
    const upload = await ctx.app.inject({ method: 'POST', url: '/api/uploads', payload: {} });
    expect(upload.statusCode).toBe(401);
  });
});
