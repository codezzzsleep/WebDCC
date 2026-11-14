import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, extname, basename } from 'node:path';
import { constants } from 'node:fs';
import type { FastifyReply } from 'fastify';
import { fileResponseHeaders } from './file-response.js';

const imageTypes: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon' };
export const isImagePath = (path: string): boolean => imageTypes[extname(path).toLowerCase()] !== undefined;
export async function workspaceAsset(rootPath: string, path: string): Promise<string> {
  const root = await realpath(rootPath);
  const target = await realpath(resolve(root, path));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw Object.assign(new Error('路径必须在工作区内'), { statusCode: 400 });
  return target;
}
export async function sendWorkspaceAsset(reply: FastifyReply, target: string): Promise<FastifyReply> {
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = await file.stat();
  if (!info.isFile()) { await file.close(); throw Object.assign(new Error('需要普通文件'), { statusCode: 400 }); }
  const head = Buffer.alloc(32);
  const { bytesRead } = await file.read(head, 0, head.length, 0);
  fileResponseHeaders(reply, basename(target), head.subarray(0, bytesRead));
  reply.header('cache-control', 'private, no-cache');
  return reply.send(file.createReadStream({ start: 0 }));
}
