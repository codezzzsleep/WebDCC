import { afterEach, expect, it, vi } from 'vitest';
import { DshAdapter } from '../src/adapter.js';
import { DshHostClient } from '../src/host.js';

afterEach(() => vi.unstubAllGlobals());
it.each([
  { line: '/export', name: 'export', definitionId: '@deepseek-ai/dsh-session-log-export', download: true },
  { line: '/导出', name: 'renamed-export', definitionId: '@deepseek-ai/dsh-session-log-export', download: true },
  { line: '/renamed-export\r\n', name: 'renamed-export', definitionId: '@deepseek-ai/dsh-session-log-export', download: true },
  { line: '/export', name: 'export', definitionId: 'custom/export', download: false },
])('export download follows native definition identity: $line / $definitionId', async ({ line, name, definitionId, download }) => {
  const replay = DshAdapter.replay('web-session', 'native-session');
  const host = new DshHostClient('https://host.test/dsh/'); host.connect = async () => undefined;
  Object.assign(replay.adapter, { client: host });
  const executions: unknown[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    const catalog = [{ name, definitionId, description: 'controlled scoped command' },
      ...(definitionId.startsWith('custom/') ? [{ name: 'builtin-export', definitionId: '@deepseek-ai/dsh-session-log-export', description: 'builtin' }] : [])];
    if (request.method === 'commands/execute') executions.push(request.payload.args);
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value:
      request.method === 'commands/list' ? catalog : { commandId: 'native-command', result: { kind: 'success', text: 'native result' } },
    } }));
  });
  const result = await replay.adapter.executeSlashControl('web-session', line);
  expect(result.download !== undefined).toBe(download);
  expect(executions).toEqual([{ agentId: 'native-session', line, submittedAttachments: [] }]);
});
