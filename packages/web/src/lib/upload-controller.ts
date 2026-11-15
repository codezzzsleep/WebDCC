/** Durable WebDCC uploads. These prepare bytes; native attachment admission
 * remains the receiving adapter's responsibility. */
import { attachmentDigest, uploadTaskId } from './input-digest.js';
export type UploadKind = 'image' | 'file' | 'audio';
export type UploadState = 'queued' | 'uploading' | 'completing' | 'paused' | 'failed' | 'completed' | 'cancelled';
export interface UploadTask {
  id: string; sessionId: string; kind: UploadKind; name: string; mime: string; size: number; sha256: string;
  blob?: Blob; state: UploadState; uploadId?: string; chunkSize?: number; received: number[]; fileId?: string;
  error?: string; updatedAt: number;
}
export interface UploadTaskStore {
  getUpload(id: string): Promise<UploadTask | undefined>;
  listUploads(sessionId: string): Promise<UploadTask[]>;
  putUpload(task: UploadTask): Promise<void>;
}
export interface UploadControllerOptions {
  store: UploadTaskStore;
  fetch?: typeof fetch;
  endpoint?: string;
  digest?: (blob: Blob) => Promise<string>;
  maxAttempts?: number;
  scopeSession?: (draftSessionId: string) => string | undefined;
}
export class UploadHttpError extends Error {
  constructor(readonly status: number, operation: string) { super(`${operation}失败（HTTP ${status}）`); }
}
const MAX_BYTES = 100 * 1024 * 1024;
const fileId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const uploadId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function indices(value: unknown, count: number): number[] {
  if (!Array.isArray(value) || value.some(index => !Number.isSafeInteger(index) || index < 0 || index >= count) || new Set(value).size !== value.length) throw new Error('上传分片状态无效');
  return [...value].sort((a, b) => a - b) as number[];
}

export class UploadController {
  private readonly tasks = new Map<string, UploadTask>();
  private readonly active = new Map<string, { control: AbortController; promise: Promise<UploadTask> }>();
  private readonly listeners = new Set<(task: UploadTask) => void>();
  private readonly fetcher: typeof fetch;
  private readonly endpoint: string;
  constructor(private readonly options: UploadControllerOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.endpoint = (options.endpoint ?? '/api/uploads').replace(/\/$/, '');
  }
  subscribe(listener: (task: UploadTask) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  get(id: string): UploadTask | undefined { const task = this.tasks.get(id); return task === undefined ? undefined : structuredClone(task); }
  list(sessionId: string): UploadTask[] { return [...this.tasks.values()].filter(task => task.sessionId === sessionId).map(task => structuredClone(task)); }
  private async save(task: UploadTask): Promise<UploadTask> {
    const next = { ...task, received: [...task.received], updatedAt: Date.now() };
    await this.options.store.putUpload(next);
    this.tasks.set(next.id, next);
    for (const listener of this.listeners) { try { listener(structuredClone(next)); } catch { /* UI observers do not change upload admission. */ } }
    return next;
  }
  async create(sessionId: string, file: File, kind: UploadKind): Promise<UploadTask> {
    if (sessionId === '' || !file.name || file.size > MAX_BYTES) throw new Error('附件缺少会话、文件名或超过 100 MB 上限');
    const sha256 = await (this.options.digest ?? attachmentDigest)(file);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('附件 SHA-256 无效');
    return this.save({ id: uploadTaskId(), sessionId, kind, name: file.name, mime: file.type || 'application/octet-stream', size: file.size,
      sha256, blob: file.slice(0, file.size, file.type), state: 'queued', received: [], updatedAt: Date.now() });
  }
  async restore(sessionId: string): Promise<UploadTask[]> {
    for (const saved of await this.options.store.listUploads(sessionId)) {
      // Hydration cannot replace an accepted live state, even if its read
      // began before an upload completed or the user paused/cancelled it.
      if (this.active.has(saved.id) || this.tasks.has(saved.id)) continue;
      await this.save(['uploading', 'completing'].includes(saved.state) ? { ...saved, state: 'paused' } : saved);
    }
    return this.list(sessionId);
  }
  async pause(id: string): Promise<void> {
    const running = this.active.get(id); running?.control.abort(); await running?.promise.catch(() => undefined);
    const task = this.tasks.get(id) ?? await this.options.store.getUpload(id);
    if (task !== undefined && !['completed', 'cancelled'].includes(task.state)) await this.save({ ...task, state: 'paused', error: undefined });
  }
  async cancel(id: string): Promise<void> {
    const running = this.active.get(id); running?.control.abort(); await running?.promise.catch(() => undefined);
    const task = this.tasks.get(id) ?? await this.options.store.getUpload(id);
    if (task === undefined || task.state === 'completed') return;
    await this.save({ ...task, state: 'cancelled', blob: undefined, error: undefined });
    if (task.uploadId !== undefined) {
      try {
        const response = await this.fetcher(`${this.endpoint}/${task.uploadId}`, { method: 'DELETE', credentials: 'same-origin' });
        if (!response.ok && response.status !== 404) throw new UploadHttpError(response.status, '取消上传');
      } catch (error) { await this.save({ ...this.tasks.get(id)!, error: error instanceof Error ? error.message : '取消上传未完成' }); }
    }
  }
  resume(id: string): Promise<UploadTask> {
    const running = this.active.get(id); if (running !== undefined) return running.promise;
    const control = new AbortController();
    const promise = this.run(id, control.signal).finally(() => { if (this.active.get(id)?.control === control) this.active.delete(id); });
    this.active.set(id, { control, promise });
    return promise;
  }
  private async json(url: string, init: RequestInit, operation: string): Promise<Record<string, unknown>> {
    const response = await this.fetcher(url, { ...init, credentials: 'same-origin' });
    if (!response.ok) throw new UploadHttpError(response.status, operation);
    try { return record(await response.json()); } catch { throw new Error(`${operation}返回无效 JSON`); }
  }
  private async run(id: string, signal: AbortSignal): Promise<UploadTask> {
    let task = this.tasks.get(id) ?? await this.options.store.getUpload(id);
    if (task === undefined) throw new Error('上传任务不存在');
    if (task.state === 'completed') return task;
    if (task.state === 'cancelled') throw new Error('上传任务已取消');
    if (task.blob === undefined || task.blob.size !== task.size) throw new Error('上传正文不可恢复，请重新选择附件');
    try {
      signal.throwIfAborted(); task = await this.save({ ...task, state: 'uploading', error: undefined });
      if (task.uploadId !== undefined) {
        try {
          const status = await this.json(`${this.endpoint}/${task.uploadId}`, { signal }, '读取上传状态');
          if (status['uploadId'] !== task.uploadId || status['size'] !== task.size || !Number.isSafeInteger(task.chunkSize) || task.chunkSize! <= 0) throw new Error('上传身份或大小不匹配');
          task = await this.save({ ...task, received: indices(status['received'], Math.ceil(task.size / task.chunkSize!)) });
        } catch (error) {
          if (!(error instanceof UploadHttpError) || error.status !== 404) throw error;
          task = await this.save({ ...task, uploadId: undefined, chunkSize: undefined, received: [] });
        }
      }
      if (task.uploadId === undefined) {
        const sessionId = this.options.scopeSession?.(task.sessionId);
        const init = await this.json(this.endpoint, { method: 'POST', signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: task.name, mime: task.mime, size: task.size, sha256: task.sha256, ...(sessionId === undefined ? {} : { sessionId }) }) }, '开始上传');
        signal.throwIfAborted();
        if (init['existingFileId'] !== undefined) {
          if (!fileId(init['existingFileId'])) throw new Error('上传文件标识无效');
          return await this.save({ ...task, state: 'completed', fileId: init['existingFileId'], blob: undefined });
        }
        if (!uploadId(init['uploadId']) || !Number.isSafeInteger(init['chunkSize']) || Number(init['chunkSize']) <= 0 || Number(init['chunkSize']) > MAX_BYTES) throw new Error('上传初始化状态无效');
        task = await this.save({ ...task, uploadId: init['uploadId'], chunkSize: Number(init['chunkSize']), received: indices(init['received'], Math.ceil(task.size / Number(init['chunkSize']))) });
      }
      const count = Math.ceil(task.size / task.chunkSize!);
      const attempts = Math.max(1, Math.min(this.options.maxAttempts ?? 3, 5));
      for (let index = 0; index < count; index++) {
        if (task.received.includes(index)) continue;
        let accepted = false;
        for (let attempt = 0; attempt < attempts && !accepted; attempt++) {
          signal.throwIfAborted();
          try {
            const response = await this.fetcher(`${this.endpoint}/${task.uploadId}/chunks/${index}`, { method: 'PUT', signal, credentials: 'same-origin',
              headers: { 'content-type': 'application/octet-stream' }, body: task.blob!.slice(index * task.chunkSize!, Math.min(task.size, (index + 1) * task.chunkSize!)) });
            if (!response.ok) throw new UploadHttpError(response.status, '上传分片');
            const acknowledgement = record(await response.json());
            if (acknowledgement['uploadId'] !== task.uploadId || acknowledgement['size'] !== task.size) throw new Error('上传分片身份或大小不匹配');
            const confirmed = indices(acknowledgement['received'], count);
            if (!confirmed.includes(index)) throw new Error('上传分片没有获得确认');
            signal.throwIfAborted(); task = await this.save({ ...task, received: confirmed }); accepted = true;
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof UploadHttpError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) throw error;
            const status = await this.json(`${this.endpoint}/${task.uploadId}`, { signal }, '核对上传分片');
            if (status['uploadId'] !== task.uploadId || status['size'] !== task.size) throw new Error('上传身份或大小不匹配', { cause: error });
            task = await this.save({ ...task, received: indices(status['received'], count) });
            accepted = task.received.includes(index);
          }
        }
        if (!accepted) throw new Error('分片上传未完成，正文已保留，可继续上传');
        signal.throwIfAborted(); task = await this.save({ ...task, received: [...new Set([...task.received, index])].sort((a, b) => a - b) });
      }
      signal.throwIfAborted(); task = await this.save({ ...task, state: 'completing' });
      const complete = await this.json(`${this.endpoint}/${task.uploadId}/complete`, { method: 'POST', signal }, '完成上传');
      signal.throwIfAborted();
      if (!fileId(complete['fileId'])) throw new Error('完成上传未返回有效文件标识');
      return await this.save({ ...task, state: 'completed', fileId: complete['fileId'], blob: undefined, error: undefined });
    } catch (error) {
      if (!signal.aborted) await this.save({ ...task, state: 'failed', error: error instanceof Error ? error.message : '上传失败' });
      throw error;
    }
  }
}
