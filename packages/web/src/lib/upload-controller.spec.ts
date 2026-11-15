import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { UploadController, type UploadTask, type UploadTaskStore } from './upload-controller.js';

export class MemoryUploadStore implements UploadTaskStore {
  readonly values = new Map<string, UploadTask>();
  async getUpload(id: string) { const task = this.values.get(id); return task === undefined ? undefined : structuredClone(task); }
  async listUploads(sessionId: string) { return [...this.values.values()].filter(task => task.sessionId === sessionId).map(task => structuredClone(task)); }
  async putUpload(task: UploadTask) { this.values.set(task.id, structuredClone(task)); }
}
const uploadId = '11111111-1111-4111-8111-111111111111';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const digest = async (blob: Blob) => createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
const file = () => new File(['exact\r\nbytes'], 'proof.txt', { type: 'text/plain' });

it('does not treat a failed complete HTTP response as a completed attachment', async () => {
  const backend = new MemoryUploadStore(); let metadata: unknown;
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === '/api/uploads') { metadata = JSON.parse(String(init?.body)); return json({ uploadId, chunkSize: 100, received: [] }); }
    if (String(url).endsWith('/complete')) return json({ message: 'storage failed' }, 500);
    return json({ uploadId, received: [0], size: file().size });
  };
  const uploads = new UploadController({ store: backend, fetch: fetcher as typeof fetch, digest });
  const task = await uploads.create('A', file(), 'file');
  await expect(uploads.resume(task.id)).rejects.toThrow('HTTP 500');
  expect(uploads.get(task.id)).toMatchObject({ state: 'failed', error: '完成上传失败（HTTP 500）' });
  expect(uploads.get(task.id)?.fileId).toBeUndefined();
  expect(uploads.get(task.id)?.blob?.size).toBe(file().size);
  expect(metadata).toEqual({ name: 'proof.txt', mime: 'text/plain', size: file().size, sha256: await digest(file()) });
});

it('exhausted chunk retries cannot reach complete and retain exact bytes for explicit resume', async () => {
  const backend = new MemoryUploadStore(); let completes = 0; let puts = 0;
  const uploads = new UploadController({ store: backend, digest, maxAttempts: 2, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === '/api/uploads') return json({ uploadId, chunkSize: 100, received: [] });
    if (String(url).endsWith('/complete')) { completes++; return json({ fileId: 'unexpected' }); }
    if (init?.method === 'PUT') { puts++; return json({}, 500); }
    return json({ uploadId, received: [], size: file().size });
  }) as typeof fetch });
  const task = await uploads.create('A', file(), 'file');
  await expect(uploads.resume(task.id)).rejects.toThrow('分片上传未完成');
  expect(puts).toBe(2); expect(completes).toBe(0);
  expect(await uploads.get(task.id)?.blob?.text()).toBe('exact\r\nbytes');
  expect((await backend.getUpload(task.id))?.state).toBe('failed');
});

it('a new controller restores an accepted Blob and resumes only missing chunks without crossing Sessions', async () => {
  const backend = new MemoryUploadStore(); const received = new Map<number, Buffer>(); let fail = true; let starts = 0; let firstChunkPuts = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === '/api/uploads') { starts++; return json({ uploadId, chunkSize: 5, received: [] }); }
    if (String(url).endsWith('/complete')) return json({ fileId: 'durable-file-id' });
    const index = /\/chunks\/(\d+)$/.exec(String(url));
    if (index !== null) {
      const number = Number(index[1]);
      if (number === 1 && fail) { fail = false; throw new Error('offline'); }
      if (number === 0) firstChunkPuts++;
      received.set(number, Buffer.from(await (init?.body as Blob).arrayBuffer()));
      return json({ uploadId, received: [...received.keys()], size: file().size });
    }
    if (!fail && received.size === 1) { fail = true; return json({}, 500); }
    return json({ uploadId, received: [...received.keys()], size: file().size });
  }) as typeof fetch;
  const first = new UploadController({ store: backend, digest, fetch: fetcher });
  const task = await first.create('A', file(), 'file');
  await expect(first.resume(task.id)).rejects.toThrow('HTTP 500');
  fail = false;
  const second = new UploadController({ store: backend, digest, fetch: fetcher });
  expect(await second.restore('B')).toEqual([]);
  expect((await second.restore('A'))[0]?.received).toEqual([0]);
  // A successful status read after reconnect confirms the saved first chunk.
  const resumeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/complete')) return json({ fileId: 'durable-file-id' });
    if (init?.method !== 'PUT') return json({ uploadId, received: [...received.keys()], size: file().size });
    const index = Number(/\/chunks\/(\d+)$/.exec(String(url))![1]);
    if (index === 0) firstChunkPuts++;
    received.set(index, Buffer.from(await (init.body as Blob).arrayBuffer()));
    return json({ uploadId, received: [...received.keys()], size: file().size });
  }) as typeof fetch;
  const restored = new UploadController({ store: backend, digest, fetch: resumeFetch });
  await restored.restore('A');
  expect(await restored.resume(task.id)).toMatchObject({ sessionId: 'A', state: 'completed', fileId: 'durable-file-id' });
  expect(starts).toBe(1); expect(firstChunkPuts).toBe(1);
  const bytes = Buffer.concat([...received.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(await digest(file()));
});

it('a late restore read cannot downgrade an upload that completed in the current controller', async () => {
  const backend = new MemoryUploadStore();
  const uploads = new UploadController({ store: backend, digest, fetch: (async (url: string | URL | Request) => {
    if (String(url) === '/api/uploads') return json({ uploadId, chunkSize: 100, received: [] });
    if (String(url).endsWith('/complete')) return json({ fileId: 'completed-file' });
    return json({ uploadId, received: [0], size: file().size });
  }) as typeof fetch });
  const task = await uploads.create('A', file(), 'file');
  const stale = await backend.listUploads('A'); let finish!: () => void;
  backend.listUploads = async () => new Promise(resolve => { finish = () => resolve(stale); });
  const restoring = uploads.restore('A');
  await expect(uploads.resume(task.id)).resolves.toMatchObject({ state: 'completed', fileId: 'completed-file' });
  finish(); await restoring;
  expect(uploads.get(task.id)).toMatchObject({ state: 'completed', fileId: 'completed-file' });
  expect(await backend.getUpload(task.id)).toMatchObject({ state: 'completed', fileId: 'completed-file' });
});

it('pause aborts the active transfer, retains its Blob, and resumes only the missing chunks', async () => {
  const backend = new MemoryUploadStore(); const received = new Set<number>(); const puts: number[] = [];
  let block = true; let began!: () => void;
  const transferring = new Promise<void>(resolve => { began = resolve; });
  const uploads = new UploadController({ store: backend, digest, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === '/api/uploads') return json({ uploadId, chunkSize: 5, received: [] });
    if (String(url).endsWith('/complete')) return json({ fileId: 'completed-file' });
    const chunk = /\/chunks\/(\d+)$/.exec(String(url));
    if (chunk !== null) {
      const index = Number(chunk[1]); puts.push(index);
      if (index === 1 && block) {
        began();
        await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
      }
      received.add(index);
    }
    return json({ uploadId, received: [...received], size: file().size });
  }) as typeof fetch });
  const task = await uploads.create('A', file(), 'file');
  const first = uploads.resume(task.id); const rejected = expect(first).rejects.toThrow();
  await transferring; await uploads.pause(task.id); await rejected;
  expect(uploads.get(task.id)).toMatchObject({ state: 'paused', received: [0], sessionId: 'A' });
  expect(await uploads.get(task.id)?.blob?.text()).toBe('exact\r\nbytes');
  block = false;
  expect(await uploads.resume(task.id)).toMatchObject({ state: 'completed', fileId: 'completed-file' });
  expect(puts).toEqual([0, 1, 1, 2]);
});

it('cancel fences a late chunk response and retains cancellation errors without allowing resume', async () => {
  const backend = new MemoryUploadStore(); const requests: string[] = [];
  let began!: () => void; let finish!: () => void;
  const transferring = new Promise<void>(resolve => { began = resolve; });
  const uploads = new UploadController({ store: backend, digest, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${String(url)}`);
    if (String(url) === '/api/uploads') return json({ uploadId, chunkSize: 100, received: [] });
    if (init?.method === 'DELETE') return json({}, 500);
    if (init?.method === 'PUT') {
      began();
      // The peer may have accepted the chunk when local abort happened.
      await new Promise<void>(resolve => { finish = resolve; });
    }
    return json({ uploadId, received: [0], size: file().size });
  }) as typeof fetch });
  const task = await uploads.create('A', file(), 'file');
  const first = uploads.resume(task.id); const rejected = expect(first).rejects.toThrow();
  await transferring;
  const cancelling = uploads.cancel(task.id); finish(); await cancelling; await rejected;
  expect(uploads.get(task.id)).toMatchObject({ state: 'cancelled', error: '取消上传失败（HTTP 500）' });
  expect(uploads.get(task.id)?.blob).toBeUndefined();
  await expect(uploads.resume(task.id)).rejects.toThrow('已取消');
  expect(requests).toEqual([`POST /api/uploads`, `PUT /api/uploads/${uploadId}/chunks/0`, `DELETE /api/uploads/${uploadId}`]);
});
