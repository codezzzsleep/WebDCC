import { describe, expect, it } from 'vitest';
import { buildThreadStartParams, buildTurnStartParams } from '../src/adapter.js';
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
});
