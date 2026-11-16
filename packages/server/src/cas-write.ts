import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function failure(message: string, statusCode = 409): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode }); }
function pathFailure(error: unknown): unknown {
  return ['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '') ? failure('附件 CAS 路径已改变，文件尚未确认保存') : error;
}

/** Directory descriptors are shared by synchronous diff storage and async
 * buffer storage. Payload IO remains asynchronous in the async entrypoint. */
export function openCasDirectory(objectsPath: string, sha256: string, replaceObjectLink = false) {
  if (process.platform !== 'linux') throw failure('当前平台无法核验附件 CAS 目录描述符，写入不可用', 501);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw failure('附件 hash 无效', 400);
  const descriptors: number[] = [];
  let closed = false;
  try {
    const dataPath = realpathSync(dirname(objectsPath)), rootPath = join(dataPath, 'files');
    const data = openSync(dataPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); descriptors.push(data);
    const dataFd = `/proc/self/fd/${data}`;
    try { realpathSync(dataFd); } catch { throw failure('无法核验附件 CAS 描述符，需要可用的 /proc/self/fd', 501); }
    const root = openSync(join(dataFd, 'files'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); descriptors.push(root);
    const rootFd = `/proc/self/fd/${root}`, prefix = sha256.slice(0, 2), prefixPath = join(rootPath, prefix);
    const checkRoot = () => {
      if (closed) throw failure('附件 CAS 写入实例已关闭');
      const pinned = fstatSync(data), current = statSync(dirname(objectsPath));
      if (pinned.dev !== current.dev || pinned.ino !== current.ino || realpathSync(dirname(objectsPath)) !== dataPath || realpathSync(dataFd) !== dataPath
        || realpathSync(rootFd) !== rootPath || realpathSync(objectsPath) !== rootPath) throw failure('附件 CAS 目录路径已改变');
    };
    checkRoot();
    try { mkdirSync(join(rootFd, prefix), { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const parent = openSync(join(rootFd, prefix), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); descriptors.push(parent);
    const directory = `/proc/self/fd/${parent}`;
    const check = () => { checkRoot(); if (realpathSync(directory) !== prefixPath) throw failure('附件 CAS 目录路径已改变'); };
    const target = join(directory, sha256), temporary = join(directory, `.webdcc-${randomUUID()}.tmp`);
    const checkTarget = () => {
      check();
      let info;
      try { info = lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (!(replaceObjectLink && info.isSymbolicLink()) && (!info.isFile() || info.isSymbolicLink())) throw failure('附件 CAS 对象不是可信的普通文件');
    };
    const checkFile = (fd: number, name: string) => {
      check();
      if (!fstatSync(fd).isFile() || realpathSync(`/proc/self/fd/${fd}`) !== join(prefixPath, name)) throw failure('附件 CAS 文件路径已改变');
    };
    checkTarget();
    let published = false;
    const report = (error: unknown) => published
      ? Object.assign(failure(`附件已写入原 CAS 目录，但无法确认当前路径、内容或同步：${error instanceof Error ? error.message : String(error)}`), { code: 'cas-published-unconfirmed', sha256, published: true })
      : pathFailure(error);
    return {
      target, temporary, check, checkTarget, checkFile, report,
      publish(source = temporary) { checkTarget(); renameSync(source, target); published = true; check(); fsyncSync(parent); fsyncSync(root); checkTarget(); },
      close() {
        if (closed) return;
        closed = true;
        let error: unknown;
        try { unlinkSync(temporary); } catch (caught) { if ((caught as NodeJS.ErrnoException).code !== 'ENOENT') error = caught; }
        for (const fd of descriptors.splice(0).reverse()) try { closeSync(fd); } catch (caught) { error ??= caught; }
        if (error !== undefined) throw report(error);
      },
    };
  } catch (error) { for (const fd of descriptors.reverse()) closeSync(fd); throw pathFailure(error); }
}

function matchesSync(destination: ReturnType<typeof openCasDirectory>, payload: Buffer, sha256: string): boolean {
  let fd: number;
  try { fd = openSync(destination.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  try {
    destination.checkFile(fd, sha256);
    if (fstatSync(fd).size !== payload.length) return false;
    const bytes = Buffer.alloc(payload.length + 1); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (count === 0) break; offset += count; }
    destination.checkFile(fd, sha256);
    return offset === payload.length && bytes.subarray(0, offset).equals(payload);
  } finally { closeSync(fd); }
}

export function writeCasBufferSync(objectsPath: string, sha256: string, payload: Buffer): void {
  const destination = openCasDirectory(objectsPath, sha256);
  try {
    if (matchesSync(destination, payload, sha256)) return;
    const fd = openSync(destination.temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { destination.check(); writeFileSync(fd, payload); fsyncSync(fd); destination.check(); }
    finally { closeSync(fd); }
    destination.publish();
    if (!matchesSync(destination, payload, sha256)) throw failure('附件 CAS 保存后内容已改变');
  } catch (error) { throw destination.report(error); }
  finally { destination.close(); }
}

export async function writeCasBuffer(objectsPath: string, sha256: string, payload: Buffer): Promise<void> {
  const destination = openCasDirectory(objectsPath, sha256);
  const matches = async () => {
    let file;
    try { file = await open(destination.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    try {
      destination.checkFile(file.fd, sha256);
      if ((await file.stat()).size !== payload.length) return false;
      const bytes = Buffer.alloc(payload.length + 1); let offset = 0;
      while (offset < bytes.length) { const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset); if (bytesRead === 0) break; offset += bytesRead; }
      destination.checkFile(file.fd, sha256);
      return offset === payload.length && bytes.subarray(0, offset).equals(payload);
    } finally { await file.close(); }
  };
  try {
    if (await matches()) return;
    const file = await open(destination.temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { destination.check(); await file.writeFile(payload); await file.sync(); destination.check(); }
    finally { await file.close(); }
    destination.publish();
    if (!await matches()) throw failure('附件 CAS 保存后内容已改变');
  } catch (error) { throw destination.report(error); }
  finally { destination.close(); }
}

/** A completed upload repairs only the already verified immutable identity.
 * Atomic rename replaces a link itself; it never writes to the link target. */
export async function publishCasFile(objectsPath: string, sha256: string, source: string, size: number): Promise<void> {
  const destination = openCasDirectory(objectsPath, sha256, true);
  try {
    destination.publish(source);
    const file = await open(destination.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      destination.checkFile(file.fd, sha256);
      if ((await file.stat()).size !== size) throw failure('附件 CAS 保存后长度改变');
      const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024); let total = 0;
      while (total <= size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size + 1 - total), total);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead)); total += bytesRead;
      }
      destination.checkFile(file.fd, sha256);
      if (total !== size || hash.digest('hex') !== sha256) throw failure('附件 CAS 保存后内容改变，上传尚未完成');
    } finally { await file.close(); }
  } catch (error) { throw destination.report(error); }
  finally { destination.close(); }
}
