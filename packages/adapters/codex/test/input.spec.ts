import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { encodeCodexInput } from '../src/input.js';
import { validateNativeParams } from '../src/controls.js';

it('Codex retains native text elements and selected skills, verifies real image/audio bytes and rejects file-as-mention', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-input-'));
  try {
    const skillPath = join(dir, 'SKILL.md'); await writeFile(skillPath, '---\nname: exact-skill\ndescription: test fixture\n---\nUse this explicit skill.\n');
    const input = { text: '  你\r\n  ', contentParts: { version: 1 as const, parts: [
      { type: 'text' as const, text: '  你\r\n  ', elements: [{ byteRange: { start: 2, end: 5 }, placeholder: null }] },
      { type: 'skill' as const, skillId: 'exact-skill', name: 'exact-skill', path: skillPath },
    ] } };
    const encoded = await encodeCodexInput(input); expect(encoded).toEqual([
      { type: 'text', text: input.text, text_elements: input.contentParts.parts[0]!.elements },
      { type: 'skill', name: 'exact-skill', path: skillPath },
    ]);
    validateNativeParams('turn/start', { threadId: 'native', input: encoded });
    validateNativeParams('turn/steer', { threadId: 'native', expectedTurnId: 'active', input: encoded, clientUserMessageId: 'native-input-id' });
    const wav = Buffer.alloc(46); wav.write('RIFF', 0); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40);
    const path = join(dir, 'clip.wav'); await writeFile(path, wav);
    const attachment = { fileId: 'audio-file', path, name: 'clip.wav', mime: 'audio/wav', size: wav.length, sha256: createHash('sha256').update(wav).digest('hex') };
    await expect(encodeCodexInput({ text: '', contentParts: { version: 1, parts: [{ type: 'audio', ...attachment }] } })).rejects.toThrow('未声明');
    expect(await encodeCodexInput({ text: '', contentParts: { version: 1, parts: [{ type: 'audio', ...attachment }] } }, ['audio'])).toEqual([{ type: 'localAudio', path }]);
    await expect(encodeCodexInput({ text: '', contentParts: { version: 1, parts: [{ type: 'file', ...attachment }] } })).rejects.toMatchObject({ nativeAdmission: 'not-submitted' });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n1sAAAAASUVORK5CYII=', 'base64');
    const imagePath = join(dir, 'pixel.png'); await writeFile(imagePath, png);
    const image = { fileId: 'image-file', path: imagePath, name: 'pixel.png', mime: 'image/png', size: png.length, sha256: createHash('sha256').update(png).digest('hex') };
    const legacy = { text: 'legacy exact', images: [image] };
    expect(await encodeCodexInput(legacy, ['image'])).toEqual([{ type: 'localImage', path: imagePath }, { type: 'text', text: 'legacy exact', text_elements: [] }]);
    await expect(encodeCodexInput({ ...legacy, images: [{ ...image, sha256: '0'.repeat(64) }] }, ['image'])).rejects.toMatchObject({ nativeAdmission: 'not-submitted' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
