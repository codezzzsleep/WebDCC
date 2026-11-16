import { expect, it } from 'vitest';
import type { AdapterEvent } from '@webdcc/protocol';
import { DshAdapter } from '../src/adapter.js';
import type { DshHostClient, StreamFrame } from '../src/host.js';

it('Host-global control baselines replace omitted state and cannot overwrite a newer session snapshot', async () => {
  const replay = DshAdapter.replay('local');
  const feed = (value: unknown) => replay.feed({ i: 1, t: 0, dir: 'in', ch: 'mux:$events', frame: { value } });
  feed({ type: 'snapshot', header: { id: 'native' }, cursor: -1, records: [], hasMore: false,
    projections: { asOfSeq: 10, values: { permissions: { currentValue: 'latest' }, subagentCatalog: [{ id: 'child', mode: 'continuable' }] } } });
  let control!: (frame: StreamFrame) => void;
  let children = [{ id: 'child', mode: 'continuable', label: 'child', createdAt: 1000 }];
  const host = { connect: async () => undefined, openStream: (_endpoint: string, _args: unknown, handler: (frame: StreamFrame) => void) => { control = handler; return 'control'; },
    rpc: async (endpoint: string) => {
      if (endpoint === 'session/projections') return { kind: 'sequenced', asOfSeq: children.length ? 10 : 11, values: { permissions: { currentValue: 'latest' }, subagentCatalog: children } };
      if (endpoint === 'session/state') return { cursor: -1, active: false, running: false, pendingInput: [], queue: null };
      if (endpoint === 'subagents/prompt') return { messageId: 'native-child-input' };
      throw new Error(`unexpected native RPC ${endpoint}`);
    } } as unknown as DshHostClient;
  Object.assign(replay.adapter, { client: host });
  replay.adapter.hostIdentity = async () => ({ url: 'http://127.0.0.1/', source: 'native-bootstrap', status: 'verified', version: '0.2.2-rc.1',
    fingerprint: 'f'.repeat(64), profile: { scope: 'current-host-profile', identity: 'unavailable-in-api' } });
  const events: AdapterEvent[] = [];
  replay.adapter.onEvent((_id, event) => events.push(event));
  (replay.adapter as unknown as { openControl: (host: DshHostClient) => void }).openControl(host);
  control({ type: 'item', value: { type: 'baseline', value: { projections: { native: { asOfSeq: 5, values: { permissions: { currentValue: 'stale' } } } } } } });
  expect(events.filter(event => event.type === 'permissions')).toEqual([]);
  await expect(replay.adapter.sendSubagent('local', 'child', 'still available')).resolves.toMatchObject({ accepted: true, messageId: 'native-child-input' });
  children = [];
  control({ type: 'item', value: { type: 'projection', sessionId: 'native', seq: 11, changes: [{ key: 'subagentCatalog', val: [] }] } });
  await expect(replay.adapter.sendSubagent('local', 'child', 'old')).rejects.toMatchObject({ statusCode: 409 });
});
