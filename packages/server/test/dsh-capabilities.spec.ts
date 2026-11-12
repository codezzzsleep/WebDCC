import { describe, expect, it } from 'vitest';
import { dshCapabilities } from '../src/rest.js';
import { createTestApp } from './helpers.js';

describe('DSH Provider 能力识别', () => {
  it('官方 Provider 使用 DeepSeek 原生能力和模型目录', () => {
    const result = dshCapabilities('deepseek-official', 'deepseek-flash', {}, [
      { ns: 'llm-deepseek', value: { defaultContextWindow: 270_000, maxTokens: 256_000, models: [{ id: 'deepseek-flash', contextWindow: 1_048_576 }] } },
    ]);
    expect(result).toEqual({
      official: true,
      reasoningEfforts: ['off', 'low', 'high', 'max'],
      defaultReasoning: 'high',
      contextWindow: 1_048_576,
      maxTokens: 256_000,
    });
  });

  it('第三方 Provider 不继承官方 namespace 的旧容量', () => {
    const result = dshCapabilities('tokenrhythm', 'deepseek-v4.1-flash-1017', {}, [
      { ns: 'llm-deepseek', value: { defaultContextWindow: 270_000, maxTokens: 256_000 } },
    ]);
    expect(result).toEqual({
      official: false,
      reasoningEfforts: [],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
  });

  it('第三方 Provider 使用模型声明的思考等级和容量', () => {
    const result = dshCapabilities('openai-next', 'deepseek-v4-1-flash-261017', {
      defaultContextWindow: 1_000_000,
      defaultMaxTokens: 1_000_000,
      reasoning: 'medium',
      models: [{ id: 'deepseek-v4-1-flash-261017', contextWindow: 1_048_576, maxTokens: 1_048_576, reasoningEfforts: { minimal: 'minimal', medium: 'medium', max: 'max' } }],
    }, []);
    expect(result).toEqual({
      official: false,
      reasoningEfforts: ['minimal', 'medium', 'max'],
      defaultReasoning: 'medium',
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
    });
  });

  it('禁止通过第三方接口覆盖官方 Provider', async () => {
    const ctx = await createTestApp();
    try {
      const response = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/dsh/provider',
        headers: { cookie: ctx.cookie },
        payload: { providerKey: 'deepseek-official', baseURL: 'https://example.invalid/v1', model: 'deepseek-flash' },
      });
      expect(response.statusCode).toBe(409);
    } finally {
      await ctx.close();
    }
  });
});
