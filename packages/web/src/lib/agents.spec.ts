import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultChoice, rememberModel, rememberReasoning } from './agents.js';

function makeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

describe('新会话默认选择', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: makeStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Claude 记住上次选择的 Provider、模型和思考等级', () => {
    const providers = [
      { id: 'claude-one', name: 'one', baseUrl: 'https://one', protocols: ['anthropic-messages'], models: ['claude-sonnet'], hasKey: true, createdAt: '' },
      { id: 'claude-two', name: 'two', baseUrl: 'https://two', protocols: ['anthropic-messages'], models: ['claude-opus'], hasKey: true, createdAt: '' },
    ];
    rememberModel('claude-code', 'claude-two', 'claude-opus');
    rememberReasoning('claude-code', 'xhigh');

    expect(defaultChoice('claude-code', undefined, providers)).toEqual({
      providerId: 'claude-two',
      model: 'claude-opus',
      reasoningEffort: 'xhigh',
    });
  });

  it('已删除的模型回退到仍可用的默认模型', () => {
    const providers = [{ id: 'claude-one', name: 'one', baseUrl: 'https://one', protocols: ['anthropic-messages'], models: ['claude-sonnet'], hasKey: true, createdAt: '' }];
    rememberModel('claude-code', 'removed', 'claude-opus');

    expect(defaultChoice('claude-code', undefined, providers)).toMatchObject({ providerId: 'claude-one', model: 'claude-sonnet' });
  });
});
