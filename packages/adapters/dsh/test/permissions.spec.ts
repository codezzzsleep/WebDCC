import { afterEach, expect, it, vi } from 'vitest';
import { DshAdapter } from '../src/adapter.js';
import { DshHostClient } from '../src/host.js';

afterEach(() => vi.unstubAllGlobals());
it('NP-07 uses the native permission catalog and treats command business failures as failures', async () => {
  const replay = DshAdapter.replay('local');
  const host = new DshHostClient('https://host.test/dsh/');
  host.connect = async () => undefined;
  Object.assign(replay.adapter, { client: host });
  let fail = true;
  const requests: { endpoint: string; args: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { rpcId: string; method: string; payload: { args: Record<string, unknown> } };
    requests.push({ endpoint: request.method, args: request.payload.args });
    const catalog = { options: [{ value: 'custom-safe', name: 'custom label' }], defaultOptions: [{ value: 'custom-safe', name: 'custom label' }], defaultPreset: 'custom-safe' };
    const value = request.method === 'permissionPresets/catalog' ? catalog : { commandId: 'command', result: { kind: fail ? 'error' : 'success', text: 'native policy message' } };
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }));
  });
  expect(await replay.adapter.listAccessModes()).toEqual([{ id: 'custom-safe', label: 'custom label', allowed: true, implemented: true, reason: undefined, source: 'permissionPresets/catalog', scope: 'session' }]);
  await expect(replay.adapter.setAccessMode('local', 'custom-safe')).rejects.toMatchObject({ statusCode: 409 });
  fail = false;
  await replay.adapter.setAccessMode('local', 'inherit');
  expect(requests.at(-1)).toMatchObject({ endpoint: 'commands/execute', args: { line: '/permission custom-safe', submittedAttachments: [] } });
  await expect(replay.adapter.setAccessMode('local', 'danger-full-access')).rejects.toMatchObject({ statusCode: 400 });
});

it('NP-07 projection stream readiness retains the global interaction client identity', async () => {
  const replay = DshAdapter.replay('local');
  const feed = (value: unknown) => replay.feed({ i: 1, t: 0, dir: 'in', ch: 'mux:$events', frame: { value } });
  feed({ type: 'ready', clientId: 'global-client' });
  feed({ type: 'ready' });
  expect(feed({ type: 'projection', seq: 5, changes: [{ key: 'permissions', val: { currentValue: 'custom' } }] })).toContainEqual({ type: 'permissions', observation: { effective: 'custom', source: 'session/observeProjections', scope: 'session', nativeSeq: 5 } });
  feed({ type: 'waterfall', event: 'user-questions/request', eventId: 'question', request: { questions: [{ id: 'one', question: 'answer' }] } });
  await replay.adapter.answer('local', 'question:one', 'text');
  expect(replay.replies.at(-1)).toMatchObject({ args: { clientId: 'global-client' } });
});
