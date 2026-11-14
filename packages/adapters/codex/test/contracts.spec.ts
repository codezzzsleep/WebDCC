import { describe, expect, it } from 'vitest';
import { CodexAdapter, buildThreadStartParams, buildTurnStartParams } from '../src/adapter.js';
import { validateNativeParams, validateNativeResult } from '../src/controls.js';

describe('NP-02/07 pinned Codex contracts', () => {
  it('uses distinct thread and turn policies and preserves text bytes', () => {
    const text = '字\n\n $HOME `literal` \r\n';
    const thread = buildThreadStartParams({ sessionId: 's', cwd: '/tmp/work', providerId: null, accessMode: 'workspace' });
    const turn = buildTurnStartParams('t', text, 'workspace', null, null, [], '/tmp/work');
    expect(thread.sandbox).toBe('workspace-write');
    expect(turn).not.toHaveProperty('sandbox');
    expect(turn.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', writableRoots: ['/tmp/work'] });
    expect(turn.input).toContainEqual({ type: 'text', text, text_elements: [] });
    expect(() => validateNativeParams('thread/start', thread)).not.toThrow();
    expect(() => validateNativeParams('turn/start', turn)).not.toThrow();
    expect(() => validateNativeParams('turn/start', { ...turn, sandbox: 'workspace-write' })).toThrow('Invalid');
  });

  it('inherits the native policy without an explicit override and rejects invalid enums', () => {
    const turn = buildTurnStartParams('t', 'text');
    expect(turn).not.toHaveProperty('sandboxPolicy');
    expect(turn).not.toHaveProperty('approvalPolicy');
    expect(() => validateNativeParams('turn/start', { ...turn, approvalPolicy: 'approved' })).toThrow('Invalid');
    expect(() => validateNativeParams('turn/start', { ...turn, sandboxPolicy: { type: 'workspace-write' } })).toThrow('Invalid');
    expect(() => validateNativeParams('unknown/method', {})).toThrow('Unsupported');
    expect(() => buildTurnStartParams('t', 'text', 'invalid-mode')).toThrow('不支持');
  });

  it('validates initialization from the combined native export and rejects incomplete results', () => {
    const initialized = { userAgent: 'codex', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'linux' };
    expect(() => validateNativeResult('initialize', initialized)).not.toThrow();
    expect(() => validateNativeResult('initialize', { userAgent: 'codex' })).toThrow('Invalid');
    expect(() => validateNativeResult('turn/start', { turn: { id: 't' } })).toThrow('Invalid');
  });

  it('NP-12 provider names, model IDs and catalog paths cannot escape their quoted native values', () => {
    const name = 'Provider "one"\nmodel = "unexpected"'; const model = 'quoted "model"'; const path = '/tmp/with "quotes"/catalog.json';
    const spec = new CodexAdapter().buildLaunchSpec({ sessionId: 's', cwd: '/tmp', providerId: 'provider', model,
      provider: { id: 'provider', name, protocols: ['openai-responses'], baseUrl: 'https://example.com/v1', codexCatalogPath: path } });
    const value = (prefix: string): unknown => JSON.parse(spec.args.find(argument => argument.startsWith(prefix))!.slice(prefix.length));
    expect(value('model_providers.wdcc_provider.name=')).toBe(name);
    expect(value('model_catalog_json=')).toBe(path); expect(value('model=')).toBe(model);
    expect(() => new CodexAdapter().buildLaunchSpec({ sessionId: 's', cwd: '/tmp', providerId: 'unsafe', provider: { id: 'nested.unsafe', name: 'name', protocols: ['openai-responses'], baseUrl: 'https://example.com' } })).toThrow('配置键');
  });
});
