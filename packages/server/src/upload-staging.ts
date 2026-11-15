import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const isUploadId = (id: string): boolean => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
function failure(message: string, statusCode = 409): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode }); }
function pathFailure(error: unknown): unknown {
  return ['ELOOP', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') ? failure('上传暂存路径已改变，上传尚未完成') : error;
}

/** Every upload operation is relative to verified directory descriptors.
 * Chunk bytes are checked before reading and again after reading. */
export async function openUploadStaging(uploadsPath: string, uploadId?: string, create = false) {
  if (process.platform !== 'linux') throw failure('当前平台无法核验上传暂存目录描述符，上传不可用', 501);
  if (uploadId !== undefined && !isUploadId(uploadId)) throw failure('上传 ID 无效', 400);
  const handles: FileHandle[] = [];
  try {
    const dataPath = await realpath(dirname(uploadsPath)), rootPath = join(dataPath, 'uploads');
    const data = await open(dataPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(data);
    const dataFd = `/proc/self/fd/${data.fd}`;
    const descriptorPath = async (path: string) => realpath(path).catch(() => { throw failure('无法核验上传目录描述符，需要可用的 /proc/self/fd', 501); });
    if (await descriptorPath(dataFd) !== dataPath) throw failure('上传暂存路径已改变，上传尚未完成');
    const root = await open(join(dataFd, 'uploads'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(root);
    const rootFd = `/proc/self/fd/${root.fd}`;
    const checkRoot = async () => {
      const pinned = await data.stat(), current = await stat(dirname(uploadsPath));
      if (await descriptorPath(dataFd) !== dataPath || await realpath(dirname(uploadsPath)) !== dataPath || pinned.dev !== current.dev || pinned.ino !== current.ino
        || await descriptorPath(rootFd) !== rootPath || await realpath(uploadsPath) !== rootPath) throw failure('上传暂存路径已改变，上传尚未完成');
    };
    await checkRoot();
    if (create && uploadId !== undefined) { await mkdir(join(rootFd, uploadId), { mode: 0o700 }); await checkRoot(); }
    const slot = uploadId === undefined ? root : await open(join(rootFd, uploadId), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (slot !== root) handles.push(slot);
    const directory = `/proc/self/fd/${slot.fd}`, expected = uploadId === undefined ? rootPath : join(rootPath, uploadId);
    const check = async () => {
      await checkRoot();
      if (await descriptorPath(directory) !== expected) throw failure('上传暂存路径已改变，上传尚未完成');
    };
    await check();
    const path = (name: string) => {
      if (name === '' || name === '.' || name === '..' || basename(name) !== name || name.includes('\\') || name.includes('\0')) throw failure('上传暂存文件名无效', 400);
      return join(directory, name);
    };
    return {
      directory, path, check,
      async readChunk(index: number, expectedBytes: number): Promise<Buffer> {
        if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > 1024 * 1024) throw failure('分片长度或索引无效', 400);
        await check();
        let file: FileHandle | undefined;
        try {
          file = await open(path(String(index)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const chunkFile = file, info = await chunkFile.stat();
          if (!info.isFile() || info.size !== expectedBytes) throw failure('上传分片不是预期长度的普通文件');
          const checkFile = async () => {
            await check();
            if (await realpath(`/proc/self/fd/${chunkFile.fd}`) !== join(expected, String(index))) throw failure('上传分片路径已改变');
          };
          await checkFile();
          const buffer = Buffer.alloc(expectedBytes + 1); let offset = 0;
          while (offset < buffer.length) {
            const { bytesRead } = await chunkFile.read(buffer, offset, buffer.length - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
          }
          if (offset !== expectedBytes) throw failure('上传分片在读取期间改变长度');
          await checkFile();
          return buffer.subarray(0, offset);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Object.assign(failure('上传分片缺失'), { code: 'chunk-missing' });
          throw pathFailure(error);
        } finally { await file?.close(); }
      },
      async entries() { await checkRoot(); return readdir(rootFd, { withFileTypes: true }); },
      async entryInfo(id: string) { if (!isUploadId(id)) throw failure('上传 ID 无效', 400); await checkRoot(); return lstat(join(rootFd, id)); },
      async remove(id: string) { if (!isUploadId(id)) throw failure('上传 ID 无效', 400); await checkRoot(); await rm(join(rootFd, id), { recursive: true, force: true }); },
      async sync() { await slot.sync(); await check(); },
      async close() { for (const handle of handles.splice(0).reverse()) await handle.close().catch(() => undefined); },
    };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
    throw pathFailure(error);
  }
}
