import { expect, it } from 'vitest';
import { executeCodexNativeControl } from '../src/native.js';
import { JsonRpcStdio, NativeRpcResponseError } from '../src/rpc.js';

const noHistory = { code: -32600, message: 'no rollout found for thread id native-source' };
const program = String.raw`
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  process.stdout.write(JSON.stringify({id:request.id,error:JSON.parse(process.env.NATIVE_TEST_ERROR)})+'\n');
});`;

it('a validated actual-version no-history fork rejection remains the original failure and is retryable without effects', async () => {
  const rpc = JsonRpcStdio.start({ command: process.execPath, args: ['-e', program], nativeVersion: '0.172.0',
    env: { ...process.env, NATIVE_TEST_ERROR: JSON.stringify(noHistory) }, maxFrames: 1 });
  try {
    const failure = await executeCodexNativeControl(rpc, 'native-source', '/workspace', { type: 'fork' }).catch(value => value);
    expect(failure).toBeInstanceOf(NativeRpcResponseError);
    expect(failure).toMatchObject({ code: 'native-control-rejected-no-effect', statusCode: 409, method: 'thread/fork', response: noHistory });
    expect(failure.message).toBe(`thread/fork 失败：${JSON.stringify(noHistory)}`);
    expect(rpc.receivedFrames).toEqual([{ id: 1, error: noHistory }]);
    expect(rpc.resourceCounts.pending).toBe(0);
  } finally { await rpc.kill(); }
});

it.each([
  ['unreviewed version', '0.169.0', noHistory],
  ['different source', '0.172.0', { ...noHistory, message: 'no rollout found for thread id another-source' }],
  ['different native error', '0.172.0', { code: -32000, message: noHistory.message }],
  ['unfamiliar native reason', '0.172.0', { ...noHistory, message: 'native fork outcome unavailable' }],
  ['additional unconfirmed data', '0.172.0', { ...noHistory, data: { childCreated: true } }],
])('does not infer safe retry from %s', async (_name, nativeVersion, error) => {
  const rpc = JsonRpcStdio.start({ command: process.execPath, args: ['-e', program], nativeVersion,
    env: { ...process.env, NATIVE_TEST_ERROR: JSON.stringify(error) } });
  try {
    const failure = await executeCodexNativeControl(rpc, 'native-source', '/workspace', { type: 'fork' }).catch(value => value);
    expect(failure).toBeInstanceOf(NativeRpcResponseError);
    expect(failure.code).toBeUndefined();
    expect(failure.response).toEqual(error);
  } finally { await rpc.kill(); }
});

it('unstructured lookalike text and a lost transport remain unconfirmed', async () => {
  for (const failure of [new Error(`thread/fork 失败：${JSON.stringify(noHistory)}`), new Error('Native transport disconnected')]) {
    const rpc = { nativeVersion: '0.172.0', request: async () => { throw failure; } } as unknown as JsonRpcStdio;
    await expect(executeCodexNativeControl(rpc, 'native-source', '/workspace', { type: 'fork' })).rejects.toBe(failure);
    expect((failure as { code?: string }).code).toBeUndefined();
  }
});
