import { constants, lstatSync, realpathSync } from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const conflict = (message = '附件 CAS 路径在读取时改变') => Object.assign(new Error(message), { statusCode: 409 });
const unavailable = () => Object.assign(new Error('当前平台无法核验附件 CAS 描述符，读取不可用'), { statusCode: 501 });
function pathError(error: unknown): unknown {
  return ['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') ? conflict('附件 CAS 路径不是可信的普通目录或文件') : error;
}

/** Pin each CAS directory before opening its child. Checks bind the opened
 * file to its current canonical path, including after asynchronous reads. */
export async function openCasObject(objectsPath: string, sha256: string) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw conflict('附件 CAS hash 无效');
  if (process.platform !== 'linux') throw unavailable();
  const handles: FileHandle[] = [];
  const fdPath = (file: FileHandle) => `/proc/self/fd/${file.fd}`;
  const close = async () => {
    let error: unknown;
    for (const file of handles.splice(0).reverse()) try { await file.close(); } catch (caught) { error ??= caught; }
    if (error !== undefined) throw error;
  };
  try {
    const dataPath = await realpath(dirname(objectsPath));
    const data = await open(dataPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(data);
    try { await realpath(fdPath(data)); } catch { throw unavailable(); }
    const rootPath = join(dataPath, 'files');
    const root = await open(join(fdPath(data), 'files'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(root);
    const prefixPath = join(rootPath, sha256.slice(0, 2));
    const prefixInfo = await lstat(prefixPath);
    if (!prefixInfo.isDirectory() || prefixInfo.isSymbolicLink()) throw conflict('附件 CAS 前缀不是普通目录');
    const prefix = await open(join(fdPath(root), sha256.slice(0, 2)), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(prefix);
    const path = join(prefixPath, sha256);
    const file = await open(join(fdPath(prefix), sha256), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); handles.push(file);
    const identities = [
      { path: dataPath, info: await data.stat(), object: false },
      { path: rootPath, info: await root.stat(), object: false },
      { path: prefixPath, info: await prefix.stat(), object: false },
      { path, info: await file.stat(), object: true },
    ];
    const check = async () => {
      try {
        const matches = async (handle: FileHandle, current: string, ordinaryFile: boolean) => {
          const pinned = await handle.stat(), present = await lstat(current);
          if (pinned.dev !== present.dev || pinned.ino !== present.ino || present.isSymbolicLink()
            || (ordinaryFile ? !pinned.isFile() : !pinned.isDirectory()) || await realpath(fdPath(handle)) !== current) throw conflict();
        };
        const dataInfo = await data.stat(), currentData = await stat(dirname(objectsPath));
        if (dataInfo.dev !== currentData.dev || dataInfo.ino !== currentData.ino || await realpath(dirname(objectsPath)) !== dataPath
          || await realpath(fdPath(data)) !== dataPath || await realpath(objectsPath) !== rootPath) throw conflict();
        await matches(root, rootPath, false);
        await matches(prefix, prefixPath, false);
        await matches(file, path, true);
      } catch (error) {
        if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw conflict();
        throw error;
      }
    };
    await check();
    // Closing FileHandles yields. Recheck retained identities synchronously
    // after all cleanup, before allowing a successful path to leave the store.
    const finish = async () => {
      await close();
      try {
        if (realpathSync(dirname(objectsPath)) !== dataPath || realpathSync(objectsPath) !== rootPath) throw conflict();
        for (const identity of identities) {
          const current = lstatSync(identity.path), pinned = identity.info;
          if (current.dev !== pinned.dev || current.ino !== pinned.ino || current.isSymbolicLink()
            || (identity.object ? !current.isFile() : !current.isDirectory())) throw conflict();
          if (identity.object && (current.size !== pinned.size || current.mtimeMs !== pinned.mtimeMs || current.ctimeMs !== pinned.ctimeMs)) throw conflict('附件 CAS 对象在读取时改变');
        }
      } catch (error) {
        if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw conflict();
        throw error;
      }
    };
    return { path, file, check, close, finish };
  } catch (error) {
    await close();
    throw pathError(error);
  }
}
