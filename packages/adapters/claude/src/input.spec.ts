import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { encodeClaudeInput } from './input.js';

it('Claude preserves text and UTF8 document bytes in native blocks, rejects lossy text and unsupported references', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-input-'));
  try {
    const bytes = Buffer.from('\uFEFF  原文\r\n\0正文  '); const path = join(dir, 'chosen.txt'); await writeFile(path, bytes);
    const file = { type: 'file' as const, fileId: 'file', path, name: 'chosen.txt', mime: 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const input = { text: '  input\r\n ', contentParts: { version: 1 as const, parts: [{ type: 'text' as const, text: '  input\r\n ' }, file] } };
    expect(await encodeClaudeInput(input)).toEqual([{ type: 'text', text: input.text }, { type: 'document', title: 'chosen.txt', source: { type: 'text', media_type: 'text/plain', data: bytes.toString('utf8') } }]);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n1sAAAAASUVORK5CYII=', 'base64');
    const imagePath = join(dir, 'pixel.png'); await writeFile(imagePath, png);
    const image = { fileId: 'image', path: imagePath, mime: 'image/png', name: 'pixel.png', size: png.length, sha256: createHash('sha256').update(png).digest('hex') };
    const legacy = { text: 'legacy exact', images: [image] };
    expect(await encodeClaudeInput(legacy, ['image'])).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }, { type: 'text', text: 'legacy exact' }]);
    await expect(encodeClaudeInput({ ...legacy, images: [{ ...legacy.images[0]!, sha256: '0'.repeat(64) }] }, ['image'])).rejects.toMatchObject({ nativeAdmission: 'not-submitted' });
    await expect(encodeClaudeInput({ text: '', contentParts: { version: 1, parts: [{ type: 'resource', uri: 'native:resource' }] } })).rejects.toThrow('不支持');
    const invalid = Buffer.from([0xff, 0x00]); await writeFile(path, invalid);
    await expect(encodeClaudeInput({ text: '', contentParts: { version: 1, parts: [{ ...file, size: invalid.length, sha256: createHash('sha256').update(invalid).digest('hex') }] } })).rejects.toThrow('UTF-8');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
