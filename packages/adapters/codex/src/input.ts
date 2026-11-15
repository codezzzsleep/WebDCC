import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { UserInput, ResolvedInputPart } from '@webdcc/protocol';
import { isInputContent, publicInputContent } from '@webdcc/protocol';
import type { UserInput as NativeUserInput } from './schema/v2/UserInput.js';

export const unsupportedCodexInput = (message: string): Error => Object.assign(new Error(message), { code: 'input-unsupported', statusCode: 400, nativeAdmission: 'not-submitted' });
export function codexInputParts(input: UserInput): ResolvedInputPart[] {
  if (input.contentParts === undefined) return [...(input.images ?? []).map(image => ({ ...image, type: 'image' as const, name: image.name ?? '', sha256: image.sha256 ?? '', size: image.size ?? -1 })), { type: 'text', text: input.text }];
  if (input.images?.length || !isInputContent(publicInputContent(input.contentParts), input.text)) throw unsupportedCodexInput('结构化输入与编辑框正文不一致');
  return input.contentParts.parts;
}
export function validateCodexInput(input: UserInput, modalities?: readonly string[]): void {
  const parts = codexInputParts(input);
  if (!input.text.trim() && !parts.some(part => part.type !== 'text')) throw unsupportedCodexInput('请输入正文或选择附件');
  for (const part of parts) {
    if (part.type === 'file') throw unsupportedCodexInput('当前 Codex 原生结构化输入不支持独立文件附件，请选择支持文件的 Agent');
    if (part.type === 'resource') throw unsupportedCodexInput('当前 Codex 原生输入不支持独立资源引用');
    if ((part.type === 'image' || part.type === 'audio') && !modalities?.includes(part.type)) throw unsupportedCodexInput(`当前 Codex 模型未声明支持 ${part.type} 输入`);
    if (part.type === 'image' && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(part.mime)) throw unsupportedCodexInput(`Codex 不支持图片格式 ${part.mime}`);
    if (part.type === 'audio' && !part.mime.startsWith('audio/')) throw unsupportedCodexInput('音频附件的原生类型不匹配');
    if (part.type !== 'text' && (typeof part.path !== 'string' || part.path === '')) throw unsupportedCodexInput('附件或技能没有可信原生路径');
  }
}
export async function encodeCodexInput(input: UserInput, modalities?: readonly string[]): Promise<NativeUserInput[]> {
  validateCodexInput(input, modalities); const result: NativeUserInput[] = [];
  for (const part of codexInputParts(input)) {
    if (part.type === 'text') { result.push({ type: 'text', text: part.text, text_elements: part.elements ?? [] }); continue; }
    if (part.type === 'skill') { result.push({ type: 'skill', name: part.name, path: part.path }); continue; }
    if (part.type === 'resource') throw unsupportedCodexInput('当前 Codex 原生输入不支持独立资源引用');
    if (part.type === 'file') throw unsupportedCodexInput('Codex 原生输入不支持独立文件附件');
    const file = await stat(part.path); if (!file.isFile() || file.size > 100 * 1024 * 1024) throw unsupportedCodexInput('附件不是有效的普通文件或超过上限');
    const bytes = await readFile(part.path);
    if ((input.contentParts !== undefined || part.size >= 0) && bytes.byteLength !== part.size
      || (input.contentParts !== undefined || part.sha256 !== '') && createHash('sha256').update(bytes).digest('hex') !== part.sha256) throw unsupportedCodexInput('附件在原生接收前发生变化');
    if (part.type === 'image') result.push({ type: 'localImage', path: part.path });
    else if (part.type === 'audio') result.push({ type: 'localAudio', path: part.path });
  }
  return result;
}
