import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { DshAdapter } from './adapter.js';
it('image prompts carry exact bytes in the native mediaType/data wire contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-dsh-input-'));
  try {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); await writeFile(join(root, 'a.png'), bytes);
    const replay = DshAdapter.replay('s'); let request: unknown;
    Object.assign(replay.adapter, { client: { connect: async () => undefined, rpc: async (_endpoint: string, args: unknown) => { request = args; return { accepted: true }; } } });
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
it('native question controls preserve every question ID in one waterfall response', async () => {
  const replay = DshAdapter.replay('s');
  replay.feed({ i: 0, t: 0, dir: 'in', ch: 'mux:$events', frame: { value: { type: 'ready', clientId: 'client' } } });
  const events = replay.feed({ i: 1, t: 0, dir: 'in', ch: 'mux:$events', frame: { value: { type: 'waterfall', event: 'user-questions/request', eventId: 'event1', request: { questions: [{ id: 'language', question: '语言' }, { id: 'version', question: '版本' }] } } } });
  expect(events.filter(event => event.type === 'item.complete' && event.kind === 'question')).toHaveLength(2);
  await replay.adapter.answer('s', 'event1:language', { selected: ['中文'] }); expect(replay.replies).toHaveLength(0);
  await replay.adapter.answer('s', 'event1:version', { selected: ['新版'] });
  expect(replay.replies).toEqual([{ endpoint: '$events/result', args: { clientId: 'client', eventId: 'event1', outcome: { kind: 'result', value: { answers: [{ id: 'language', selected: ['中文'] }, { id: 'version', selected: ['新版'] }] } } } }]);
});
