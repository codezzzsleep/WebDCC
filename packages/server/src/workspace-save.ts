import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

function failure(statusCode: number, message: string): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode }); }
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

/** Pin the root and parent for every save read and replacement. Checks after
 * replacement detect namespace changes; they cannot undo a completed rename. */
export async function openWorkspaceSave(rootPath: string, root: string, target: string) {
  if (process.platform !== 'linux') throw failure(501, '当前平台无法核验工作区目录描述符，保存不可用');
  if (!isAbsolute(target) || !inside(root, target)) throw failure(409, '文件路径已改变，请重新加载');
  let rootDirectory: FileHandle | undefined, parent: FileHandle | undefined;
  try {
    rootDirectory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    parent = await open(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const pinnedRoot = rootDirectory, pinnedParent = parent;
    const rootFd = `/proc/self/fd/${pinnedRoot.fd}`, directory = `/proc/self/fd/${pinnedParent.fd}`;
    const descriptorPath = async (path: string) => realpath(path).catch(() => { throw failure(501, '无法核验工作区目录描述符，保存需要可用的 /proc/self/fd'); });
    const check = async () => {
      const rootInfo = await pinnedRoot.stat(), currentInfo = await stat(rootPath);
      if (await descriptorPath(rootFd) !== root || await realpath(rootPath) !== root || rootInfo.dev !== currentInfo.dev || rootInfo.ino !== currentInfo.ino
        || await descriptorPath(directory) !== dirname(target)) throw failure(409, '文件路径已改变，请重新加载');
    };
    await check();
    return {
      directory, check,
      async read<T>(describe: (file: FileHandle) => Promise<T>) {
        await check();
        const file = await open(join(directory, basename(target)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await file.stat();
          if (!info.isFile()) throw failure(400, '只能编辑普通文本文件');
          const checkFile = async () => {
            await check();
            if (await realpath(`/proc/self/fd/${file.fd}`) !== target) throw failure(409, '文件路径已改变，请重新加载');
          };
          await checkFile();
          const value = await describe(file);
          await checkFile();
          return { value, info };
        } finally { await file.close(); }
      },
      async sync() { await pinnedParent.sync(); },
      async close() { try { await pinnedParent.close(); } finally { await pinnedRoot.close(); } },
    };
  } catch (error) {
    await parent?.close().catch(() => undefined); await rootDirectory?.close().catch(() => undefined);
    throw error;
  }
}
