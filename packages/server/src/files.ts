import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FileDto, InputAttachmentPart, ResolvedInputAttachmentPart, UploadCompleteResponse, UploadInitResponse, UploadStatusResponse } from '@webdcc/protocol';
import { ulid } from '@webdcc/protocol';
import type { Store } from './store.js';

export const CHUNK_SIZE = 1024 * 1024;
/** 单个文件上限 100 MB（SPEC-M8 F7 / ATT-04） */
export const MAX_FILE_SIZE = 100 * 1024 * 1024;

export interface FileStoreLimits {
  maxPendingBytes?: number;
  maxTotalBytes?: number;
  uploadTtlMs?: number;
  maxPendingUploads?: number;
}

function invalidUpload(message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { statusCode });
}
function corruptObject(message: string): Error { return Object.assign(invalidUpload(message, 409), { code: 'cas-corrupt' }); }
function repairableObject(error: unknown): boolean { return ['ENOENT', 'ELOOP', 'cas-corrupt'].includes((error as { code?: string }).code ?? ''); }
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }

/** 内容寻址文件存储（SPEC 7.6、7.7） */
export class FileStore {
  private readonly objectsDir: string;
  private readonly uploadsDir: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(dataDir: string, private readonly store: Store, private readonly limits: FileStoreLimits = {}) {
    this.objectsDir = join(dataDir, 'files');
    this.uploadsDir = join(dataDir, 'uploads');
  }

  async init(): Promise<void> {
    await mkdir(this.objectsDir, { recursive: true });
    await mkdir(this.uploadsDir, { recursive: true });
    await this.cleanupUploads();
  }

  private async serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    this.locks.set(id, run);
    try { return await run; } finally { if (this.locks.get(id) === run) this.locks.delete(id); }
  }

  async cancelUpload(uploadId: string): Promise<void> {
    await this.serialize(uploadId, async () => {
      this.store.deleteUpload(uploadId);
      // Only generated IDs address upload directories.
      if (/^[a-f0-9-]{36}$/.test(uploadId)) await rm(join(this.uploadsDir, uploadId), { recursive: true, force: true });
    });
  }

  async cleanupUploads(now = Date.now()): Promise<void> {
    const cutoff = now - (this.limits.uploadTtlMs ?? 24 * 60 * 60 * 1000);
    for (const upload of this.store.listUploads()) {
      if (Date.parse(upload.created_at) < cutoff) await this.cancelUpload(upload.id);
    }
    for (const entry of await readdir(this.uploadsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name) || this.store.getUpload(entry.name) !== undefined) continue;
      const path = join(this.uploadsDir, entry.name);
      if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
    }
  }

  objectPath(sha256: string): string {
    return join(this.objectsDir, sha256.slice(0, 2), sha256);
  }

  resolvePath(id: string): string | undefined {
    const file = this.store.getFile(id);
    return file === undefined ? undefined : this.objectPath(file.sha256);
  }

  private async casDirectory(sha256: string, create = false): Promise<string> {
    const dataRoot = await realpath(dirname(this.objectsDir)); const root = await realpath(this.objectsDir);
    if (root !== join(dataRoot, 'files')) throw invalidUpload('附件 CAS 根目录不能是符号链接', 409);
    const directory = join(root, sha256.slice(0, 2));
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw invalidUpload('附件 CAS 目录不是可信的普通目录', 409);
    return directory;
  }

  private async verifiedObject(file: FileDto, collect: boolean): Promise<{ path: string; buffer?: Buffer; imageMime?: string }> {
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_SIZE
      || typeof file.mime !== 'string' || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(file.mime)) throw invalidUpload('存储附件元数据无效', 409);
    const directory = await this.casDirectory(file.sha256);
    const path = join(directory, file.sha256); const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw invalidUpload('附件 CAS 对象不是普通文件', 409);
      if (info.size !== file.size) throw corruptObject('附件文件大小与已存记录不一致');
      const hash = createHash('sha256'); const chunks: Buffer[] = []; let bytes = 0; let prefix = Buffer.alloc(0);
      for await (const value of createReadStream(path, { fd: handle.fd, autoClose: false })) {
        const chunk = value as Buffer; bytes += chunk.length;
        if (bytes > file.size) throw corruptObject('附件在校验时改变大小');
        hash.update(chunk); if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
        if (collect) chunks.push(chunk);
      }
      if (bytes !== file.size || hash.digest('hex') !== file.sha256) throw corruptObject('附件内容 hash 与已存记录不一致');
      const imageMime = prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
        : prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255 ? 'image/jpeg'
        : ['GIF87a', 'GIF89a'].includes(prefix.subarray(0, 6).toString('ascii')) ? 'image/gif'
        : prefix.subarray(0, 4).toString('ascii') === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : undefined;
      return { path, ...(collect ? { buffer: Buffer.concat(chunks, bytes) } : {}), ...(imageMime === undefined ? {} : { imageMime }) };
    } finally { await handle.close(); }
  }

  /** Browser/queued paths and receipts are never authorities. Reopen the
   * current CAS object and verify its bytes before any native admission. */
  async resolveAttachment(reference: InputAttachmentPart, sessionId?: string): Promise<ResolvedInputAttachmentPart> {
    const file = this.store.getFile(reference.fileId);
    if (file === undefined) throw invalidUpload('上传文件不存在，消息未发送', 404);
    if (sessionId !== undefined && !this.store.hasFileGrant(sessionId, file.id)) throw invalidUpload('附件尚未附加到此会话，请显式选择附加操作', 403);
    if (reference.sha256 !== undefined && reference.sha256 !== file.sha256 || reference.size !== undefined && reference.size !== file.size
      || reference.mime !== undefined && reference.mime.toLowerCase() !== file.mime.toLowerCase()) throw invalidUpload('附件引用与当前存储元数据不一致', 409);
    let verified: Awaited<ReturnType<FileStore['verifiedObject']>>;
    try { verified = await this.verifiedObject(file, false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw invalidUpload('附件 CAS 文件缺失，消息未发送', 404); if ((error as { statusCode?: number }).statusCode !== undefined) throw error; throw invalidUpload('附件 CAS 文件不可安全读取，消息未发送', 409); }
    if (reference.type === 'image' && verified.imageMime !== file.mime.toLowerCase()) throw invalidUpload('图片真实格式与 MIME 不一致或不受支持', 400);
    if (reference.type === 'audio' && !file.mime.toLowerCase().startsWith('audio/')) throw invalidUpload('音频附件 MIME 无效', 400);
    return { type: reference.type, fileId: file.id, path: verified.path, name: reference.name ?? file.name, mime: file.mime, sha256: file.sha256, size: file.size };
  }

  async attachToSession(sessionId: string, fileId: string): Promise<ResolvedInputAttachmentPart> {
    if (this.store.getSession(sessionId) === undefined) throw invalidUpload('会话不存在', 404);
    const attachment = await this.resolveAttachment({ type: 'file', fileId });
    this.store.grantFile(sessionId, fileId, 'user-attach'); return attachment;
  }

  /** 直接存一个 buffer（图片、diff、命令全文等） */
  async putBuffer(buffer: Buffer, name: string, mime: string): Promise<FileDto> {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const existing = this.store.getFileByMetadata(sha256, name, mime);
    if (existing !== undefined) return existing;
    const target = this.objectPath(sha256);
    await mkdir(join(this.objectsDir, sha256.slice(0, 2)), { recursive: true });
    await writeFile(target, buffer);
    return this.store.insertFile({ id: ulid(), sha256, name, mime, size: buffer.byteLength });
  }

  /** 同步版本：manager 在处理事件时同步写入 diff 文本（C2 / F10） */
  putBufferSync(buffer: Buffer, name: string, mime: string): FileDto {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const existing = this.store.getFileByMetadata(sha256, name, mime);
    if (existing !== undefined) return existing;
    const dir = join(this.objectsDir, sha256.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.objectPath(sha256), buffer);
    return this.store.insertFile({ id: ulid(), sha256, name, mime, size: buffer.byteLength });
  }

  async readAll(id: string): Promise<{ file: FileDto; buffer: Buffer } | undefined> {
    const file = this.store.getFile(id);
    if (file === undefined) return undefined;
    const verified = await this.verifiedObject(file, true);
    return { file, buffer: verified.buffer! };
  }

  createReadStream(id: string): { file: FileDto; stream: NodeJS.ReadableStream } | undefined {
    const file = this.store.getFile(id);
    if (file === undefined) return undefined;
    return { file, stream: createReadStream(this.objectPath(file.sha256)) };
  }

  // ---------- 可续传上传 ----------

  async initUpload(input: { name: string; size: number; sha256?: string; mime: string; sessionId?: string }): Promise<UploadInitResponse & { existingFileId?: string }> {
    if (input.sessionId !== undefined && this.store.getSession(input.sessionId) === undefined) throw invalidUpload('上传目标会话不存在', 404);
    if (!Number.isSafeInteger(input.size) || input.size < 0) throw invalidUpload('size 必须是非负整数');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 255 || /[/\\]/.test(input.name) || [...input.name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw invalidUpload('文件名无效');
    if (typeof input.mime !== 'string' || input.mime.length > 255 || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(input.mime)) throw invalidUpload('MIME 无效');
    if (input.sha256 !== undefined && input.sha256 !== '' && !/^[a-f0-9]{64}$/.test(input.sha256)) throw invalidUpload('sha256 必须是 64 位小写十六进制');
    if (input.size > MAX_FILE_SIZE) {
      throw Object.assign(new Error(`文件超过 100 MB 上限（${Math.round(input.size / 1024 / 1024)} MB）`), { statusCode: 413 });
    }
    return this.serialize('@admission', async () => {
      await this.cleanupUploads();
      const existing = input.sha256 === undefined || input.sha256 === '' ? undefined : this.store.getFileBySha(input.sha256);
      if (existing !== undefined) {
        if (existing.size !== input.size) throw invalidUpload('sha256 对应的文件大小不一致', 409);
        let healthy = true;
        try { await this.verifiedObject(existing, false); } catch (error) { if (!repairableObject(error)) throw error; healthy = false; }
        if (healthy) {
          const alias = this.store.getFileByMetadata(existing.sha256, input.name, input.mime) ?? this.store.insertFile({ id: ulid(), sha256: existing.sha256, name: input.name, mime: input.mime, size: input.size });
          if (input.sessionId !== undefined) this.store.grantFile(input.sessionId, alias.id, 'upload');
          return { uploadId: '', chunkSize: CHUNK_SIZE, received: [], existingFileId: alias.id };
        }
        // A fresh explicit upload can repair missing/corrupt bytes only when
        // its full content matches the existing immutable SHA-256 identity.
      }
      const usage = this.store.fileStorageUsage();
      if (this.store.listUploads().length >= (this.limits.maxPendingUploads ?? 128)) throw invalidUpload('待完成上传数量已达上限', 413);
      if (usage.pending + input.size > (this.limits.maxPendingBytes ?? 1024 ** 3) || usage.stored + usage.pending + input.size > (this.limits.maxTotalBytes ?? 5 * 1024 ** 3)) throw invalidUpload('上传存储配额已用尽', 413);
      const uploadId = randomUUID();
      await mkdir(join(this.uploadsDir, uploadId), { recursive: true });
      this.store.createUpload({ id: uploadId, ...input, sha256: input.sha256 ?? '' });
      return { uploadId, chunkSize: CHUNK_SIZE, received: [] };
    });
  }

  async writeChunk(uploadId: string, index: number, buffer: Buffer): Promise<UploadStatusResponse> {
    return this.serialize(uploadId, async () => {
      const upload = this.store.getUpload(uploadId);
      if (upload === undefined) throw Object.assign(new Error('upload 不存在'), { statusCode: 404 });
      const count = Math.ceil(upload.size / CHUNK_SIZE);
      if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw invalidUpload('分片索引越界');
      const expected = Math.min(CHUNK_SIZE, upload.size - index * CHUNK_SIZE);
      if (!Buffer.isBuffer(buffer) || buffer.length !== expected) throw invalidUpload('分片长度不匹配');
      const dir = join(this.uploadsDir, uploadId);
      await mkdir(dir, { recursive: true });
      const target = join(dir, String(index));
      if (upload.receivedList.includes(index)) {
        const existing = await readFile(target).catch(() => undefined);
        if (existing !== undefined && !existing.equals(buffer)) throw invalidUpload('重复分片内容冲突', 409);
        if (existing !== undefined) return { uploadId, received: upload.receivedList, size: upload.size };
      }
      const tmp = join(dir, `${index}-${randomUUID()}.tmp`);
      try {
        const chunk = await open(tmp, 'wx', 0o600); try { await chunk.writeFile(buffer); await chunk.sync(); } finally { await chunk.close(); }
        await rename(tmp, target); await syncDirectory(dir);
      } finally { await rm(tmp, { force: true }); }
      const received = [...new Set([...upload.receivedList, index])].sort((a, b) => a - b);
      this.store.setUploadReceived(uploadId, received);
      return { uploadId, received, size: upload.size };
    });
  }

  uploadStatus(uploadId: string): UploadStatusResponse {
    const upload = this.store.getUpload(uploadId);
    if (upload === undefined) throw Object.assign(new Error('upload 不存在'), { statusCode: 404 });
    return { uploadId, received: upload.receivedList, size: upload.size };
  }

  /** 校验 sha256 后落为内容寻址文件（SPEC 7.7） */
  async completeUpload(uploadId: string): Promise<UploadCompleteResponse> {
    return this.serialize(uploadId, () => this.completeUploadLocked(uploadId));
  }

  private async completeUploadLocked(uploadId: string): Promise<UploadCompleteResponse> {
    const upload = this.store.getUpload(uploadId);
    if (upload === undefined) throw Object.assign(new Error('upload 不存在'), { statusCode: 404 });
    const dir = join(this.uploadsDir, uploadId);
    const count = Math.ceil(upload.size / CHUNK_SIZE);
    if (upload.receivedList.length !== count || upload.receivedList.some((index, ordinal) => index !== ordinal)) throw invalidUpload('上传分片不完整');
    const hash = createHash('sha256');
    let total = 0;
    for (let index = 0; index < upload.receivedList.length; index += 1) {
      const chunk = await readFile(join(dir, String(index))).catch(() => { throw invalidUpload('上传分片缺失'); });
      if (chunk.length !== Math.min(CHUNK_SIZE, upload.size - index * CHUNK_SIZE)) throw invalidUpload('上传分片长度不匹配');
      hash.update(chunk);
      total += chunk.byteLength;
    }
    if (total !== upload.size) {
      throw Object.assign(new Error(`上传不完整：已收到 ${total} 字节，期望 ${upload.size}`), { statusCode: 400 });
    }
    const sha256 = hash.digest('hex');
    if (upload.sha256 !== '' && sha256 !== upload.sha256) {
      throw Object.assign(new Error('sha256 校验失败'), { statusCode: 400 });
    }
    const existing = this.store.getFileBySha(sha256);
    let healthy = existing !== undefined;
    if (existing !== undefined) try { await this.verifiedObject(existing, false); } catch (error) { if (!repairableObject(error)) throw error; healthy = false; }
    let fileId: string;
    if (existing !== undefined && healthy) {
      fileId = (this.store.getFileByMetadata(sha256, upload.name, upload.mime) ?? this.store.insertFile({ id: ulid(), sha256, name: upload.name, mime: upload.mime, size: upload.size })).id;
    } else {
      const tmp = join(dir, `complete-${randomUUID()}.bin`);
      const source = upload.receivedList.map((index) => join(dir, String(index)));
      const merged = await open(tmp, 'wx', 0o600); const mergedHash = createHash('sha256'); let mergedBytes = 0;
      try {
        for (const chunkPath of source) {
          const data = await readFile(chunkPath);
          mergedHash.update(data); mergedBytes += data.length; await merged.writeFile(data);
        }
        if (mergedBytes !== upload.size || mergedHash.digest('hex') !== sha256) throw invalidUpload('分片在合并过程中改变，上传尚未完成', 409);
        await merged.sync();
      } catch (error) { await rm(tmp, { force: true }); throw error;
      } finally {
        await merged.close();
      }
      try { const directory = await this.casDirectory(sha256, true); await rename(tmp, join(directory, sha256)); await syncDirectory(directory); await syncDirectory(dirname(directory)); }
      finally { await rm(tmp, { force: true }); }
      fileId = this.store.getFileByMetadata(sha256, upload.name, upload.mime)?.id ?? this.store.insertFile({ id: ulid(), sha256, name: upload.name, mime: upload.mime, size: upload.size }).id;
    }
    if (upload.session_id !== null) this.store.grantFile(upload.session_id, fileId, 'upload');
    this.store.deleteUpload(uploadId);
    await rm(dir, { recursive: true, force: true });
    return { fileId, url: `/files/${fileId}` };
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
}

/** 把可读流写进文件（供将来的大文件直传使用） */
export async function writeStreamToFile(stream: NodeJS.ReadableStream, target: string): Promise<void> {
  await pipeline(stream as AsyncIterable<Uint8Array>, (await import('node:fs')).createWriteStream(target));
}
