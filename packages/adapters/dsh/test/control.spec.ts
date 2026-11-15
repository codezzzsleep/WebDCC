import { expect, it } from 'vitest';
import { DshAdapter } from '../src/adapter.js';
import type { DshHostClient, StreamFrame } from '../src/host.js';

it('Host-global control baselines replace omitted state and cannot overwrite a newer session snapshot', async () => {
  const replay = DshAdapter.replay('local');
  const feed = (value: unknown) => replay.feed({ i: 1, t: 0, dir: 'in', ch: 'mux:$events', frame: { value } });
  feed({ type: 'snapshot', header: { id: 'native' }, cursor: -1, records: [], hasMore: false,
    projections: { asOfSeq: 10, values: { permissions: { currentValue: 'latest' }, subagentCatalog: [{ id: 'child', mode: 'continuable' }] } } });
  let control!: (frame: StreamFrame) => void;
  const host = { connect: async () => undefined, openStream: (_endpoint: string, _args: unknown, handler: (frame: StreamFrame) => void) => { control = handler; return 'control'; }, rpc: async () => true } as unknown as DshHostClient;
  Object.assign(replay.adapter, { client: host });
  (replay.adapter as unknown as { openControl: (host: DshHostClient) => void }).openControl(host);
  control({ type: 'item', value: { type: 'baseline', value: { projections: { native: { asOfSeq: 5, values: { permissions: { currentValue: 'stale' } } } } } } });
  await expect(replay.adapter.sendSubagent('local', 'child', 'still available')).resolves.toBeUndefined();
  control({ type: 'item', value: { type: 'projection', sessionId: 'native', seq: 11, changes: [{ key: 'subagentCatalog', val: [] }] } });
  await expect(replay.adapter.sendSubagent('local', 'child', 'old')).rejects.toMatchObject({ statusCode: 409 });
});
