import { constants } from 'node:fs';
import { mkdir, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

function failure(statusCode: number, message: string): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode }); }
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

/** Create through a verified parent descriptor. Directory replacement must
 * not redirect a later mkdir/open outside the workspace. Path changes after
 * the filesystem operation remain a conflict, with no automatic retry. */
export async function createWorkspaceEntry(rootPath: string, requested: string, kind: 'file' | 'dir', content: string): Promise<{ path: string; kind: 'file' | 'dir' }> {
  if (process.platform !== 'linux') throw failure(501, '当前平台无法核验工作区目录描述符，创建不可用');
  if (requested === '' || requested.includes('\0') || isAbsolute(requested)) throw failure(400, '需要工作区内的相对路径');
  const root = await realpath(rootPath); const rootInfo = await stat(root);
  const wanted = resolve(root, requested);
  if (wanted === root || !inside(root, wanted)) throw failure(400, '路径必须在工作区内');
  const parentPath = await realpath(dirname(wanted)).catch(() => { throw failure(400, '父目录不存在'); });
  if (!inside(root, parentPath)) throw failure(400, '路径必须在工作区内');
  let parent: FileHandle | undefined; let created = false;
  try {
    parent = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const fdPath = `/proc/self/fd/${parent.fd}`;
    const check = async (): Promise<void> => {
      const actual = await realpath(fdPath).catch(() => { throw failure(501, '无法核验工作区目录描述符，创建需要可用的 /proc/self/fd'); });
      const currentRoot = await realpath(rootPath); const currentInfo = await stat(rootPath);
      if (actual !== parentPath || !inside(root, actual) || currentRoot !== root || currentInfo.dev !== rootInfo.dev || currentInfo.ino !== rootInfo.ino) {
        throw failure(409, created ? '创建期间路径已改变，请核对原目录并重新加载' : '文件路径已改变，请重新加载');
      }
    };
    await check();
    const target = join(fdPath, basename(wanted));
    if (kind === 'dir') { await mkdir(target); created = true; }
    else {
      const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
      created = true;
      try { await file.writeFile(content, { encoding: 'utf8' }); } finally { await file.close(); }
    }
    await check();
    return { path: relative(root, join(parentPath, basename(wanted))), kind };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw failure(400, kind === 'dir' ? '目录已存在' : '文件已存在');
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(code ?? '')) throw failure(409, created ? '创建期间路径已改变，请核对原目录并重新加载' : '文件路径已改变，请重新加载');
    throw error;
  } finally { await parent?.close().catch(() => undefined); }
}
