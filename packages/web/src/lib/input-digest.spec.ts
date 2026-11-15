import { createHash, randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { attachmentDigest, sha256Bytes, uploadTaskId } from './input-digest.js';
afterEach(() => vi.unstubAllGlobals());
it('SHA-256 matches standard vectors and padding boundaries for exact bytes', () => {
  for (const input of ['', 'abc', '中文\r\n\0text']) {
    const bytes = Buffer.from(input); expect(sha256Bytes(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  }
  for (const size of [55,56,63,64,65,127,128,1025]) {
    const bytes = randomBytes(size); expect(sha256Bytes(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  }
});
it('ordinary HTTP contexts retain real digest and UUID generation without SubtleCrypto', async () => {
  const original = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: original.getRandomValues.bind(original) });
  const blob = new Blob(['  exact\r\nbytes  ']);
  expect(await attachmentDigest(blob)).toBe(createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex'));
  expect(uploadTaskId()).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
