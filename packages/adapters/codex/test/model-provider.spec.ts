import { afterEach, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../src/adapter.js';
import { JsonRpcStdio } from '../src/rpc.js';

afterEach(() => vi.restoreAllMocks());
it('native model discovery uses the selected Provider endpoint, key and catalog path and closes its observer', async () => {
  const request = vi.fn(async (method: string) => method === 'initialize'
    ? { userAgent: 'fixture', codexHome: '/tmp/catalog', platformFamily: 'unix', platformOs: 'linux' }
    : { data: [], nextCursor: null });
  const kill = vi.fn(async () => undefined);
  const start = vi.spyOn(JsonRpcStdio, 'start').mockReturnValue({ request, notify: vi.fn(), kill, nativeVersion: '0.172.0' } as unknown as JsonRpcStdio);
  const adapter = new CodexAdapter({ env: { PATH: '/fixture/path' } });
  vi.spyOn(adapter, 'probe').mockResolvedValue({ installed: true, version: '0.172.0', pinnedVersion: '0.167.0', compatible: true, auth: 'unknown' });
  const provider = { id: 'selected', name: 'Selected', baseUrl: 'https://fallback.invalid',
    endpoints: { 'openai-responses': 'https://selected.invalid/v1' }, protocols: ['openai-responses'],
    apiKey: 'fixture-key', codexCatalogPath: '/tmp/selected catalog.json' };
  await expect(adapter.listModels(provider.id, provider)).resolves.toEqual([]);
  const opts = start.mock.calls[0]![0];
  expect(opts.args).toContain('model_provider="wdcc_selected"');
  expect(opts.args).toContain('model_providers.wdcc_selected.base_url="https://selected.invalid/v1"');
  expect(opts.args).toContain('model_catalog_json="/tmp/selected catalog.json"');
  expect(opts.env).toMatchObject({ PATH: '/fixture/path', WDCC_PROVIDER_KEY: 'fixture-key' });
  expect(request.mock.calls.map(([method]) => method)).toEqual(['initialize','model/list']);
  expect(kill).toHaveBeenCalledOnce();
  await expect(adapter.listModels('another', provider)).rejects.toThrow('Provider');
  await expect(adapter.listModels('selected')).rejects.toThrow('Provider');
  expect(start).toHaveBeenCalledOnce();
});
