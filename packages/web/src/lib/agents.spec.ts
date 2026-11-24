import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentStatusLine, defaultAccessMode, defaultChoice, isAccessModeSelectable, rememberAccessMode, rememberedAccessMode, rememberModel, rememberReasoning } from './agents.js';
import type { MetaResponse } from '@webdcc/protocol';

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
  it('shows the audited version list and keeps a fallback for other native runtimes', () => {
    const info = { installed: true, version: '0.173.0', pinnedVersion: '0.167.0', compatible: false,
      supportedVersions: ['0.167.0', '0.168.0', '0.169.0', '0.172.0'] };
    const meta = { agents: { codex: info } } as unknown as MetaResponse;
    expect(agentStatusLine('codex', meta, [])).toBe('版本不兼容：0.173.0（支持 0.167.0、0.168.0、0.169.0、0.172.0）');
    expect(agentStatusLine('codex', { agents: { codex: { ...info, supportedVersions: undefined } } } as unknown as MetaResponse, []))
      .toBe('版本不兼容：0.173.0（支持 0.167.0）');
  });
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

  it('clearing an explicit model choice restores the native inherited default without promoting a companion model', () => {
    const providers = [{ id: 'p', name: 'p', baseUrl: 'https://fixture.invalid', source: 'claude-settings', protocols: ['anthropic-messages'], models: ['custom', 'fast'], nativeDefault: true, nativeDefaultModel: '', hasKey: true, createdAt: '' }];
    rememberModel('claude-code', 'p', 'custom'); expect(defaultChoice('claude-code', undefined, providers).model).toBe('custom');
    rememberModel('claude-code', 'p', ''); expect(defaultChoice('claude-code', undefined, providers)).toMatchObject({ providerId: 'p', model: '' });
  });

  it('已删除的模型回退到仍可用的默认模型', () => {
    const providers = [{ id: 'claude-one', name: 'one', baseUrl: 'https://one', protocols: ['anthropic-messages'], models: ['claude-sonnet'], hasKey: true, createdAt: '' }];
    rememberModel('claude-code', 'removed', 'claude-opus');

    expect(defaultChoice('claude-code', undefined, providers)).toMatchObject({ providerId: 'claude-one', model: 'claude-sonnet' });
  });

  it('DSH restores only a declared level and clearing inheritance does not change Codex preferences', () => {
    const meta = { installed: true, pinnedVersion: '0.2.2-rc.1', auth: 'unknown' as const, accessModes: [],
      models: [{ id: 'thinking', label: 'Thinking', reasoningEfforts: ['off', 'high', 'max'] }] };
    rememberReasoning('codex', 'xhigh');
    rememberModel('dsh', null, 'thinking');
    rememberReasoning('dsh', 'high');
    expect(defaultChoice('dsh', meta, [])).toEqual({ providerId: null, model: 'thinking', reasoningEffort: 'high' });
    rememberReasoning('dsh', undefined);
    expect(defaultChoice('dsh', meta, [])).toEqual({ providerId: null, model: 'thinking' });
    expect(defaultChoice('codex', undefined, []).reasoningEffort).toBe('xhigh');
  });

  it('DSH never restores a level absent from the current native model catalogue', () => {
    const meta = { installed: true, pinnedVersion: '0.2.2-rc.1', auth: 'unknown' as const, accessModes: [],
      models: [{ id: 'thinking', label: 'Thinking', reasoningEfforts: ['off', 'high'] }] };
    rememberReasoning('dsh', 'max');
    expect(defaultChoice('dsh', meta, []).reasoningEffort).toBeUndefined();
    expect(defaultChoice('dsh', { ...meta, models: [{ id: 'plain', label: 'Plain' }] }, []).reasoningEffort).toBeUndefined();
  });

  it('restores each Harness preference independently and an explicit current choice takes precedence', () => {
    const modes = [{ id: 'inherit', label: 'Inherit' }, { id: 'workspace', label: 'Workspace' }, { id: 'acceptEdits', label: 'Accept edits' }];
    rememberAccessMode('codex', 'workspace'); rememberAccessMode('claude-code', 'acceptEdits'); rememberAccessMode('dsh', 'inherit');
    expect(defaultAccessMode('codex', modes)).toBe('workspace');
    expect(defaultAccessMode('claude-code', modes)).toBe('acceptEdits');
    expect(defaultAccessMode('dsh', modes)).toBe('inherit');
    expect(defaultAccessMode('codex', modes, 'inherit')).toBe('inherit');
    expect(rememberedAccessMode('codex')).toBe('workspace');
  });

  it('falls back from absent, forbidden and unimplemented preferences without overwriting the stored value', () => {
    const modes = [{ id: 'blocked-first', label: 'Blocked', allowed: false }, { id: 'inherit', label: 'Inherit' }, { id: 'missing-implementation', label: 'Not implemented', implemented: false }];
    for (const value of ['removed-mode', 'blocked-first', 'missing-implementation']) {
      rememberAccessMode('codex', value);
      expect(defaultAccessMode('codex', modes)).toBe('inherit');
      expect(rememberedAccessMode('codex')).toBe(value);
    }
    expect(defaultAccessMode('codex', [])).toBeUndefined();
    expect(defaultAccessMode('codex', [{ id: 'blocked-first', label: 'Blocked', allowed: false }])).toBeUndefined();
  });

  it('shares the root restriction with the menu without replacing native inheritance', () => {
    const bypass = { id: 'bypassPermissions', label: 'Bypass' };
    const modes = [{ id: 'inherit', label: 'Inherit' }, bypass];
    rememberAccessMode('claude-code', 'bypassPermissions');
    expect(defaultAccessMode('claude-code', modes, undefined, true)).toBe('inherit');
    expect(defaultAccessMode('claude-code', modes, undefined, false)).toBe('bypassPermissions');
    expect(isAccessModeSelectable('claude-code', bypass, true)).toBe(false);
    expect(isAccessModeSelectable('codex', bypass, true)).toBe(true);
  });

  it('uses the available default when browser storage cannot be read', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('storage unavailable'); } });
    expect(defaultAccessMode('codex', [{ id: 'inherit', label: 'Inherit' }])).toBe('inherit');
  });
});
