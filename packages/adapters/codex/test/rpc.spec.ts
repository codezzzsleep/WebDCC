import { describe, expect, it } from 'vitest';
import { JsonRpcStdio } from '../src/rpc.js';

const program = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
rl.on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method === 'string/request') send({ id: 'native-A', method: 'native/request', params: {} });
  if (frame.method === 'tick') send({ method: 'tick', params: {} });
  if (frame.method) send({ id: frame.id, result: frame.params });
  else if (frame.id === 'native-A') send({ method: 'observedReply', params: frame });
});`;

describe('NP-02 RPC lifecycle', () => {
  it('preserves string request IDs, bounds diagnostics and removes temporary listeners', async () => {
    const rpc = JsonRpcStdio.start({ command: process.execPath, args: ['-e', program], maxFrames: 2 });
    try {
      const dispose = rpc.onServerRequest(() => ({ answer: 'yes' }));
      const reply = rpc.waitForNotification(frame => frame['method'] === 'observedReply', 2000);
      await rpc.request('string/request', {});
      expect((await reply)['params']).toEqual({ id: 'native-A', result: { answer: 'yes' } });
      expect(rpc.resourceCounts).toMatchObject({ pending: 0, listeners: 1, waiters: 0, frames: 2 });
      dispose();
      const timedOut = rpc.waitForNotification(() => false, 10);
      await expect(timedOut).rejects.toThrow('超时');
      expect(rpc.resourceCounts).toMatchObject({ listeners: 0, waiters: 0 });
    } finally { await rpc.kill(); }
    expect(rpc.resourceCounts).toMatchObject({ pending: 0, listeners: 0, waiters: 0 });
    await expect(rpc.request('closed', {})).rejects.toThrow('closed');
    expect(() => rpc.respond('native-A', {})).toThrow('closed');
  });

  it('rejects waiters and pending requests when spawning fails and retains no diagnostic frames by default', async () => {
    const rpc = JsonRpcStdio.start({ command: '/missing-webdcc-test-binary' });
    const request = rpc.request('initialize', {});
    const notification = rpc.waitForNotification(() => false);
    await Promise.all([expect(request).rejects.toThrow('无法启动'), expect(notification).rejects.toThrow('无法启动')]);
    expect(rpc.isClosed).toBe(true);
    expect(rpc.resourceCounts).toEqual({ pending: 0, listeners: 0, waiters: 0, frames: 0 });
  });
});
