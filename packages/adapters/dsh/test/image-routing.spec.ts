import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DshAdapter } from '../src/adapter.js';
import type { DshHostClient } from '../src/host.js';

function fixture(options: { cached?: boolean; stale?: boolean; changed?: boolean; missing?: boolean; plain?: boolean } = {}) {
  const { adapter } = DshAdapter.replay('web', 'native');
  let reads = 0;
  const prompts: unknown[] = [];
  const rpc = async (endpoint: string, args: unknown) => {
    if (endpoint === 'session/projections') {
      reads++;
      return { kind: options.cached ? 'cached' : 'sequenced', asOfSeq: options.stale ? -1 : reads,
        values: { modelSelection: options.missing ? { next: null, lastUsed: null } : {
          lastUsed: { provider: 'plain', model: 'same' }, next: { provider: options.plain || options.changed && reads > 1 ? 'plain' : 'vision', model: 'same' },
        } } };
    }
    if (endpoint === 'session/modelCatalog') return { default: { provider: 'plain', model: 'same' }, groups: [
      { id: 'plain', models: [{ id: 'same', inputModalities: ['text'] }] },
      { id: 'vision', models: [{ id: 'same', inputModalities: ['text', 'image'] }] },
    ] };
    if (endpoint === 'session/prompt') { prompts.push(args); return { accepted: true }; }
    return {};
  };
  Object.assign(adapter, { client: { rpc, connect: async () => undefined, isConnected: true } as unknown as DshHostClient });
  vi.spyOn(adapter, 'hostIdentity').mockResolvedValue({ status: 'verified', version: '0.2.2-rc.1', source: 'native-bootstrap', fingerprint: 'fixture-host', url: 'http://fixture.invalid/' });
  return { adapter, prompts };
}

it('admits next model image bytes on the exact Provider even when lastUsed and default are text-only namesakes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-image-route-'));
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
  const path = join(directory, 'pixel.png'); await writeFile(path, bytes);
  try {
    const ctx = fixture();
    const input = { text: 'Describe the image', images: [{ fileId: 'pixel', path, mime: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex') }] };
    await ctx.adapter.validateInput('web', input);
    await ctx.adapter.send('web', input);
    expect(ctx.prompts).toMatchObject([{ request: { sessionId: 'native', content: [{ type: 'text', text: input.text }, { type: 'image', mediaType: 'image/png', data: bytes.toString('base64') }] } }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('rejects cached, stale, missing, text-only or changed native routes before sending a model prompt', async () => {
  for (const options of [{ cached: true }, { stale: true }, { missing: true }, { plain: true }, { changed: true }]) {
    const ctx = fixture(options);
    const input = { text: 'Preserve this draft', images: [{ fileId: 'pixel', path: '/not-read-before-admission', mime: 'image/png' }] };
    await expect(ctx.adapter.validateInput('web', input)).rejects.toMatchObject({ code: 'dsh-input-unsupported', nativeAdmission: 'not-submitted' });
    expect(ctx.prompts).toEqual([]);
    expect(input.text).toBe('Preserve this draft'); expect(input.images).toHaveLength(1);
  }
});
