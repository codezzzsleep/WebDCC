import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

function failure(statusCode: number, message: string): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode }); }
function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
}

/** Verify the opened inode before reading any bytes. O_NOFOLLOW alone only
 * protects the final component; a replaced ancestor can still escape root.
 * Linux descriptors pin both the root and file throughout path verification.
 * Hosts without descriptor paths must not fall back to an unverified read. */
export async function openWorkspaceRead(rootPath: string, target: string): Promise<FileHandle> {
  if (process.platform !== 'linux') throw failure(501, '当前平台无法核验工作区文件描述符，读取不可用');
  const root = await realpath(rootPath);
  if (!isAbsolute(target) || !inside(root, target)) throw failure(409, '文件路径已改变，请重新加载');
  let directory: FileHandle | undefined; let file: FileHandle | undefined;
  try {
    directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const rootFdPath = `/proc/self/fd/${directory.fd}`;
    const pinnedRoot = await realpath(rootFdPath).catch(() => { throw failure(501, '无法核验工作区文件描述符，读取需要可用的 /proc/self/fd'); });
    if (pinnedRoot !== root) throw failure(409, '工作区路径已改变，请重新加载');
    file = await open(join(rootFdPath, relative(root, target)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile()) throw failure(400, '需要普通文件');
    const actual = await realpath(`/proc/self/fd/${file.fd}`);
    const rootInfo = await directory.stat(); const currentRootInfo = await stat(rootPath);
    if (actual !== target || !inside(root, actual) || await realpath(rootPath) !== root || await realpath(rootFdPath) !== root
      || rootInfo.dev !== currentRootInfo.dev || rootInfo.ino !== currentRootInfo.ino) throw failure(409, '文件路径已改变，请重新加载');
    return file;
  } catch (error) {
    await file?.close().catch(() => undefined);
    if (['ELOOP', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw failure(409, '文件路径已改变，请重新加载');
    throw error;
  } finally { await directory?.close().catch(() => undefined); }
}
