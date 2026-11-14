import { expect, it } from 'vitest';
import { dshInputCapabilities, dshInputRoute, type DshInputQuery } from '../src/input-capabilities.js';

function query(profile: unknown, declared = false) {
  const calls: string[] = [];
  const rpc: DshInputQuery = async <T>(endpoint: string): Promise<T> => {
    calls.push(endpoint);
    const values: Record<string, unknown> = {
      'settings/describe': { namespaces: [{ ns: 'llm-pi-ai', revision: 1, value: { providers: { route: profile } }, secrets: [] }] },
      'llm/listConfigurableProviders': [{ provider: 'route', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'route'], declared }],
      'llm/discoverModels': [{ id: 'vision', inputModalities: ['text', 'image'] }, { id: 'plain', inputModalities: ['text'] }],
    };
    return values[endpoint] as T;
  };
  return { rpc, calls };
}
const catalog = { groups: [{ id: 'route', models: [{ id: 'vision' }, { id: 'plain' }, { id: 'custom' }] }] };

it('current resolved profile overrides installed candidate modalities, and preserves installed precedence over route fallback', async () => {
  const { rpc } = query({ models: [], modelOverrides: { vision: { input: ['text'] } }, defaultInput: ['image'] });
  const capabilities = await dshInputCapabilities(catalog, rpc);
  expect(capabilities.get(dshInputRoute('route', 'vision'))).toMatchObject({ inputModalities: ['text'], source: 'settings/describe:resolved-model-input' });
  expect(capabilities.get(dshInputRoute('route', 'plain'))?.inputModalities).toEqual(['text']);
  expect(capabilities.get(dshInputRoute('route', 'custom'))?.inputModalities).toEqual(['image']);
});
it('hand-declared routes use resolved model/default input and never interrogate their remote endpoints', async () => {
  const { rpc, calls } = query({ models: [{ id: 'vision', input: ['text', 'image'] }, { id: 'plain', input: [] }, { id: 'custom' }], defaultInput: ['text'], modelOverrides: {} }, true);
  const capabilities = await dshInputCapabilities(catalog, rpc);
  expect(capabilities.get(dshInputRoute('route', 'vision'))?.inputModalities).toEqual(['text', 'image']);
  expect(capabilities.get(dshInputRoute('route', 'custom'))?.inputModalities).toEqual(['text']);
  expect(calls).not.toContain('llm/discoverModels');
});
it('absent or redacted configuration does not fabricate vision capability', async () => {
  const { rpc } = query({ defaultInput: ['image'] });
  const capabilities = await dshInputCapabilities(catalog, rpc);
  expect([...capabilities.values()].every(capability => capability.inputModalities === undefined)).toBe(true);
  const unknown: DshInputQuery = async () => { throw new Error('Host unavailable'); };
  expect([...(await dshInputCapabilities(catalog, unknown)).values()].every(capability => capability.inputModalities === undefined)).toBe(true);
});
it('a failed installed catalog read does not justify route fallback for an unknown shipped model', async () => {
  const { rpc } = query({ models: [], modelOverrides: {}, defaultInput: ['image'] });
  const failed: DshInputQuery = async <T>(endpoint: string, args?: Record<string, unknown>) => {
    if (endpoint === 'llm/discoverModels') throw new Error('installed catalog unavailable');
    return rpc<T>(endpoint, args);
  };
  const capabilities = await dshInputCapabilities(catalog, failed);
  expect(capabilities.get(dshInputRoute('route', 'vision'))?.inputModalities).toBeUndefined();
});
