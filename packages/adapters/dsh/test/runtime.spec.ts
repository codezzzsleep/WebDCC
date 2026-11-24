import { afterEach, expect, it, vi } from 'vitest';
import { DshHostClient } from '../src/host.js';
import { DshAdapter } from '../src/adapter.js';
import { identityFromDshBootstrap, verifiedDshHostClient } from '../src/identity.js';
import { validateDshArgs } from '../src/contracts.js';
import { dshRuntimeContract } from '../src/runtime.js';
import { dshNativeActionMetadata, parseDshNativeAction } from '../src/native.js';

afterEach(() => vi.unstubAllGlobals());
const boot = (version: string) => `<script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: 'native-fixture', release: { version }, entries: [] })}</script>`;
const command = { agentId: 'native', line: '/help', submittedAttachments: [] };

it('selects the actual authenticated Host contract, even when the local baseline is older', async () => {
  const sent: unknown[] = [];
  vi.stubGlobal('fetch', async (_url: string | URL, init: RequestInit) => {
    if (init.method !== 'POST') return new Response(boot('0.2.2-rc.5'));
    const envelope = JSON.parse(String(init.body)); sent.push(envelope);
    return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: 'exact native receipt' } });
  });
  const { client, identity } = await verifiedDshHostClient('http://native.test/', { cookie: 'native fixture' });
  expect(client.nativeVersion).toBe('0.2.2-rc.5');
  expect(identity.contract?.cardIdentity).toBe('callId');
  expect(identity.contract?.pluginEvents).toBe('sse');
  expect(await client.rpc('commands/execute', command)).toBe('exact native receipt');
  expect(sent).toEqual([expect.objectContaining({ method: 'commands/execute', payload: { args: command } })]);
  expect(() => validateDshArgs('web/listProviders', {}, client.nativeVersion)).not.toThrow();
  expect(() => validateDshArgs('web/listProviders', {}, '0.2.2-rc.1')).toThrow('absent');
});

it('uses the published card identity and optional payload without translating stale identities', () => {
  const alpha = { type: 'card-dismiss', revision: 'state', cardId: 'card-1' };
  expect(parseDshNativeAction(alpha, '0.2.3-alpha.2')).toEqual(alpha);
  expect(() => parseDshNativeAction(alpha, '0.2.2-rc.5')).toThrow('身份');
  expect(() => parseDshNativeAction({ type: 'card-dismiss', revision: 'state', callId: 'old-call' }, '0.2.3-alpha.2')).toThrow('身份');
  expect(() => validateDshArgs('actionCards/act', { agentId: 'native', cardId: 'card-1', verb: 'dismiss' }, '0.2.3-alpha.2')).not.toThrow();
  expect(dshNativeActionMetadata(true, {}, '0.2.3-alpha.2').find(action => action.type === 'card-dismiss')?.schema).toMatchObject({ required: ['cardId'], properties: { cardId: { entitySource: 'projections.actionCards' } } });
  expect(dshRuntimeContract('0.2.3-alpha.2')).toMatchObject({ experimental: true, pluginEvents: 'mux', systemMessages: 'sections' });
});

it('refuses unknown versions and the wrong transport before dispatch', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(identityFromDshBootstrap('http://native.test/', boot('0.2.2-rc.4')).status).toBe('incompatible');
  expect(() => new DshHostClient('http://native.test/', { nativeVersion: '0.2.2-rc.4' })).toThrow('合同');
  const client = new DshHostClient('http://native.test/', { nativeVersion: '0.2.3-alpha.2' });
  await expect(client.rpc('pluginEvents/follow', {})).rejects.toThrow('openStream');
  expect(() => client.openStream('commands/execute', command, () => undefined)).toThrow('rpc');
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps the version bound while an actual RPC receipt is in flight', async () => {
  let release!: (value: Response) => void; let envelope: { rpcId: string };
  vi.stubGlobal('fetch', (_url: string | URL, init: RequestInit) => {
    envelope = JSON.parse(String(init.body));
    return new Promise<Response>(resolve => { release = resolve; });
  });
  const client = new DshHostClient('http://native.test/', { nativeVersion: '0.2.2-rc.5' });
  const receipt = client.rpc('commands/execute', command);
  expect(() => client.bindNativeVersion('0.2.3-alpha.2')).toThrow('重新连接');
  release(Response.json({ type: 'server-response', rpcId: envelope!.rpcId, result: { ok: true, value: 'original receipt' } }));
  expect(await receipt).toBe('original receipt');
  expect(client.nativeVersion).toBe('0.2.2-rc.5');
  client.bindNativeVersion('0.2.3-alpha.2'); expect(client.nativeVersion).toBe('0.2.3-alpha.2');
});

it('preserves a native agent-message as delegated context and keeps human messages distinct', () => {
  const replay = DshAdapter.replay('public', 'native', '0.2.3-alpha.2');
  const source = { kind: 'agent-message', agentId: 'parent', form: 'relay' };
  const frame = { type: 'item', value: { type: 'event', event: { seq: 1, time: 1000, type: 'user/message', data: { source, content: [{ type: 'text', text: 'exact delegation  \n' }] } } } };
  const events = replay.feed({ i: 1, t: 1, dir: 'in', ch: 'mux:session/events', frame });
  expect(events).toContainEqual(expect.objectContaining({ type: 'item.complete', kind: 'internal', data: { nativeType: 'user/message:agent-message', dshContext: { text: 'exact delegation  \n', source } } }));
  expect(events.some(event => event.type === 'item.complete' && event.kind === 'user.message')).toBe(false);
  expect(frame.value.event.data.source).toEqual(source);
});
