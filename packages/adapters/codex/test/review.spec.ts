import { expect, it } from 'vitest';
import { executeCodexNativeControl, type CodexNativeAction } from '../src/native.js';
import type { JsonRpcStdio } from '../src/rpc.js';

function fixture(cwd = '/workspace', id = 'native') {
  const calls: { method: string; params: unknown }[] = [];
  const rpc = { request: async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id, cwd, preview: '', ephemeral: false, modelProvider: 'fixture',
      createdAt: 1, updatedAt: 1, status: { type: 'idle' }, cliVersion: '0.169.0', source: 'appServer',
      projectId: null, sessionId: 'native-session', turns: [] } };
    if (method === 'review/start') return { reviewThreadId: 'native', turn: { id: 'review-turn', items: [], status: 'inProgress' } };
    throw new Error('Unexpected native method: ' + method);
  } } as unknown as JsonRpcStdio;
  return { rpc, calls };
}

const targets = [{ type: 'uncommittedChanges' }, { type: 'baseBranch', branch: 'baseline' },
  { type: 'commit', sha: 'abcdef1234567890', title: null }] as const;

it.each(targets)('reads the actual workspace before native Review target $type and preserves exact native target fields', async target => {
  const { rpc, calls } = fixture();
  const action: CodexNativeAction = { type: 'review', target };
  await expect(executeCodexNativeControl(rpc, 'native', '/workspace/', action)).resolves.toMatchObject({ reviewThreadId: 'native' });
  expect(calls).toEqual([
    { method: 'thread/read', params: { threadId: 'native', includeTurns: false } },
    { method: 'review/start', params: { threadId: 'native', target, delivery: 'inline' } },
  ]);
});

it.each([['/other-workspace', 'native'], ['/workspace', 'foreign-thread']])('does not submit a Review to a mismatched native workspace/thread (%s, %s)', async (cwd, nativeId) => {
  const { rpc, calls } = fixture(cwd, nativeId);
  await expect(executeCodexNativeControl(rpc, 'native', '/workspace', { type: 'review', target: { type: 'uncommittedChanges' } })).rejects.toMatchObject({ code: 'native-control-rejected' });
  expect(calls.some(call => call.method === 'review/start')).toBe(false);
});

it('does not submit after the current native instance changes during the read-only workspace check', async () => {
  const { rpc, calls } = fixture();
  await expect(executeCodexNativeControl(rpc, 'native', '/workspace', { type: 'review', target: { type: 'uncommittedChanges' } },
    () => { throw Object.assign(new Error('Native instance changed'), { code: 'native-control-rejected' }); })).rejects.toMatchObject({ code: 'native-control-rejected' });
  expect(calls.map(call => call.method)).toEqual(['thread/read']);
});
