import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

function failure(statusCode: number, message: string): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode }); }

function validateFilename(filename: string): void {
  if (filename === '' || basename(filename) !== filename || filename.includes('\\') || filename.includes('\0') || Buffer.byteLength(filename) > 255
    || Buffer.from(filename).toString() !== filename || [...filename].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw failure(400, '附件文件名无效或过长');
}

/** Keep established paths for short names. A legal original name may need a
 * shorter workspace alias once the immutable file identity is prefixed. */
export function workspaceAttachmentFilename(fileId: string, filename: string): string {
  validateFilename(filename);
  const prefix = `${fileId}-`, full = prefix + filename;
  if (Buffer.byteLength(full) <= 255) return full;
  const originalExtension = extname(filename);
  const extension = Buffer.byteLength(originalExtension) <= 32 ? originalExtension : '';
  const suffix = `-${createHash('sha256').update(filename).digest('hex').slice(0, 12)}${extension}`;
  const budget = 255 - Buffer.byteLength(prefix + suffix);
  if (budget < 0) throw failure(400, '附件文件名无效或过长');
  let shortened = '', bytes = 0;
  for (const char of filename.slice(0, filename.length - extension.length)) {
    const size = Buffer.byteLength(char); if (bytes + size > budget) break;
    shortened += char; bytes += size;
  }
  return prefix + shortened + suffix;
}

/** The reserved attachment directory is created and written through pinned
 * directory descriptors. A completed copy cannot be undone by a later check. */
export async function copyWorkspaceAttachment(rootPath: string, filename: string, payload: Buffer): Promise<{ path: string }> {
  if (process.platform !== 'linux') throw failure(501, '当前平台无法安全复制工作区附件');
  validateFilename(filename);
  const root = await realpath(rootPath), initial = await stat(root);
  const handles: FileHandle[] = []; let temporary: string | undefined, copied = false;
  try {
    const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(directory);
    const rootFd = `/proc/self/fd/${directory.fd}`;
    const descriptorPath = async (path: string) => realpath(path).catch(async error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && await stat('/proc/self/fd').then(() => true, () => false)) throw failure(409, '附件目录路径已改变');
      throw failure(501, '当前服务无法安全核验附件目录');
    });
    const check = async () => {
      const current = await stat(rootPath), pinned = await directory.stat();
      if (current.dev !== initial.dev || current.ino !== initial.ino || pinned.dev !== initial.dev || pinned.ino !== initial.ino
        || await realpath(rootPath) !== root || await descriptorPath(rootFd) !== root) throw failure(409, '工作区目录已改变');
      for (const [index, handle] of handles.entries()) if (index > 0 && await descriptorPath(`/proc/self/fd/${handle.fd}`) !== join(root, '.webdcc', ...(index === 2 ? ['uploads'] : []))) throw failure(409, '附件目录路径已改变');
    };
    await check();
    let parent = directory;
    for (const name of ['.webdcc', 'uploads']) {
      const path = join(`/proc/self/fd/${parent.fd}`, name);
      await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      parent = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(parent);
      await check();
    }
    const parentFd = `/proc/self/fd/${parent.fd}`, target = join(parentFd, filename);
    const checkTarget = async () => {
      await check();
      const info = await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      if (info !== undefined && (!info.isFile() || info.isSymbolicLink())) throw failure(409, '附件目标不是普通文件');
      return info;
    };
    const original = await checkTarget();
    if (original !== undefined && (original.mode & 0o222) === 0) throw failure(403, '附件目标没有写权限');
    temporary = join(parentFd, `.webdcc-${randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, original === undefined ? 0o600 : original.mode & 0o777);
    try {
      await check(); await file.writeFile(payload);
      if (original !== undefined) { await file.chmod(original.mode & 0o777); const own = await file.stat(); if (own.uid !== original.uid || own.gid !== original.gid) await file.chown(original.uid, original.gid); }
      await file.sync();
    } finally { await file.close(); }
    await checkTarget(); await rename(temporary, target); temporary = undefined; copied = true;
    await check(); await parent.sync();
    const result = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await result.stat();
      if (!info.isFile() || info.size !== payload.length || await descriptorPath(`/proc/self/fd/${result.fd}`) !== join(root, '.webdcc/uploads', filename)) throw failure(409, '附件复制后目标已改变');
      const buffer = Buffer.alloc(64 * 1024), hash = createHash('sha256'); let total = 0;
      while (total <= payload.length) {
        const { bytesRead } = await result.read(buffer, 0, Math.min(buffer.length, payload.length + 1 - total), total);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead)); total += bytesRead;
      }
      await check();
      if (await descriptorPath(`/proc/self/fd/${result.fd}`) !== join(root, '.webdcc/uploads', filename) || total !== payload.length || hash.digest('hex') !== createHash('sha256').update(payload).digest('hex')) throw failure(409, '附件复制后内容已改变');
    } finally { await result.close(); }
    return { path: join('.webdcc', 'uploads', filename) };
  } catch (error) {
    if (copied) throw Object.assign(failure(409, '附件已复制到原目录，但当前路径或内容无法确认，请核对后重试'), { copied: true, sha256: createHash('sha256').update(payload).digest('hex'), bytes: payload.length, cause: error });
    if (['ELOOP', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw failure(409, '附件目录或文件路径已改变');
    throw error;
  } finally {
    if (temporary !== undefined) await unlink(temporary).catch(() => undefined);
    for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
  }
}
