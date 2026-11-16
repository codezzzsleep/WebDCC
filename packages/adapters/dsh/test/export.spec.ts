import { afterEach, expect, it, vi } from 'vitest';
import { DshAdapter } from '../src/adapter.js';
import { DshHostClient } from '../src/host.js';

afterEach(() => vi.unstubAllGlobals());
it('only a successful native /export acknowledges a download for the exact native session', async () => {
  const replay = DshAdapter.replay('web-session', 'native-session');
  const host = new DshHostClient('https://host.test/dsh/'); host.connect = async () => undefined;
  Object.assign(replay.adapter, { client: host });
  let failed = false;
  const requests: unknown[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    if (request.method === 'commands/list') return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value:
      [{ name: 'export', definitionId: '@deepseek-ai/dsh-session-log-export', description: 'native export' }],
    } }));
    requests.push(request.payload.args);
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: {
      commandId: 'native-export-command', result: { kind: failed ? 'error' : 'success', text: 'native command result' },
    } } }));
  });
  expect(await replay.adapter.executeSlashControl('web-session', '/export')).toMatchObject({
    confirmed: true, form: 'dsh-export', download: { kind: 'dsh-session-log', nativeId: 'native-session' },
    result: { commandId: 'native-export-command', result: { kind: 'success' } },
  });
  expect(requests).toEqual([{ agentId: 'native-session', line: '/export', submittedAttachments: [] }]);
  failed = true;
  expect(await replay.adapter.executeSlashControl('web-session', '/export unexpected')).toMatchObject({ failed: true });
  expect((await replay.adapter.executeSlashControl('web-session', '/export')).download).toBeUndefined();
  failed = false;
  expect((await replay.adapter.executeSlashControl('web-session', '/help')).download).toBeUndefined();
});
