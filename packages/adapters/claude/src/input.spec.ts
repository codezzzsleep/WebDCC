import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { encodeClaudeInput, validateClaudeInput } from './input.js';

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

async function pixel() {
  const dir = await mkdtemp(join(tmpdir(), 'claude-image-'));
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n1sAAAAASUVORK5CYII=', 'base64');
  const path = join(dir, 'pixel.png'); await writeFile(path, bytes);
  const image = { type: 'image' as const, fileId: 'image', path, mime: 'image/png', name: 'pixel.png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  return { image, bytes, close: () => rm(dir, { recursive: true, force: true }) };
}

it('accepts the pinned SDK image block without a ModelInfo modality field and preserves legacy order/text', async () => {
  const ctx = await pixel();
  try {
    const text = '  原文\r\n🖼️  ';
    expect(await encodeClaudeInput({ text, images: [ctx.image] })).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: ctx.bytes.toString('base64') } }, { type: 'text', text }]);
  } finally { await ctx.close(); }
});

it('preserves a pure image as a native block without injecting a text prompt', async () => {
  const ctx = await pixel();
  try {
    expect(await encodeClaudeInput({ text: '', contentParts: { version: 1, parts: [ctx.image] } })).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: ctx.bytes.toString('base64') } }]);
  } finally { await ctx.close(); }
});

it('keeps an explicit image prohibition and unsupported MIME as pre-admission failures', async () => {
  const ctx = await pixel();
  try {
    expect(() => validateClaudeInput({ text: 'exact', images: [ctx.image] }, ['text'])).toThrow('图片');
    await expect(encodeClaudeInput({ text: 'exact', images: [{ ...ctx.image, mime: 'image/bmp' }] })).rejects.toMatchObject({ code: 'input-unsupported', nativeAdmission: 'not-submitted' });
  } finally { await ctx.close(); }
});

it.each(['size', 'hash'])('rejects changed image %s before native admission under the default SDK contract', async field => {
  const ctx = await pixel();
  try {
    const image = field === 'size' ? { ...ctx.image, size: ctx.image.size + 1 } : { ...ctx.image, sha256: '0'.repeat(64) };
    await expect(encodeClaudeInput({ text: 'exact', images: [image] })).rejects.toThrow('附件在原生接收前发生变化');
  } finally { await ctx.close(); }
});
