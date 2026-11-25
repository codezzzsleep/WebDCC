import { expect, it } from 'vitest';
import { releaseCodexFork } from '../src/native.js';
import type { JsonRpcStdio } from '../src/rpc.js';

it('releases only the forked child and waits for its native close rather than an ACK or the parent close', async () => {
  let listener!: (frame: Record<string, unknown>) => void; let listeners = 0; let completed = false;
  const requests: unknown[] = [];
  const rpc = { nativeVersion: '0.172.0', onNotification: (run: typeof listener) => { listener = run; listeners++; return () => { listeners--; }; },
    request: async (method: string, params: unknown) => { requests.push({ method, params }); return { status: 'unsubscribed' }; } } as unknown as JsonRpcStdio;
  const releasing = releaseCodexFork(rpc, 'actual-child').then(() => { completed = true; });
  await Promise.resolve(); await Promise.resolve();
  listener({ method: 'thread/closed', params: { threadId: 'source-parent' } }); await Promise.resolve();
  expect(completed).toBe(false); expect(listeners).toBe(1);
  expect(requests).toEqual([{ method: 'thread/unsubscribe', params: { threadId: 'actual-child' } }]);
  listener({ method: 'thread/closed', params: { threadId: 'actual-child' } }); await releasing;
  expect(completed).toBe(true); expect(listeners).toBe(0);
});

it('retains release failures and removes the temporary listener without touching another writer', async () => {
  let listeners = 0;
  const rpc = { nativeVersion: '0.172.0', onNotification: () => { listeners++; return () => { listeners--; }; },
    request: async () => { throw new Error('Native transport outcome unknown'); } } as unknown as JsonRpcStdio;
  await expect(releaseCodexFork(rpc, 'actual-child')).rejects.toThrow('unknown');
  expect(listeners).toBe(0);
});
