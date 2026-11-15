import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocked.query }));
import { ClaudeAdapter } from '../src/adapter.js';

afterEach(() => mocked.query.mockReset());

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'claude-admission-'));
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n1sAAAAASUVORK5CYII=', 'base64');
  const path = join(dir, 'pixel.png'); await writeFile(path, bytes);
  let close!: () => void;
  const closed = new Promise<void>(resolve => { close = resolve; });
  let input!: AsyncIterable<SDKUserMessage>;
  const q = { [Symbol.asyncIterator]() { return { async next() { await closed; return { done: true as const, value: undefined }; } }; }, close,
    supportedModels: async () => [{ value: 'native-without-modalities', displayName: 'Native model', description: 'No ModelInfo modality field' }] };
  mocked.query.mockImplementation((args: { prompt: AsyncIterable<SDKUserMessage> }) => { input = args.prompt; return q as unknown as Query; });
  const adapter = new ClaudeAdapter();
  await adapter.create({ sessionId: 'local', cwd: dir, providerId: null, model: 'native-without-modalities' });
  return { adapter, bytes, input: () => input, image: { fileId: 'image', path, mime: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, close: async () => { await adapter.dispose('local'); await rm(dir, { recursive: true, force: true }); } };
}

it('the ordinary adapter validates and sends one native image/text message with its original UUID despite absent model metadata', async () => {
  const ctx = await harness();
  try {
    expect((await ctx.adapter.listModels())[0]?.inputModalities).toBeUndefined();
    const nativeRequestId = '12345678-1234-1234-1234-123456789abc';
    const input = { text: '  原文\r\n🖼️  ', images: [ctx.image], nativeRequestId };
    await ctx.adapter.validateInput('local', input);
    await ctx.adapter.send('local', input);
    const message = await ctx.input()[Symbol.asyncIterator]().next();
    expect(message.value).toEqual({ type: 'user', parent_tool_use_id: null, uuid: nativeRequestId, message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: ctx.bytes.toString('base64') } }, { type: 'text', text: input.text }] } });
    expect(mocked.query.mock.calls.length).toBe(1);
  } finally { await ctx.close(); }
});

it('the adapter never pushes changed image bytes into the SDK prompt queue', async () => {
  const ctx = await harness();
  try {
    const input = { text: 'exact', images: [{ ...ctx.image, sha256: '0'.repeat(64) }] };
    await expect(ctx.adapter.validateInput('local', input)).rejects.toMatchObject({ nativeAdmission: 'not-submitted' });
    await expect(ctx.adapter.send('local', input)).rejects.toMatchObject({ nativeAdmission: 'not-submitted' });
    await ctx.adapter.dispose('local');
    expect((await ctx.input()[Symbol.asyncIterator]().next()).done).toBe(true);
  } finally { await ctx.close(); }
});
