import { constants } from 'node:fs';
import { open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

function failure(statusCode: number, message: string): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode }); }

/** Read the opened directory, not a path resolved again after validation.
 * Namespace changes during enumeration reject the list before it is sent. */
export async function listWorkspaceDirectory(rootPath: string, target: string) {
  if (process.platform !== 'linux') throw failure(501, '当前平台无法安全读取工作区目录');
  const root = await realpath(rootPath), rel = relative(root, target);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw failure(409, '目录路径已改变');
  let directory: FileHandle | undefined, selected: FileHandle | undefined;
  try {
    directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const pinnedRoot = directory, rootFd = `/proc/self/fd/${directory.fd}`;
    const descriptorPath = async (path: string) => realpath(path).catch(async error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && await stat('/proc/self/fd').then(() => true, () => false)) throw failure(409, '目录路径已删除或改变');
      throw failure(501, '当前服务无法安全核验工作区目录');
    });
    if (await descriptorPath(rootFd) !== root) throw failure(409, '工作区根目录已改变');
    selected = rel === '' ? directory : await open(join(rootFd, rel), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const pinnedTarget = selected, targetFd = `/proc/self/fd/${selected.fd}`;
    const check = async () => {
      const actual = await pinnedRoot.stat(), current = await stat(rootPath);
      if (actual.dev !== current.dev || actual.ino !== current.ino || await realpath(rootPath) !== root || await descriptorPath(rootFd) !== root
        || await descriptorPath(targetFd) !== target) throw failure(409, '工作区目录路径已改变');
    };
    await check();
    const entries = await readdir(`/proc/self/fd/${pinnedTarget.fd}`, { withFileTypes: true });
    await check();
    return { root, entries };
  } catch (error) {
    if (['ELOOP', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw failure(409, '工作区目录路径已改变');
    throw error;
  } finally {
    if (selected !== undefined && selected !== directory) await selected.close().catch(() => undefined);
    await directory?.close().catch(() => undefined);
  }
}
