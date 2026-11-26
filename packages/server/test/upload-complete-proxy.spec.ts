import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';
import { UploadController, type UploadTask } from '../../web/src/lib/upload-controller.js';

it('completes a byte-exact upload through a proxy that forwards POST bodies as chunked', async () => {
  const ctx = await createTestApp();
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const address = ctx.app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  const proxy = createServer((incoming, outgoing) => {
    const headers = { ...incoming.headers, cookie: ctx.cookie, host: `127.0.0.1:${address.port}` };
    delete headers['content-length'];
    if (incoming.method === 'POST') headers['transfer-encoding'] = 'chunked';
    const upstream = request({ host: '127.0.0.1', port: address.port, path: incoming.url, method: incoming.method, headers }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => { outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(upstream);
  });
  try {
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Missing proxy');
    const base = `http://127.0.0.1:${proxyAddress.port}`;
    // The historical empty POST fails before the upload route. Keep this
    // transport negative alongside the actual browser controller's request.
    const empty = await fetch(`${base}/api/uploads/00000000-0000-0000-0000-000000000000/complete`, { method: 'POST' });
    expect(empty.status).toBe(415);
    const tasks = new Map<string, UploadTask>();
    const uploads = new UploadController({ endpoint: `${base}/api/uploads`, store: {
      getUpload: async id => tasks.get(id),
      listUploads: async id => [...tasks.values()].filter(task => task.sessionId === id),
      putUpload: async task => { tasks.set(task.id, task); },
    } });
    const bytes = Buffer.from('original upload\r\n代理字节');
    const task = await uploads.create('draft', new File([bytes], 'proxy.txt', { type: 'text/plain' }), 'file');
    const completed = await uploads.resume(task.id);
    expect(completed.state).toBe('completed');
    const stored = await ctx.files.readAll(completed.fileId!);
    expect(stored?.buffer.equals(bytes)).toBe(true);
    expect(stored?.file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    await ctx.close();
  }
});
