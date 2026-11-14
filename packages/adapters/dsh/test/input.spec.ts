import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { encodeDshInput, type DshResolvedAttachment, type DshInputV1 } from '../src/input.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-content-parts-')); const bytes = Buffer.from('  exact binary\r\n\0payload '); const path = join(root, 'proof.bin'); await writeFile(path, bytes);
  const part: DshResolvedAttachment = { type: 'file', fileId: 'stable-file', name: 'proof.bin', mime: 'application/octet-stream', path, sha256: createHash('sha256').update(bytes).digest('hex') };
  return { root, bytes, part };
}
it('remote native files receive exact bytes and a new Session-scoped receipt, with no path or instructions added to editor text', async () => {
  const { root, bytes, part } = await fixture(); const staged: unknown[] = []; let sequence = 0;
  try {
    const input = { text: '  原文\r\n  ', contentParts: { version: 1 as const, parts: [{ type: 'text' as const, text: '  原文\r\n  ' }, part] } };
    const options = { uploadFile: async (selected: DshResolvedAttachment, actual: Uint8Array) => {
      staged.push({ selected, bytes: Buffer.from(actual) }); return { receiptId: `native-receipt-${++sequence}`, file: { attachmentId: `sha256:${part.sha256}`, name: 'proof.bin', bytes: bytes.length } };
    } };
    const first = await encodeDshInput(input, options); const second = await encodeDshInput(input, options);
    expect(first.content).toEqual([{ type: 'text', text: input.text }, { type: 'file', receiptId: 'native-receipt-1' }]);
    expect(second.content[1]).toEqual({ type: 'file', receiptId: 'native-receipt-2' });
    expect(staged[0]).toEqual({ selected: part, bytes });
    expect(JSON.stringify(first.content)).not.toMatch(/proof\.bin|exact binary|Use|read|payload/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('images preserve MIME/name/bytes and pure images require an actual positive model declaration', async () => {
  const { root, bytes, part } = await fixture();
  try {
    const image: DshResolvedAttachment = { ...part, type: 'image', mime: 'image/png', name: 'image.png' };
    const input = { text: '', contentParts: { version: 1 as const, parts: [image] } };
    const uploadFile = async () => { throw new Error('images must use native image data, not file receipts'); };
    await expect(encodeDshInput(input, { uploadFile })).rejects.toMatchObject({ code: 'dsh-input-unsupported' });
    await expect(encodeDshInput(input, { inputModalities: ['text'], uploadFile })).rejects.toMatchObject({ code: 'dsh-input-unsupported' });
    expect((await encodeDshInput(input, { inputModalities: ['text', 'image'], uploadFile })).content).toEqual([{ type: 'image', mediaType: 'image/png', name: 'image.png', data: bytes.toString('base64') }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('unsupported audio/references/text metadata and mismatched text reject before staging anything', async () => {
  let uploads = 0; const uploadFile = async () => { uploads++; throw new Error('should not stage'); };
  const content = (parts: DshInputV1['parts']) => ({ text: '', contentParts: { version: 1 as const, parts } });
  for (const part of [{ type: 'audio', fileId: 'a', path: 'never-read', mime: 'audio/wav' }, { type: 'skill', id: 'skill' }, { type: 'resource', uri: 'native:resource' }, { type: 'text', text: '', elements: [{ type: 'file' }] }] as DshInputV1['parts']) {
    await expect(encodeDshInput(content([part]), { uploadFile })).rejects.toMatchObject({ code: 'dsh-input-unsupported' });
  }
  await expect(encodeDshInput({ text: 'editor', contentParts: { version: 1, parts: [{ type: 'text', text: 'changed' }] } }, { uploadFile })).rejects.toThrow('differ');
  await expect(encodeDshInput(content([]), { uploadFile })).rejects.toThrow('implicitly continue');
  expect(uploads).toBe(0);
});
it('changed attachment hashes reject without native upload', async () => {
  const { root, part } = await fixture(); let uploaded = false;
  try {
    await writeFile(part.path, 'changed');
    await expect(encodeDshInput({ text: 'original', contentParts: { version: 1, parts: [{ type: 'text', text: 'original' }, part] } }, {
      uploadFile: async () => { uploaded = true; throw new Error('should not upload'); },
    })).rejects.toThrow('bytes changed');
    expect(uploaded).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
