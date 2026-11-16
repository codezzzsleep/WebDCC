import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocketServer, type WebSocket } from 'ws';
import { expect, it, vi } from 'vitest';
import { DshHostClient } from '../src/host.js';

const run = promisify(execFile);

async function controlledMux(onOpen?: (socket: WebSocket, streamId: string) => void) {
  const mux = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const frames: { type: string; streamId?: string; endpoint?: string }[] = [];
  mux.on('connection', socket => socket.on('message', value => {
    const frame = JSON.parse(String(value)) as typeof frames[number];
    frames.push(frame);
    if (frame.type === 'open' && frame.endpoint === 'job/list' && frame.streamId !== undefined) onOpen?.(socket, frame.streamId);
  }));
  await once(mux, 'listening');
  const address = mux.address();
  if (address === null || typeof address === 'string') throw new Error('missing controlled mux address');
  return { endpoint: `http://127.0.0.1:${address.port}/`, frames,
    async close() {
      for (const socket of mux.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => mux.close(error => error ? reject(error) : resolve()));
    } };
}

it('settles a pending snapshot and lets the process exit naturally after explicit Host close', async () => {
  const mux = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const frames: unknown[] = [];
  mux.on('connection', socket => socket.on('message', value => frames.push(JSON.parse(String(value)))));
  await once(mux, 'listening');
  const address = mux.address();
  if (address === null || typeof address === 'string') throw new Error('missing controlled mux address');
  const source = `
import { DshHostClient } from ${JSON.stringify(new URL('../src/host.ts', import.meta.url).href)};
const host = new DshHostClient(process.env.WDCC_SNAPSHOT_TEST_URL);
await host.connect();
let outcome;
const pending = host.snapshot('session/follow', { request: { address: { kind: 'session', sessionId: 'controlled-one' } } }, 60000)
  .then(value => { outcome = { resolved: true, value }; }, error => { outcome = { rejected: true, message: error.message, code: error.code }; });
// The snapshot continuation sends the original open frame before this turn.
await new Promise(resolve => setImmediate(resolve));
await host.close();
process.stdout.write(JSON.stringify({ afterClose: outcome ?? 'pending' }) + '\\n');
await pending;
process.stdout.write(JSON.stringify({ outcome }) + '\\n');
// No forced process.exit: a leaked snapshot timer keeps this process alive.
`;
  try {
    const result = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)), timeout: 5000,
      env: { ...process.env, WDCC_SNAPSHOT_TEST_URL: `http://127.0.0.1:${address.port}/` },
    }).then(value => ({ code: 0 as number | string | undefined, signal: null as string | null, stdout: value.stdout, stderr: value.stderr }),
      (error: { code?: number | string; signal?: string; stdout?: string; stderr?: string }) => ({ code: error.code, signal: error.signal ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('"afterClose":"pending"');
    expect(result.stdout).toContain('"rejected":true');
    expect(result.stdout).toContain('dsh-host-closed');
    expect(frames).toContainEqual({ type: 'open', streamId: 's1', endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'controlled-one' } } } } });
    expect(frames.every(frame => (frame as { type: string }).type !== 'error')).toBe(true);
  } finally {
    for (const socket of mux.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => mux.close(error => error ? reject(error) : resolve()));
  }
});

it('rejects all pending snapshots on repeated close without fabricating frames for unrelated streams', async () => {
  const server = await controlledMux();
  const host = new DshHostClient(server.endpoint);
  const unrelated: unknown[] = [];
  try {
    await host.connect();
    host.openStream('$events', {}, frame => unrelated.push(frame));
    const pending = [1, 2].map(number => host.snapshot('job/list', { request: { sessionId: `controlled-${number}` } }, 60000));
    const results = Promise.allSettled(pending);
    await vi.waitFor(() => expect(server.frames.filter(frame => frame.type === 'open')).toHaveLength(3));
    await host.close(); await host.close();
    const settled = await results;
    expect(settled).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'dsh-host-closed' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'dsh-host-closed' }) })]);
    expect(unrelated).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.isConnected).toBe(false);
    expect(server.frames.every(frame => frame.type !== 'error' && frame.type !== 'end')).toBe(true);
  } finally { await host.close(); await server.close(); }
});

it.each(['baseline', 'invalid-baseline', 'error', 'end', 'timeout'] as const)('keeps %s snapshot settlement and cancels only its own subscription', async mode => {
  const baseline = { type: 'rows', jobs: [] };
  const server = await controlledMux((socket, streamId) => {
    if (mode === 'timeout') return;
    socket.send(JSON.stringify(mode === 'error' || mode === 'end' ? { type: mode, streamId, error: { message: 'controlled stream failure' } }
      : { type: 'item', streamId, value: mode === 'baseline' ? baseline : { type: 'rows', jobs: 'invalid' } }));
  });
  const host = new DshHostClient(server.endpoint);
  const unrelated: unknown[] = [];
  try {
    await host.connect();
    const other = host.openStream('$events', {}, frame => unrelated.push(frame));
    const pending = host.snapshot('job/list', { request: { sessionId: 'controlled-one' } }, mode === 'timeout' ? 30 : 1000);
    if (mode === 'baseline') await expect(pending).resolves.toEqual(baseline);
    else await expect(pending).rejects.toThrow(mode === 'timeout' ? 'timed out' : mode === 'invalid-baseline' ? 'Invalid DSH job/list result' : 'ended before its baseline');
    await vi.waitFor(() => expect(server.frames.some(frame => frame.type === 'cancel' && frame.streamId !== other)).toBe(true));
    expect(server.frames.some(frame => frame.type === 'cancel' && frame.streamId === other)).toBe(false);
    expect(unrelated).toEqual([]);
    await host.close();
  } finally { await host.close(); await server.close(); }
});

it('preserves a failed connection rejection without registering a snapshot or retaining retry timers after close', async () => {
  const server = await controlledMux();
  const endpoint = server.endpoint;
  await server.close();
  const host = new DshHostClient(endpoint, { reconnectDelayMs: 10000 });
  try { await expect(host.snapshot('job/list', { request: { sessionId: 'controlled-one' } })).rejects.toThrow(); }
  finally { await host.close(); }
  expect(host.isConnected).toBe(false);
});
