import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTestApp } from './helpers.js';

it('NP-12 a rejected remote Host settings write never changes the local DSH home patch', async () => {
  const ctx = await createTestApp();
  const home = join(ctx.dataDir, 'local-dsh');
  await mkdir(home);
  const file = join(home, 'cordis.patch.yml');
  const original = `- id: llm-pi-ai
  patch:
    providers:
      target:
        baseURL: https://old.example/v1
        models:
          - id: a
            reasoning: high
          - id: b
- id: agent-default-model
  patch:
    provider: target
    model: a
`;
  await writeFile(file, original);
  vi.stubEnv('DSH_HOME', home);
  await ctx.dsh.save({ url: 'http://remote.example', cookie: 'test-remote-cookie', connectedAt: new Date().toISOString() });
  const methods: string[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { rpcId: string; method: string };
    methods.push(request.method);
    const value = { writable: true, namespaces: [{ ns: 'llm-pi-ai', revision: 1, value: { providers: { target: { baseURL: 'https://old.example/v1', models: [{ id: 'a' }, { id: 'b' }] } } } }, { ns: 'agent-default-model', revision: 1, value: { provider: 'target', model: 'a' } }] };
    const described = { ...value, hasDocument: true, namespaces: value.namespaces.map(namespace => ({ ...namespace, autoGenerate: true, schema: {}, applies: 'live', secrets: [] })) };
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: request.method === 'settings/update' ? { ok: false, error: { code: 'home-patch-override', message: 'Setting is overridden by a home patch' } } : { ok: true, value: described } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const response = await ctx.app.inject({ method: 'PATCH', url: '/api/dsh/provider', headers: { cookie: ctx.cookie }, payload: { providerKey: 'target', baseURL: 'https://new.example/v1', model: 'b' } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(methods).toEqual(['settings/describe', 'settings/update']);
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await ctx.close(); }
});
