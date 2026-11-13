import { constants } from 'node:fs';
import { open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FsReadResponse } from '@webdcc/protocol';

export const MAX_EDIT_BYTES = 1024 * 1024;
export interface FileOperation { operation: 'read' | 'save'; workspaceId: string; path: string; source: 'user'; outcome: 'completed' | 'failed' | 'conflict'; before?: string; after?: string; bytes?: number; error?: string; }
function failure(statusCode: number, message: string): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode }); }
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function inside(root: string, target: string): boolean { const path = relative(root, target); return path === '' || (path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path)); }
export async function resolveWorkspaceFile(rootPath: string, requested: string): Promise<{ root: string; target: string }> {
  if (isAbsolute(requested) || requested.includes('\0')) throw failure(400, '需要工作区内的相对路径');
  const root = await realpath(rootPath);
  const wanted = resolve(root, requested);
  if (!inside(root, wanted)) throw failure(400, '路径必须在工作区内');
  const target = await realpath(wanted).catch(() => { throw failure(404, '文件不存在'); });
  if (!inside(root, target)) throw failure(400, '路径必须在工作区内');
  return { root, target };
}
async function boundedRead(target: string): Promise<Buffer> {
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const parts: Buffer[] = []; let size = 0;
    while (size <= MAX_EDIT_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_EDIT_BYTES + 1 - size));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, size);
      if (bytesRead === 0) break;
      parts.push(chunk.subarray(0, bytesRead)); size += bytesRead;
    }
    return Buffer.concat(parts);
  } finally { await file.close(); }
}
async function describe(target: string, path: string): Promise<FsReadResponse> {
  const info = await stat(target);
  if (!info.isFile()) throw failure(400, '只能编辑普通文本文件');
  const buffer = await boundedRead(target);
  const truncated = info.size > MAX_EDIT_BYTES || buffer.length > MAX_EDIT_BYTES;
  const bom = buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const bytes = bom ? buffer.subarray(3) : buffer;
  let content = '';
  let reason: string | undefined;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, MAX_EDIT_BYTES)); }
  catch { reason = '二进制或非 UTF-8 文件仅支持下载'; }
  if (bytes.includes(0)) reason = '二进制文件仅支持下载';
  const newline = content.includes('\r\n') ? /(?<!\r)\n/.test(content) ? 'mixed' : 'crlf' : 'lf';
  if (truncated) reason = '文件超过 1 MiB，预览被截断，不能覆盖保存';
  if (newline === 'mixed') reason = '文件包含混合换行，暂时只读以保留原始字节';
  if ((info.mode & 0o222) === 0) reason = '文件没有写权限';
  return { path, content: reason?.startsWith('二进制') ? '' : content, truncated, editable: reason === undefined, ...(reason === undefined ? {} : { readOnlyReason: reason }), version: truncated ? undefined : digest(buffer), size: info.size, bom, newline };
}

/** Optimistic saves check the disk version twice and serialize API writers.
 * Replacement stays in the original directory and preserves mode/ownership. */
export class WorkspaceFiles {
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly observe?: (event: FileOperation) => void) {}
  private note(event: FileOperation): void { try { this.observe?.(event); } catch { /* recording must not change file behavior */ } }
  async read(workspaceId: string, rootPath: string, path: string): Promise<FsReadResponse> {
    const { root, target } = await resolveWorkspaceFile(rootPath, path);
    const result = await describe(target, relative(root, target));
    this.note({ operation: 'read', workspaceId, path: result.path, source: 'user', outcome: 'completed', before: result.version, bytes: result.size });
    return result;
  }
  async save(workspaceId: string, rootPath: string, path: string, content: string, version: string): Promise<FsReadResponse> {
    if (!/^[a-f0-9]{64}$/.test(version)) throw failure(428, '保存需要读取时的文件版本');
    if (Buffer.from(content).toString('utf8') !== content) throw failure(400, '内容包含无效 Unicode');
    if (Buffer.byteLength(content) > MAX_EDIT_BYTES) throw failure(413, '编辑内容不能超过 1 MiB');
    const { root, target } = await resolveWorkspaceFile(rootPath, path);
    const previous = this.locks.get(target) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>(resolveLock => { release = resolveLock; });
    const chain = previous.then(() => lock);
    this.locks.set(target, chain);
    await previous;
    let temporary: string | undefined;
    let parent: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const original = await describe(target, relative(root, target));
      if (!original.editable) throw failure(403, original.readOnlyReason ?? '文件只读');
      if (original.version !== version) throw failure(409, '文件已被其他请求修改，请重新加载后再保存');
      const info = await stat(target);
      const text = original.newline === 'crlf' ? content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : content;
      const payload = Buffer.concat([original.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text)]);
      if (payload.length > MAX_EDIT_BYTES) throw failure(413, '编辑内容不能超过 1 MiB');
      parent = await open(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      // On Linux a directory descriptor prevents a replaced ancestor symlink
      // from redirecting the write. Other hosts recheck the canonical parent.
      const directory = process.platform === 'linux' ? `/proc/self/fd/${parent.fd}` : dirname(target);
      if (!inside(root, await realpath(directory))) throw failure(409, '文件路径已改变，请重新加载');
      temporary = join(directory, `.${basename(target)}.webdcc-${randomUUID()}`);
      const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, info.mode & 0o777);
      try {
        await output.writeFile(payload);
        await output.chmod(info.mode & 0o777);
        const own = await output.stat();
        if (own.uid !== info.uid || own.gid !== info.gid) await output.chown(info.uid, info.gid);
        await output.sync();
      } finally { await output.close(); }
      const currentRoot = await realpath(rootPath);
      const currentParent = await realpath(directory);
      if (currentRoot !== root || !inside(root, currentParent) || await realpath(target) !== target) throw failure(409, '文件路径已改变，请重新加载');
      const latest = await describe(target, relative(root, target));
      if (latest.version !== version) throw failure(409, '文件已被其他请求修改，请重新加载后再保存');
      if (!latest.editable) throw failure(403, latest.readOnlyReason ?? '文件只读');
      await rename(temporary, join(directory, basename(target))); temporary = undefined;
      await parent.sync().catch(() => undefined);
      const saved = await describe(target, relative(root, target));
      this.note({ operation: 'save', workspaceId, path: saved.path, source: 'user', outcome: 'completed', before: version, after: saved.version, bytes: saved.size });
      return saved;
    } catch (error) {
      this.note({ operation: 'save', workspaceId, path, source: 'user', outcome: (error as { statusCode?: number }).statusCode === 409 ? 'conflict' : 'failed', before: version, error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      if (temporary !== undefined) await unlink(temporary).catch(() => undefined);
      await parent?.close().catch(() => undefined);
      release(); if (this.locks.get(target) === chain) this.locks.delete(target);
    }
  }
}
