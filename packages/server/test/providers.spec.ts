import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;

beforeAll(async () => { ctx = await createTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('Provider → Model 三级数据', () => {
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
    expect(modelList.json()).toEqual({ models: ['model-b', 'model-c'] });
  });
});
