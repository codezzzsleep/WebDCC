import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, basename, dirname, extname } from 'node:path';
import type { ResolvedInputContent } from '@webdcc/protocol';
import type { JsonRpcStdio } from './rpc.js';
import { nativeRequest } from './controls.js';

// rust-v0.167.0 protocol/src/protocol.rs and tui/src/goal_files.rs.
export const MAX_GOAL_CHARS = 4_000;
const prefix = 'Read the Codex goal objective file at ';
const suffix = ' before continuing.';
const reject = (message: string): Error => Object.assign(new Error(message), { code: 'native-control-rejected', statusCode: 400 });
const chars = (value: string): number => [...value].length;

export async function readGoalObjective(rpc: JsonRpcStdio, home: string | undefined, objective: string): Promise<string> {
  if (!home || !objective.startsWith(prefix) || !objective.endsWith(suffix)) return objective;
  const path = objective.slice(prefix.length, -suffix.length); const directory = dirname(path); const id = basename(directory);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || path !== join(home, 'attachments', id, 'goal-objective.md')) return objective;
  const result = await nativeRequest(rpc, 'fs/readFile', { path });
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(result.dataBase64, 'base64'));
}

/** Mirrors native oversized-objective and image materialization. The only
 * input paths come from server-resolved, hash-verified attachment references. */
export async function materializeGoal(rpc: JsonRpcStdio, home: string | undefined, objective: string,
  content?: ResolvedInputContent): Promise<{ objective: string; directory?: string }> {
  if (!objective.trim()) throw reject('原生目标正文不能为空');
  if (content?.parts.some(part => !['text', 'file', 'image'].includes(part.type))) throw reject('原生目标只接受文字、文件和图片');
  if (content?.parts.some(part => part.type === 'text' && part.elements?.length)) throw reject('请按当前正文重新准备目标文字元素');
  const attachments = content?.parts.filter(part => part.type === 'image' || part.type === 'file') ?? [];
  if (!attachments.length && chars(objective) <= MAX_GOAL_CHARS) return { objective };
  if (!home || !isAbsolute(home)) throw reject('原生服务没有返回可信的附件目录');
  // Read all bytes before the first native write; an invalid reference cannot
  // leave a partially replaced goal or a forged native file reference.
  const payloads: { name: string; type: 'file' | 'image'; bytes: Buffer }[] = [];
  for (const part of attachments) {
    if ((part.type !== 'file' && part.type !== 'image') || !isAbsolute(part.path)) throw reject('目标附件必须由服务端解析');
    const file = await open(part.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat(); if (!info.isFile() || info.size !== part.size) throw reject('目标附件大小已变化');
      const bytes = await file.readFile();
      if (bytes.length !== part.size || createHash('sha256').update(bytes).digest('hex') !== part.sha256) throw reject('目标附件内容已变化');
      payloads.push({ name: part.name, type: part.type, bytes });
    } finally { await file.close(); }
  }
  const directory = join(home, 'attachments', randomUUID());
  const objectiveFile = join(directory, 'goal-objective.md'); const reference = prefix + objectiveFile + suffix;
  if (chars(reference) > MAX_GOAL_CHARS) throw reject('原生目标附件目录超出目标长度限制');
  await nativeRequest(rpc, 'fs/createDirectory', { path: directory, recursive: true });
  const imageLines: string[] = []; const fileLines: string[] = [];
  try {
    for (const [index, payload] of payloads.entries()) {
      const extension = extname(payload.name).slice(1).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || (payload.type === 'image' ? 'png' : 'bin');
      const path = join(directory, `${payload.type}-${index + 1}.${extension}`);
      await nativeRequest(rpc, 'fs/writeFile', { path, dataBase64: payload.bytes.toString('base64') });
      (payload.type === 'image' ? imageLines : fileLines).push(`- [${payload.type === 'image' ? 'Image' : 'File'} #${index + 1}]: ${path}`);
    }
    let expanded = objective;
    if (imageLines.length) expanded += '\n\nReferenced image files:\n' + imageLines.join('\n');
    if (fileLines.length) expanded += '\n\nReferenced files:\n' + fileLines.join('\n');
    if (chars(expanded) > MAX_GOAL_CHARS) {
      await nativeRequest(rpc, 'fs/writeFile', { path: objectiveFile, dataBase64: Buffer.from(expanded).toString('base64') });
      expanded = reference;
    }
    return { objective: expanded, directory };
  } catch (error) { await removeGoalFiles(rpc, directory).catch(() => undefined); throw error; }
}

export async function removeGoalFiles(rpc: JsonRpcStdio, directory: string): Promise<void> {
  await nativeRequest(rpc, 'fs/remove', { path: directory, recursive: true, force: true });
}
