import { describe, expect, it } from 'vitest';
import { JsonRpcStdio, NativeRpcResponseError } from '../src/rpc.js';

const script = String.raw`
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'missing') process.stdout.write(JSON.stringify({ id: request.id }) + '\n');
  else process.stdout.write(JSON.stringify({ id: request.id, result: null }) + '\n');
});`;

const responseProgram = String.raw`
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
let held;
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  switch (request.method) {
    case 'wire': send({ id: request.id, ...request.params }); break;
    case 'hold': held = request.id; break;
    case 'bad-and-release':
      send({ id: request.id });
      send({ id: held, result: { received: true } });
      break;
    case 'interleaved':
      send({ id: String(request.id) });
      send({ id: request.id + 100 });
      send({ method: 'native/notice', params: { unchanged: true } });
      send({ id: 'native-A', method: 'native/request', params: { unchanged: true } });
      send({ id: request.id, result: null });
      break;
    default:
      if (request.id === 'native-A') send({ method: 'native/reply', params: request });
  }
});`;

describe('Codex native RPC response envelopes over stdio', () => {
  it.each([
    ['missing result and error', {}],
    ['result and error together', { result: null, error: { code: -32000, message: 'failed' } }],
    ['result and null error together', { result: null, error: null }],
    ['null error', { error: null }],
    ['false error', { error: false }],
    ['string error', { error: 'failed' }],
    ['array error', { error: [] }],
    ['missing error code', { error: { message: 'failed' } }],
    ['string error code', { error: { code: '-32000', message: 'failed' } }],
    ['fractional error code', { error: { code: -32000.5, message: 'failed' } }],
    ['missing error message', { error: { code: -32000 } }],
    ['non-string error message', { error: { code: -32000, message: 1 } }],
  ])('rejects %s, retains the original frame, and leaves the channel usable', async (_name, response) => {
    const rpc = JsonRpcStdio.start({ command: process.execPath, args: ['-e', responseProgram], maxFrames: 2 });
    try {
      await expect(rpc.request('wire', response, 2000)).rejects.toMatchObject({ code: 'native-protocol-error', message: 'wire 原生响应格式无效' });
      expect(rpc.resourceCounts.pending).toBe(0);
      expect(rpc.receivedFrames).toEqual([{ id: 1, ...response }]);
      expect(rpc.isClosed).toBe(false);
      await expect(rpc.request('wire', { result: null }, 2000)).resolves.toBeNull();
    } finally { await rpc.kill(); }
    expect(rpc.resourceCounts).toMatchObject({ pending: 0, waiters: 0, listeners: 0 });
  });

  it.each([null, false, 0, '', [], { accepted: true }])('preserves a successful result %j without replacing it', async result => {
    const rpc = JsonRpcStdio.start({ command: process.execPath, args: ['-e', responseProgram] });
    try { await expect(rpc.request('wire', { result }, 2000)).resolves.toEqual(result); }
    finally { await rpc.kill(); }
  });

  it('keeps a valid native error a failure and preserves its full diagnostic payload', async () => {
    const rpc = JsonRpcStdio.start({ command: process.execPath, args: ['-e', responseProgram], nativeVersion: '0.172.0', maxFrames: 1 });
    const error = { code: -32000, message: 'native denied', data: { retryable: false } };
    try {
      const failure = await rpc.request('wire', { error }, 2000).catch(value => value);
      expect(failure).toBeInstanceOf(NativeRpcResponseError);
      expect(failure).toMatchObject({ method: 'wire', nativeVersion: '0.172.0', response: error, message: `wire 失败：${JSON.stringify(error)}` });
      expect(String(failure)).toBe(`Error: wire 失败：${JSON.stringify(error)}`);
      expect(rpc.receivedFrames).toEqual([{ id: 1, error }]);
      expect(rpc.resourceCounts.pending).toBe(0);
    } finally { await rpc.kill(); }
  });

  it('a malformed response rejects only its matching concurrent request', async () => {
    const rpc = JsonRpcStdio.start({ command: process.execPath, args: ['-e', responseProgram] });
    try {
      const held = rpc.request('hold', {}, 2000);
      const bad = rpc.request('bad-and-release', {}, 2000);
      await Promise.all([
        expect(bad).rejects.toMatchObject({ code: 'native-protocol-error' }),
        expect(held).resolves.toEqual({ received: true }),
      ]);
      expect(rpc.resourceCounts.pending).toBe(0);
    } finally { await rpc.kill(); }
  });

  it('does not coerce response IDs or disturb interleaved notifications and string server requests', async () => {
    const rpc = JsonRpcStdio.start({ command: process.execPath, args: ['-e', responseProgram], maxFrames: 6 });
    const requests: Record<string, unknown>[] = [];
    rpc.onServerRequest(frame => { requests.push(frame); return { decision: 'allow' }; });
    try {
      const notice = rpc.waitForNotification(frame => frame['method'] === 'native/notice', 2000);
      const reply = rpc.waitForNotification(frame => frame['method'] === 'native/reply', 2000);
      await Promise.all([
        expect(rpc.request('interleaved', {}, 2000)).resolves.toBeNull(),
        expect(notice).resolves.toEqual({ method: 'native/notice', params: { unchanged: true } }),
        expect(reply).resolves.toEqual({ method: 'native/reply', params: { id: 'native-A', result: { decision: 'allow' } } }),
      ]);
      expect(requests).toEqual([{ id: 'native-A', method: 'native/request', params: { unchanged: true } }]);
      expect(rpc.receivedFrames.slice(0, 2)).toEqual([{ id: '1' }, { id: 101 }]);
      expect(rpc.resourceCounts).toMatchObject({ pending: 0, waiters: 0, listeners: 1 });
    } finally { await rpc.kill(); }
  });
});

it('an ID-only wire response cannot be accepted as a successful void native request', async () => {
  const frames: Record<string, unknown>[] = [];
  const rpc = JsonRpcStdio.start({ command: process.execPath, args: ['-e', script], onFrame: (dir, frame) => { if (dir === 'in') frames.push(frame); } });
  try {
    const outcome = await rpc.request<void>('missing', {}, 1000).then(value => ({ fulfilled: true, value, error: undefined }), error => ({ fulfilled: false, value: undefined, error }));
    console.info('controlled malformed native response', JSON.stringify({ fulfilled: outcome.fulfilled, frames, pending: rpc.resourceCounts.pending, nativeBinary: false }));
    expect(outcome.fulfilled).toBe(false);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(rpc.resourceCounts.pending).toBe(0);
    await expect(rpc.request('valid', {}, 1000)).resolves.toBeNull();
  } finally { await rpc.kill(); }
});
