import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, extname, basename } from 'node:path';
import type { ReadStream } from 'node:fs';
import type { FastifyReply } from 'fastify';
import { fileResponseHeaders } from './file-response.js';
import { openWorkspaceRead } from './workspace-read.js';

const imageTypes: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon' };
export const isImagePath = (path: string): boolean => imageTypes[extname(path).toLowerCase()] !== undefined;
export async function workspaceAsset(rootPath: string, path: string): Promise<string> {
  const root = await realpath(rootPath);
  const target = await realpath(resolve(root, path));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw Object.assign(new Error('路径必须在工作区内'), { statusCode: 400 });
  return target;
}
export async function sendWorkspaceAsset(reply: FastifyReply, target: string, rootPath: string): Promise<FastifyReply> {
  const file = await openWorkspaceRead(rootPath, target); let stream: ReadStream | undefined;
  try {
    const head = Buffer.alloc(32);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    fileResponseHeaders(reply, basename(target), head.subarray(0, bytesRead));
    reply.header('cache-control', 'private, no-cache');
    stream = file.createReadStream({ start: 0 });
    return await reply.send(stream);
  } catch (error) {
    stream?.destroy(); await file.close().catch(() => undefined); throw error;
  }
}
