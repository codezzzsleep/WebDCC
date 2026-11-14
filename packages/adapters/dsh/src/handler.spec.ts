import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { DshAdapter } from './adapter.js';
import type { UserInput } from '@webdcc/protocol';
function imageClient(dispatch: (endpoint: string, args: unknown) => unknown) {
  return { connect: async () => undefined, rpc: async (endpoint: string, args: unknown) => {
    if (endpoint === 'session/projections') return { asOfSeq: 0, values: { modelSelection: { provider: 'fixture', model: 'vision' } } };
    if (endpoint === 'session/modelCatalog') return { groups: [{ id: 'fixture', models: [{ id: 'vision' }] }] };
    if (endpoint === 'llm/listConfigurableProviders') return [{ provider: 'fixture', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'fixture'], declared: true }];
    if (endpoint === 'settings/describe') return { namespaces: [{ ns: 'llm-pi-ai', revision: 1, value: { providers: { fixture: { models: [{ id: 'vision', input: ['text', 'image'] }], modelOverrides: {}, defaultInput: ['text'] } } } }] };
    return dispatch(endpoint, args);
  } };
}
it('image prompts carry exact bytes in the native mediaType/data wire contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-dsh-input-'));
  try {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); await writeFile(join(root, 'a.png'), bytes);
    const replay = DshAdapter.replay('s'); let request: unknown;
    Object.assign(replay.adapter, { client: imageClient((_endpoint, args) => { request = args; return { accepted: true }; }) });
    await replay.adapter.send('s', { text: 'describe', images: [{ fileId: 'file1', path: join(root, 'a.png'), mime: 'image/png' }] });
    expect(request).toMatchObject({ request: { content: [{ type: 'text', text: 'describe' }, { type: 'image', mediaType: 'image/png', data: bytes.toString('base64') }] } });
    expect(JSON.stringify(request)).not.toContain('a.png');
    await expect(replay.adapter.send('s', { text: 'invalid', images: [{ fileId: 'file2', path: 'absent', mime: 'image/svg+xml' }] })).rejects.toThrow('DSH 不支持图片格式');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('concurrent model discovery shares an owned pending boot', async () => {
  const adapter = new DshAdapter(); let finish!: () => void;
  const booting = new Promise<void>(resolve => { finish = () => { Object.assign(adapter, { client: { rpc: async () => ({ models: [{ id: 'model' }] }) } }); resolve(); }; });
  Object.assign(adapter, { booting });
  const first = adapter.listModels(); const second = adapter.listModels(); finish();
  expect(await first).toEqual([{ id: 'model', label: 'model' }]); expect(await second).toEqual(await first);
});
it('slash command submissions preserve the complete original text and accompanying image bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-dsh-command-'));
  try {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); await writeFile(join(root, 'a.png'), bytes);
    const replay = DshAdapter.replay('s'); let request: unknown;
    Object.assign(replay.adapter, { client: { connect: async () => undefined, rpc: async (_endpoint: string, args: unknown) => { request = args; return { commandId: 'command', result: { kind: 'success' } }; } } });
    await replay.adapter.send('s', { text: '/command exact  \r\nbody remains ', images: [{ fileId: 'f', path: join(root, 'a.png'), mime: 'image/png' }] });
    expect(request).toMatchObject({ line: '/command exact  \r\nbody remains ', submittedAttachments: [{ type: 'image', mediaType: 'image/png', data: bytes.toString('base64') }] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('a reconnect during file preparation cannot submit a receipt from the previous Host generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-dsh-receipt-'));
  try {
    const bytes = Buffer.from('file bytes'); const path = join(root, 'proof.bin'); await writeFile(path, bytes);
    const replay = DshAdapter.replay('s'); let prompts = 0;
    const harness = replay.adapter as unknown as { muxGeneration: number };
    Object.assign(replay.adapter, { hostIdentity: async () => ({ status: 'verified', fingerprint: 'fixture-bootstrap' }), client: {
      connect: async () => undefined,
      rpc: async () => { prompts++; return { accepted: true }; },
      uploadFileBinary: async () => { harness.muxGeneration++; return { receiptId: 'previous-host-receipt', file: { attachmentId: 'fixture-id', name: 'proof.bin', bytes: bytes.length } }; },
    } });
    await expect(replay.adapter.send('s', { text: 'original', contentParts: { version: 1, parts: [
      { type: 'text', text: 'original' }, { type: 'file', fileId: 'file-1', path, mime: 'application/octet-stream' },
    ] } } as UserInput)).rejects.toMatchObject({ code: 'uncertain' });
    expect(prompts).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('native question controls preserve every question ID in one waterfall response', async () => {
  const replay = DshAdapter.replay('s');
  replay.feed({ i: 0, t: 0, dir: 'in', ch: 'mux:$events', frame: { value: { type: 'ready', clientId: 'client' } } });
  const events = replay.feed({ i: 1, t: 0, dir: 'in', ch: 'mux:$events', frame: { value: { type: 'waterfall', event: 'user-questions/request', eventId: 'event1', request: { questions: [{ id: 'language', question: '语言' }, { id: 'version', question: '版本' }] } } } });
  expect(events.filter(event => event.type === 'item.complete' && event.kind === 'question')).toHaveLength(2);
  await replay.adapter.answer('s', 'event1:language', { selected: ['中文'] }); expect(replay.replies).toHaveLength(0);
  await replay.adapter.answer('s', 'event1:version', { selected: ['新版'] });
  expect(replay.replies).toEqual([{ endpoint: '$events/result', args: { clientId: 'client', eventId: 'event1', outcome: { kind: 'result', value: { answers: [{ id: 'language', selected: ['中文'] }, { id: 'version', selected: ['新版'] }] } } } }]);
});
