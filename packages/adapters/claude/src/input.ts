import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ResolvedInputPart, UserInput } from '@webdcc/protocol';
import { isInputContent, publicInputContent } from '@webdcc/protocol';
export type ClaudeUserContent = Extract<SDKUserMessage['message'], { role: 'user' }>['content'];

export const unsupportedClaudeInput = (message: string): Error => Object.assign(new Error(message), { code: 'input-unsupported', statusCode: 400, nativeAdmission: 'not-submitted' });
function partsOf(input: UserInput): ResolvedInputPart[] {
  if (input.contentParts === undefined) return [...(input.images ?? []).map(image => ({ ...image, type: 'image' as const, name: image.name ?? '', sha256: image.sha256 ?? '', size: image.size ?? -1 })), { type: 'text', text: input.text }];
  if (input.images?.length || !isInputContent(publicInputContent(input.contentParts), input.text)) throw unsupportedClaudeInput('结构化输入与编辑框正文不一致');
  return input.contentParts.parts;
}
export function validateClaudeInput(input: UserInput, modalities?: readonly string[]): void {
  const parts = partsOf(input);
  if (!input.text.trim() && !parts.some(part => part.type !== 'text')) throw unsupportedClaudeInput('请输入正文或选择附件');
  for (const part of parts) {
    if (part.type === 'text') { if (part.elements?.length) throw unsupportedClaudeInput('Claude SDK 不支持原生文本元素元数据'); continue; }
    if (part.type === 'audio' || part.type === 'skill' || part.type === 'resource') throw unsupportedClaudeInput(`当前 Claude SDK 不支持独立 ${part.type} 输入`);
    if (part.type === 'image') {
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(part.mime)) throw unsupportedClaudeInput(`Claude 不支持图片格式 ${part.mime}`);
      if (!modalities?.includes('image')) throw unsupportedClaudeInput('当前 Claude 原生模型目录未声明图片输入能力');
    }
    if (part.type === 'file' && part.mime !== 'application/pdf' && !part.mime.startsWith('text/')) throw unsupportedClaudeInput(`Claude SDK 文档输入不支持 ${part.mime}`);
  }
}
export async function encodeClaudeInput(input: UserInput, modalities?: readonly string[]): Promise<ClaudeUserContent> {
  validateClaudeInput(input, modalities);
  const content: Exclude<ClaudeUserContent, string> = [];
  for (const part of partsOf(input)) {
    if (part.type === 'text') { content.push({ type: 'text', text: part.text }); continue; }
    if (part.type === 'audio' || part.type === 'skill' || part.type === 'resource') throw unsupportedClaudeInput(`当前 Claude SDK 不支持 ${part.type}`);
    const file = await stat(part.path); if (!file.isFile() || file.size > 100 * 1024 * 1024) throw unsupportedClaudeInput('附件不是有效普通文件或超过上限');
    const bytes = await readFile(part.path);
    if ((input.contentParts !== undefined || part.size >= 0) && bytes.byteLength !== part.size
      || (input.contentParts !== undefined || part.sha256 !== '') && createHash('sha256').update(bytes).digest('hex') !== part.sha256) throw unsupportedClaudeInput('附件在原生接收前发生变化');
    if (part.type === 'image') content.push({ type: 'image', source: { type: 'base64', media_type: part.mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: bytes.toString('base64') } });
    else if (part.mime === 'application/pdf') content.push({ type: 'document', title: part.name, source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } });
    else {
      let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw unsupportedClaudeInput('文本文档不是有效 UTF-8，不能逐字保留'); }
      if (!Buffer.from(text).equals(bytes)) throw unsupportedClaudeInput('文本文档解码会改变原始字节');
      content.push({ type: 'document', title: part.name, source: { type: 'text', media_type: 'text/plain', data: text } });
    }
  }
  return input.contentParts === undefined && !input.images?.length ? input.text : content;
}
