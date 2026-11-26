import { nativeForkFixture } from './native-fork-runtime.js';
import { executeCodexNativeControl } from '../../../adapters/codex/src/native.js';
import { NativeRpcResponseError, type JsonRpcStdio } from '../../../adapters/codex/src/rpc.js';

/** Controlled native reply producer; source/browser tests are not live native acceptance. */
export function codexForkRejectionFixture(cwd: string, sourceNativeId = 'native-source', uncertain = false) {
  const fixture = nativeForkFixture('codex', cwd, sourceNativeId);
  const originalControl = fixture.adapter.executeNativeControl!; const originalState = fixture.adapter.nativeState!;
  let ready = false; let calls = 0;
  const rpc = { nativeVersion: '0.172.0', request: async (method: string) => {
    if (uncertain) throw new Error('Native transport outcome unavailable');
    throw new NativeRpcResponseError(method, { code: -32600, message: `no rollout found for thread id ${sourceNativeId}` }, '0.172.0');
  } } as unknown as JsonRpcStdio;
  fixture.adapter.executeNativeControl = async (id, action) => {
    calls++;
    if (!ready) return executeCodexNativeControl(rpc, sourceNativeId, cwd, { type: 'fork' });
    return originalControl(id, action);
  };
  fixture.adapter.nativeState = async id => ({ ...await originalState(id) as object, revision: ready ? 'ready-history' : 'history-unavailable' });
  return { ...fixture, setReady: () => { ready = true; }, controlCalls: () => calls };
}
