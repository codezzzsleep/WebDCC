import { expect, it } from 'vitest';
import type { AdapterEvent, TraceFrame } from '@webdcc/protocol';
import { DshAdapter } from '../src/adapter.js';

const nativeId = 'native-parent';
const request = (id: string, endpoint: string, args: unknown): TraceFrame => ({ i: 1, t: 0, dir: 'out', ch: `rpc:${endpoint}`, frame: {
  frame: { type: 'client-request', rpcId: id, method: endpoint, payload: { args } },
  dshTransport: { endpoint, rpcId: id, coverage: 'complete' },
} });
const response = (id: string, endpoint: string, value: unknown, ok = true, coverage = 'complete'): TraceFrame => ({ i: 2, t: 1, dir: 'in', ch: `rpc:${endpoint}`, frame: {
  frame: { type: 'server-response', rpcId: id, result: { ok, value } },
  dshTransport: { endpoint, rpcId: id, coverage },
} });
const projection: TraceFrame = { i: 3, t: 2, dir: 'in', ch: 'mux:session/control', frame: { value: {
  type: 'projection', seq: 3, changes: [{ key: 'modelSelection', val: { lastUsed: null, next: { provider: 'one', model: 'same' } } }],
} } };
const usage: TraceFrame = { i: 4, t: 3, dir: 'in', ch: 'mux:session/follow', frame: { value: { type: 'assistant-stream', frame: {
  type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 8 } },
} } } };
const replay = () => DshAdapter.replay('web', nativeId);
const catalog = { groups: [{ id: 'one', models: [{ id: 'same' }] }] };
const feed = (ctx: ReturnType<typeof replay>, frames: TraceFrame[]): AdapterEvent[] => frames.flatMap(frame => ctx.feed(frame));

it('replays recorded native model confirmations before usage without guessing an item-key offset', () => {
  const ctx = replay();
  const events = feed(ctx, [request('catalog', 'session/modelCatalog', {}), response('catalog', 'session/modelCatalog', catalog), projection,
    request('select', 'session/selectModel', { request: { sessionId: nativeId, provider: 'one', model: 'same' } }),
    response('select', 'session/selectModel', { selected: { provider: 'one', model: 'same' } }),
    { i: 5, t: 3, dir: 'in', ch: 'mux:$events', frame: { value: { type: 'event', event: { seq: 4, type: 'request/header', data: { header: { config: { provider: 'one', model: 'same' } } } } } } },
    request('read', 'session/projections', { request: { sessionId: nativeId } }),
    response('read', 'session/projections', { kind: 'sequenced', asOfSeq: 4, values: { modelSelection: { lastUsed: null, next: { provider: 'one', model: 'same' } } } }), usage]);
  expect(events.filter(event => event.type === 'item.complete' && event.kind === 'usage')).toMatchObject([{ itemKey: 'usage-4', data: { inputTokens: 3, outputTokens: 8 } }]);
  expect(events.filter(event => event.type === 'item.complete' && event.itemKey.startsWith('model-observation'))).toHaveLength(3);
});

it('does not confirm failed, incomplete, unpaired or foreign-session RPC results', () => {
  for (const mode of ['failed', 'incomplete', 'unpaired', 'foreign', 'mismatched']) {
    const ctx = replay();
    const frames = mode === 'unpaired' ? [] : [request('select', 'session/selectModel', { request: { sessionId: mode === 'foreign' ? 'another-parent' : nativeId, provider: 'one', model: 'same' } })];
    frames.push(response('select', 'session/selectModel', { selected: { provider: mode === 'mismatched' ? 'other' : 'one', model: 'same' } }, mode !== 'failed', mode === 'incomplete' ? 'truncated' : 'complete'), usage);
    const events = feed(ctx, frames);
    expect(events.filter(event => event.type === 'item.complete' && event.kind === 'usage')).toMatchObject([{ itemKey: 'usage-1' }]);
    expect(events.filter(event => event.type === 'item.complete' && event.itemKey.startsWith('model-observation'))).toEqual([]);
  }
});

it('a repeated recorded response cannot apply one native confirmation twice', () => {
  const ctx = replay();
  const reply = response('select', 'session/selectModel', { selected: { provider: 'one', model: 'same' } });
  const events = feed(ctx, [request('select', 'session/selectModel', { request: { sessionId: nativeId, provider: 'one', model: 'same' } }), reply, reply, usage]);
  expect(events.filter(event => event.type === 'item.complete' && event.kind === 'usage')).toMatchObject([{ itemKey: 'usage-2' }]);
});
