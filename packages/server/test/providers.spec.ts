import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;

beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('Provider → Model 三级数据', () => {
  it('merges simultaneous edits to different protocol endpoints against stored configuration', async () => {
    const baseUrl = 'https://fallback.invalid';
    const headers = { cookie: ctx.cookie };
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/providers', headers,
      payload: { name: 'Endpoint edits', baseUrl, protocols: ['openai-responses', 'anthropic-messages'], models: ['example'] },
    });
    const { id } = created.json<{ id: string }>();
    const edit = (payload: object) => ctx.app.inject({ method: 'PATCH', url: `/api/providers/${id}`, headers, payload });
    const endpoints = {
      'openai-responses': 'https://responses.invalid/v1',
      'anthropic-messages': 'https://messages.invalid',
    };
    const responses = await Promise.all(Object.entries(endpoints).map(([protocol, url]) => edit({ endpoint: { protocol, url } })));
    expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
    expect(ctx.manager.optionsProvider(id)).toMatchObject({ baseUrl, endpoints });

    expect((await edit({ endpoint: { protocol: 'unsupported', url: baseUrl } })).statusCode).toBe(400);
    expect((await edit({ endpoint: { protocol: 'openai-responses', url: baseUrl }, endpoints: {} })).statusCode).toBe(400);
    expect(ctx.manager.optionsProvider(id)).toMatchObject({ baseUrl, endpoints });

    expect((await edit({ endpoints: {} })).statusCode).toBe(200);
    expect(ctx.manager.optionsProvider(id)?.endpoints).toEqual({});
    expect(ctx.manager.optionsProvider(id)?.baseUrl).toBe(baseUrl);
  });

  it('模型目录按Provider保留声明档位，不借用同名模型或不兼容Provider的能力', async () => {
    const create = (name: string, reasoningEfforts?: string[]) => ctx.app.inject({ method: 'POST', url: '/api/providers', headers: { cookie: ctx.cookie }, payload: {
      name, baseUrl: 'https://fixture.invalid', protocols: ['openai-responses'], models: ['same', 'undeclared'],
      modelDetails: [{ id: 'same', name, ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }) }],
    } });
    const one = (await create('One', ['ultra', 'high'])).json<{ id: string }>();
    const two = (await create('Two', ['low'])).json<{ id: string }>();
    const read = (agent: string, id: string) => ctx.app.inject({ method: 'GET', url: `/api/models?agent=${agent}&providerId=${id}`, headers: { cookie: ctx.cookie } });
    expect((await read('codex', one.id)).json()).toEqual({ models: ['same', 'undeclared'], options: [
      { id: 'same', label: 'One', reasoningEfforts: ['ultra', 'high'], source: 'provider-config' },
      { id: 'undeclared', label: 'undeclared', source: 'provider-config' },
    ] });
    expect((await read('codex', two.id)).json<{ options: unknown[] }>().options[0]).toEqual({ id: 'same', label: 'Two', reasoningEfforts: ['low'], source: 'provider-config' });
    expect((await read('claude-code', one.id)).json()).toEqual({ models: [], options: [] });
  });

  it('Provider 保留模型 ID 列表，并保存模型展示信息', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: { cookie: ctx.cookie },
      payload: {
        name: '层级测试 Provider',
        baseUrl: 'https://provider.example/v1',
        protocols: ['openai-responses'],
        models: ['model-a', 'model-b'],
        modelDetails: [
          { id: 'model-a', name: '模型 A', reasoningEfforts: ['low', 'high'] },
          { id: 'model-b', name: '模型 B' },
        ],
      },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { id: string; models: string[]; modelDetails?: { id: string; name: string }[] };
    expect(body.models).toEqual(['model-a', 'model-b']);
    expect(body.modelDetails).toEqual([
      { id: 'model-a', name: '模型 A', reasoningEfforts: ['low', 'high'] },
      { id: 'model-b', name: '模型 B' },
    ]);

    const updated = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/providers/' + body.id,
      headers: { cookie: ctx.cookie },
      payload: { models: ['model-b', 'model-c'], modelDetails: [{ id: 'model-b', name: '模型 B' }, { id: 'model-c', name: '模型 C' }] },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { models: string[] }).models).toEqual(['model-b', 'model-c']);
    expect((updated.json() as { modelDetails?: { id: string; name: string }[] }).modelDetails?.[1]?.name).toBe('模型 C');

    const modelList = await ctx.app.inject({ method: 'GET', url: '/api/models?agent=codex&providerId=' + body.id, headers: { cookie: ctx.cookie } });
    expect(modelList.statusCode).toBe(200);
    expect(modelList.json()).toEqual({ models: ['model-b', 'model-c'], options: [
      { id: 'model-b', label: '模型 B', source: 'provider-config' },
      { id: 'model-c', label: '模型 C', source: 'provider-config' },
    ] });
  });
});
