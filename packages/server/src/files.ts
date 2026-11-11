import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FileDto, UploadCompleteResponse, UploadInitResponse, UploadStatusResponse } from '@webdcc/protocol';
import { ulid } from '@webdcc/protocol';
import type { Store } from './store.js';

export const CHUNK_SIZE = 1024 * 1024;
/** 单个文件上限 100 MB（SPEC-M8 F7 / ATT-04） */
export const MAX_FILE_SIZE = 100 * 1024 * 1024;

/** 内容寻址文件存储（SPEC 7.6、7.7） */
export class FileStore {
  private readonly objectsDir: string;
  private readonly uploadsDir: string;

  constructor(dataDir: string, private readonly store: Store) {
    this.objectsDir = join(dataDir, 'files');
    this.uploadsDir = join(dataDir, 'uploads');
  }

  async init(): Promise<void> {
    await mkdir(this.objectsDir, { recursive: true });
    await mkdir(this.uploadsDir, { recursive: true });
  }

  objectPath(sha256: string): string {
    return join(this.objectsDir, sha256.slice(0, 2), sha256);
  }

  resolvePath(id: string): string | undefined {
    const file = this.store.getFile(id);
    return file === undefined ? undefined : this.objectPath(file.sha256);
  }

  /** 直接存一个 buffer（图片、diff、命令全文等） */
  async putBuffer(buffer: Buffer, name: string, mime: string): Promise<FileDto> {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const existing = this.store.getFileBySha(sha256);
    if (existing !== undefined) return existing;
    const target = this.objectPath(sha256);
    await mkdir(join(this.objectsDir, sha256.slice(0, 2)), { recursive: true });
    await writeFile(target, buffer);
    return this.store.insertFile({ id: ulid(), sha256, name, mime, size: buffer.byteLength });
  }

  /** 同步版本：manager 在处理事件时同步写入 diff 文本（C2 / F10） */
  putBufferSync(buffer: Buffer, name: string, mime: string): FileDto {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const existing = this.store.getFileBySha(sha256);
    if (existing !== undefined) return existing;
    const dir = join(this.objectsDir, sha256.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.objectPath(sha256), buffer);
    return this.store.insertFile({ id: ulid(), sha256, name, mime, size: buffer.byteLength });
  }

  async readAll(id: string): Promise<{ file: FileDto; buffer: Buffer } | undefined> {
    const file = this.store.getFile(id);
    if (file === undefined) return undefined;
    const buffer = await readFile(this.objectPath(file.sha256));
    return { file, buffer };
  }

  createReadStream(id: string): { file: FileDto; stream: NodeJS.ReadableStream } | undefined {
    const file = this.store.getFile(id);
    if (file === undefined) return undefined;
    return { file, stream: createReadStream(this.objectPath(file.sha256)) };
  }

  // ---------- 可续传上传 ----------

  async initUpload(input: { name: string; size: number; sha256: string; mime: string }): Promise<UploadInitResponse & { existingFileId?: string }> {
    if (input.size > MAX_FILE_SIZE) {
      throw Object.assign(new Error(`文件超过 100 MB 上限（${Math.round(input.size / 1024 / 1024)} MB）`), { statusCode: 413 });
    }
    const existing = this.store.getFileBySha(input.sha256);
    if (existing !== undefined) {
      return { uploadId: '', chunkSize: CHUNK_SIZE, received: [], existingFileId: existing.id };
    }
    const uploadId = randomUUID();
    await mkdir(join(this.uploadsDir, uploadId), { recursive: true });
    this.store.createUpload({ id: uploadId, ...input });
    return { uploadId, chunkSize: CHUNK_SIZE, received: [] };
  }

  async writeChunk(uploadId: string, index: number, buffer: Buffer): Promise<UploadStatusResponse> {
    const upload = this.store.getUpload(uploadId);
    if (upload === undefined) throw Object.assign(new Error('upload 不存在'), { statusCode: 404 });
    const dir = join(this.uploadsDir, uploadId);
    await mkdir(dir, { recursive: true });
    const file = await open(join(dir, String(index)), 'w');
    try {
      await file.write(buffer);
    } finally {
      await file.close();
    }
    const received = [...new Set([...upload.receivedList, index])].sort((a, b) => a - b);
    this.store.setUploadReceived(uploadId, received);
    return { uploadId, received, size: upload.size };
  }

  uploadStatus(uploadId: string): UploadStatusResponse {
    const upload = this.store.getUpload(uploadId);
    if (upload === undefined) throw Object.assign(new Error('upload 不存在'), { statusCode: 404 });
    return { uploadId, received: upload.receivedList, size: upload.size };
  }

  /** 校验 sha256 后落为内容寻址文件（SPEC 7.7） */
  async completeUpload(uploadId: string): Promise<UploadCompleteResponse> {
    const upload = this.store.getUpload(uploadId);
    if (upload === undefined) throw Object.assign(new Error('upload 不存在'), { statusCode: 404 });
    const dir = join(this.uploadsDir, uploadId);
    const hash = createHash('sha256');
    let total = 0;
    for (let index = 0; index < upload.receivedList.length; index += 1) {
      const chunk = await readFile(join(dir, String(upload.receivedList[index])));
      hash.update(chunk);
      total += chunk.byteLength;
    }
    if (total !== upload.size) {
      throw Object.assign(new Error(`上传不完整：已收到 ${total} 字节，期望 ${upload.size}`), { statusCode: 400 });
    }
    const sha256 = hash.digest('hex');
    if (sha256 !== upload.sha256) {
      throw Object.assign(new Error('sha256 校验失败'), { statusCode: 400 });
    }
    const existing = this.store.getFileBySha(sha256);
    let fileId: string;
    if (existing !== undefined) {
      fileId = existing.id;
    } else {
      const tmp = join(dir, 'complete.bin');
      const source = upload.receivedList.map((index) => join(dir, String(index)));
      const merged = await open(tmp, 'w');
      try {
        for (const chunkPath of source) {
          const data = await readFile(chunkPath);
          await merged.write(data);
        }
      } finally {
        await merged.close();
      }
      const target = this.objectPath(sha256);
      await mkdir(join(this.objectsDir, sha256.slice(0, 2)), { recursive: true });
      await rename(tmp, target);
      fileId = this.store.insertFile({ id: ulid(), sha256, name: upload.name, mime: upload.mime, size: upload.size }).id;
    }
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
