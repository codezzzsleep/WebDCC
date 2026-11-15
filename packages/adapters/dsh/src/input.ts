import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { DshFileUploadValue } from './host.js';
import type { DshInputModality } from './input-capabilities.js';

export interface DshResolvedAttachment { type: 'image' | 'file' | 'audio'; fileId: string; path: string; mime: string; name?: string; sha256?: string }
export interface DshTextPart { type: 'text'; text: string; elements?: unknown[] }
export interface DshInputV1 { version: 1; parts: (DshTextPart | DshResolvedAttachment | { type: 'skill' | 'resource'; [key: string]: unknown })[] }
export interface DshResolvableInput { text: string; images?: { fileId: string; path: string; mime: string; name?: string; sha256?: string }[]; contentParts?: DshInputV1 }
export type DshPromptPart = { type: 'text'; text: string } | { type: 'image'; mediaType: string; data: string; name?: string } | { type: 'file'; receiptId: string };
export interface DshEncodedInput { content: DshPromptPart[]; submittedAttachments: Exclude<DshPromptPart, { type: 'text'; text: string }>[] }
export function dshInputUnsupported(message: string): Error { return Object.assign(new Error(message), { code: 'dsh-input-unsupported', statusCode: 400, nativeAdmission: 'not-submitted' }); }
export function dshInputParts(input: DshResolvableInput): DshInputV1['parts'] {
  if (input.contentParts === undefined) return [{ type: 'text', text: input.text }, ...(input.images ?? []).map(image => ({ ...image, type: 'image' as const }))];
  if (input.contentParts.version !== 1 || !Array.isArray(input.contentParts.parts)) throw dshInputUnsupported('DSH input content version is unsupported');
  if (input.images?.length) throw dshInputUnsupported('Do not combine legacy images with versioned content parts');
  if (input.contentParts.parts.filter(part => part.type === 'text').map(part => (part as DshTextPart).text).join('') !== input.text) throw dshInputUnsupported('The editor text and structured text parts differ');
  return input.contentParts.parts;
}
/** Validate representability before upload. Native user selections remain
 * explicit parts; unsupported references/audio are never turned into prose. */
export function validateDshInputParts(parts: DshInputV1['parts'], inputModalities?: readonly DshInputModality[]): void {
  for (const part of parts) {
    if (part.type === 'text') {
      if (typeof part.text !== 'string' || part.elements !== undefined && (!Array.isArray(part.elements) || part.elements.length > 0)) throw dshInputUnsupported('DSH 0.2 prompt text does not accept structured text elements');
      continue;
    }
    if (part.type !== 'image' && part.type !== 'file') throw dshInputUnsupported(`DSH 0.2 native prompt schema does not support ${part.type} input`);
    if (typeof part.fileId !== 'string' || !part.fileId || typeof part.path !== 'string' || !part.path || typeof part.mime !== 'string') throw dshInputUnsupported('DSH attachment is not a resolved uploaded file');
    if (part.type === 'image') {
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(part.mime)) throw dshInputUnsupported(`DSH 不支持图片格式 ${part.mime}`);
      if (!inputModalities?.includes('image')) throw dshInputUnsupported('The current native model does not declare image support; choose a model with a verified image input declaration');
    }
  }
}
export async function encodeDshInput(input: DshResolvableInput, options: { inputModalities?: readonly DshInputModality[];
  uploadFile: (part: DshResolvedAttachment, bytes: Uint8Array) => Promise<DshFileUploadValue> }): Promise<DshEncodedInput> {
  const parts = dshInputParts(input); validateDshInputParts(parts, options.inputModalities);
  if (input.text.trim() === '' && !parts.some(part => part.type === 'image' || part.type === 'file')) throw dshInputUnsupported('An empty ordinary message cannot implicitly continue a failed native turn');
  const content: DshPromptPart[] = [];
  for (const part of parts) {
    if (part.type === 'text') { content.push({ type: 'text', text: part.text }); continue; }
    const attachment = part as DshResolvedAttachment;
    const file = await stat(attachment.path);
    if (!file.isFile() || file.size > 100 * 1024 * 1024) throw dshInputUnsupported('DSH attachment is not a regular file within the upload limit');
    const bytes = await readFile(attachment.path);
    if (bytes.byteLength !== file.size || bytes.byteLength > 100 * 1024 * 1024) throw dshInputUnsupported('The attachment changed size before native admission');
    if (attachment.sha256 !== undefined && createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) throw dshInputUnsupported('The uploaded attachment bytes changed before native admission');
    if (attachment.type === 'image') content.push({ type: 'image', mediaType: attachment.mime, data: bytes.toString('base64'), ...(attachment.name === undefined ? {} : { name: attachment.name }) });
    else {
      // Receipts are minted afresh for this exact native Session. They live in
      // a native WeakMap and must not be restored from a Web draft after boot.
      const uploaded = await options.uploadFile(attachment, bytes);
      content.push({ type: 'file', receiptId: uploaded.receiptId });
    }
  }
  return { content, submittedAttachments: content.filter((part): part is DshEncodedInput['submittedAttachments'][number] => part.type !== 'text') };
}
