import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { DshHostClient, type DshRpcError, type DshRpcObservation } from '../src/host.js';
import { DshAdapter } from '../src/adapter.js';
import type { CreateOpts, TraceFrame } from '@webdcc/protocol';

async function rpcServer(reply: (request: Record<string, unknown>, response: ServerResponse) => void) {
  const requests: { path: string | undefined; body: string; envelope: Record<string, unknown> }[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = Buffer.concat(chunks).toString('utf8');
      const envelope = JSON.parse(body) as Record<string, unknown>;
      requests.push({ path: request.url, body, envelope });
      response.setHeader('content-type', 'application/json');
      response.setHeader('set-cookie', 'dsh-auth-test=private-response-cookie');
      reply(envelope, response);
    })().catch(() => { response.destroy(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing server address');
  return { endpoint: `http://127.0.0.1:${address.port}/dsh/`, requests,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const args = { agentId: 'native-A', line: '  exact\r\n"你好"  ', submittedAttachments: [] };

it('observes the actual local HTTP request and full response without changing payload or exposing headers', async () => {
  const replies: unknown[] = [];
  const server = await rpcServer((request, response) => {
    const envelope = { type: 'server-response', rpcId: request['rpcId'], result: { ok: true, value: { nested: { exact: args.line }, nativeField: [1, false] } }, extension: { native: true } };
    replies.push(envelope); response.end(JSON.stringify(envelope));
  });
  const global: DshRpcObservation[] = [];
  const perCall: DshRpcObservation[] = [];
  const host = new DshHostClient(server.endpoint, { onRpcFrame: frame => { global.push(frame); } });
  host.useCookie('dsh-auth-test=private-request-cookie');
  try {
    const result = await host.rpc<Record<string, unknown>>('commands/execute', args, frame => {
      perCall.push(frame);
      expect(Object.isFrozen(frame)).toBe(true);
      expect(Object.isFrozen(frame.frame)).toBe(true);
      if (frame.dir === 'in') {
        expect(() => { (frame.frame as Record<string, unknown>)['extension'] = 'changed'; }).toThrow();
      }
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.path).toBe('/dsh/api/commands/execute');
    expect(server.requests[0]?.envelope).toEqual({ type: 'client-request', rpcId: perCall[0]?.rpcId, method: 'commands/execute', payload: { args } });
    expect(perCall[0]?.frame).toEqual(server.requests[0]?.envelope);
    expect(perCall[1]?.frame).toEqual(replies[0]);
    expect(perCall[1]).toMatchObject({ dir: 'in', rpcId: perCall[0]?.rpcId, httpStatus: 200, capture: { coverage: 'complete' } });
    expect(result).toEqual({ nested: { exact: args.line }, nativeField: [1, false] });
    expect(Object.isFrozen(result)).toBe(false);
    expect(global).toEqual(perCall);
    expect(JSON.stringify(perCall)).not.toMatch(/private-request-cookie|private-response-cookie|headers|cookie/i);
  } finally { await host.close(); await server.close(); }
});

it('retains complete native errors and mismatched envelopes before their existing rejection path', async () => {
  const server = await rpcServer((request, response) => {
    const failure = { type: 'server-response', rpcId: request['rpcId'], result: { ok: false, error: { code: 'native-test', message: 'exact native error', details: { actual: ['detail'] } } }, untouched: 9 };
    response.statusCode = server.requests.length === 1 ? 409 : 200;
    if (server.requests.length > 1) failure.rpcId = 'wrong-rpc-id';
    response.end(JSON.stringify(failure));
  });
  const frames: DshRpcObservation[] = [];
  const host = new DshHostClient(server.endpoint);
  try {
    const observer = (frame: DshRpcObservation) => { frames.push(frame); };
    await expect(host.rpc('commands/execute', args, observer)).rejects.toMatchObject({ code: 'native-test', details: { actual: ['detail'] } } satisfies Partial<DshRpcError>);
    expect(frames[1]?.frame).toMatchObject({ type: 'server-response', rpcId: frames[0]?.rpcId, result: { ok: false, error: { code: 'native-test', details: { actual: ['detail'] } } }, untouched: 9 });
    await expect(host.rpc('commands/execute', args, observer)).rejects.toThrow('身份或信封');
    expect(frames[3]).toMatchObject({ rpcId: frames[2]?.rpcId, frame: { rpcId: 'wrong-rpc-id' } });
    expect(server.requests).toHaveLength(2);
  } finally { await host.close(); await server.close(); }
});

it('emits only safe markers for invalid JSON and over-limit capture while keeping the HTTP result unchanged', async () => {
  const sensitive = 'raw-omitted-value';
  const server = await rpcServer((request, response) => {
    if (server.requests.length === 1) { response.statusCode = 502; response.end(`{invalid ${sensitive}`); return; }
    response.end(JSON.stringify({ type: 'server-response', rpcId: request['rpcId'], result: { ok: true, value: sensitive.repeat(200) } }));
  });
  const frames: DshRpcObservation[] = [];
  const host = new DshHostClient(server.endpoint, { maxRpcCaptureBytes: 300, onRpcFrame: frame => { frames.push(frame); } });
  try {
    await expect(host.rpc('commands/execute', args)).rejects.toThrow('非 JSON（HTTP 502）');
    expect(frames[1]).toMatchObject({ rpcId: frames[0]?.rpcId, httpStatus: 502, capture: { coverage: 'invalid-json' }, frame: { type: 'dsh-rpc-capture', coverage: 'invalid-json' } });
    expect(await host.rpc('commands/execute', args)).toBe(sensitive.repeat(200));
    expect(frames[3]).toMatchObject({ capture: { coverage: 'oversize', maxBytes: 300 }, frame: { type: 'dsh-rpc-capture', rpcId: frames[2]?.rpcId, coverage: 'oversize' } });
    expect(JSON.stringify([frames[1], frames[3]])).not.toMatch(/raw-omitted-value|hash|headers|cookie/i);
    expect(server.requests).toHaveLength(2);
  } finally { await host.close(); await server.close(); }
});

it('contains observer failures and does not retry an HTTP or connection failure', async () => {
  const server = await rpcServer((request, response) => {
    if (server.requests.length === 2) { response.destroy(); return; }
    response.statusCode = 503;
    response.end(JSON.stringify({ type: 'server-response', rpcId: request['rpcId'], result: { ok: true, value: 'business-value' } }));
  });
  const frames: DshRpcObservation[] = [];
  const host = new DshHostClient(server.endpoint, { onRpcFrame: async frame => { frames.push(frame); throw new Error('observer failed'); } });
  try {
    await expect(host.rpc('commands/execute', args, () => { throw new Error('sync observer failed'); })).rejects.toThrow('HTTP 503');
    expect(frames[1]?.frame).toMatchObject({ result: { value: 'business-value' } });
    await expect(host.rpc('commands/execute', args)).rejects.toThrow();
    expect(frames[3]).toMatchObject({ capture: { coverage: 'transport-error' }, frame: { type: 'dsh-rpc-capture' } });
    expect(server.requests).toHaveLength(2);
  } finally { await host.close(); await server.close(); }
});

it('admits the frozen actual request separately from observers and rejects before any POST', async () => {
  const server = await rpcServer((request, response) => { response.end(JSON.stringify({ type: 'server-response', rpcId: request['rpcId'], result: { ok: true, value: 'unchanged' } })); });
  const frames: DshRpcObservation[] = [];
  const host = new DshHostClient(server.endpoint, { onRpcFrame: frame => { frames.push(frame); } });
  try {
    await expect(host.rpc('commands/execute', args, undefined, request => {
      expect(request.frame).toMatchObject({ type: 'client-request', rpcId: request.rpcId, payload: { args } });
      expect(Object.isFrozen(request.frame)).toBe(true);
      return false;
    })).rejects.toMatchObject({ code: 'uncertain' });
    expect(server.requests).toHaveLength(0);
    expect(frames).toHaveLength(1);
    expect(await host.rpc('commands/execute', args, undefined, () => true)).toBe('unchanged');
    expect(server.requests).toHaveLength(1);
    expect(Object.isFrozen(args)).toBe(false);
    expect(Object.isFrozen(args.submittedAttachments)).toBe(false);
  } finally { await host.close(); await server.close(); }
});

type CallHarness = {
  call<T>(host: DshHostClient, endpoint: string, args: Record<string, unknown>, sessionId?: string, inputReference?: { fileIds: string[]; nativeRequestId?: string }): Promise<T>;
  nativeSinks: Map<string, NonNullable<CreateOpts['nativeEvents']>>;
  sessions: Map<string, { nativeId: string; envelopeId?: number }>;
  observedHost?: unknown;
};
function capturedAdapter(local: TraceFrame[], global: TraceFrame[]) {
  const replay = DshAdapter.replay('web-A');
  replay.feed({ i: 1, t: 0, dir: 'in', ch: 'mux:$events', frame: { value: { type: 'snapshot', header: { id: 'native-A' }, cursor: -1, records: [], hasMore: false } } });
  const harness = replay.adapter as unknown as CallHarness;
  harness.nativeSinks.set('web-A', { record: frame => { local.push(frame); return { envelopeId: local.length, accepted: true }; } });
  replay.adapter.bindGlobalNativeEvents({ record: frame => { global.push(frame); return { envelopeId: global.length, accepted: true }; } });
  harness.observedHost = { status: 'verified', fingerprint: 'actual-bootstrap-fingerprint' };
  return { adapter: replay.adapter, harness };
}
it('bridges real envelopes to the known Session and sends unknown/global requests to the independent Host sink', async () => {
  const server = await rpcServer((request, response) => { response.end(JSON.stringify({ type: 'server-response', rpcId: request['rpcId'], result: { ok: true, value: { native: 'value' } } })); });
  const local: TraceFrame[] = []; const global: TraceFrame[] = [];
  const { harness } = capturedAdapter(local, global);
  const host = new DshHostClient(server.endpoint);
  try {
    expect(await harness.call(host, 'commands/execute', args)).toEqual({ native: 'value' });
    const raw = local.filter(frame => frame.ch === 'rpc:commands/execute');
    expect(raw).toHaveLength(2);
    expect(raw[0]?.frame).toMatchObject({ frame: server.requests[0]?.envelope, dshTransport: { rpcId: server.requests[0]?.envelope['rpcId'], verifiedHostFingerprint: 'actual-bootstrap-fingerprint', hostEpoch: 0, muxGeneration: 0, coverage: 'complete' } });
    expect(raw[1]?.frame).toMatchObject({ frame: { type: 'server-response', rpcId: server.requests[0]?.envelope['rpcId'], result: { ok: true } }, dshTransport: { httpStatus: 200 } });
    expect(global).toHaveLength(0);
    await harness.call(host, 'commands/execute', { ...args, agentId: 'unassociated-native' });
    await harness.call(host, 'session/list', { _request: {} });
    expect(local.filter(frame => frame.ch.startsWith('rpc:'))).toHaveLength(2);
    expect(global.filter(frame => frame.ch.startsWith('rpc:'))).toHaveLength(4);
    expect(server.requests).toHaveLength(3);
  } finally { await host.close(); await server.close(); }
});

it('blocks the first global write when actual-envelope persistence refuses it', async () => {
  const server = await rpcServer((request, response) => { response.end(JSON.stringify({ type: 'server-response', rpcId: request['rpcId'], result: { ok: true, value: 'should never arrive' } })); });
  const local: TraceFrame[] = []; const global: TraceFrame[] = [];
  const { adapter, harness } = capturedAdapter(local, global);
  adapter.bindGlobalNativeEvents({ record: frame => { global.push(frame); return { envelopeId: global.length, accepted: !frame.ch.startsWith('rpc:') }; } });
  const host = new DshHostClient(server.endpoint);
  try {
    await expect(harness.call(host, 'commands/execute', { ...args, agentId: 'unknown' })).rejects.toMatchObject({ code: 'uncertain' });
    expect(global.filter(frame => frame.ch.startsWith('rpc:'))).toHaveLength(1);
    expect(server.requests).toHaveLength(0);
    await expect(harness.call(host, 'commands/execute', args)).rejects.toMatchObject({ code: 'uncertain' });
    expect(server.requests).toHaveLength(0);
  } finally { await host.close(); await server.close(); }
});

it('keeps the received native result when inbound capture fails and revokes subsequent writes', async () => {
  const server = await rpcServer((request, response) => { response.end(JSON.stringify({ type: 'server-response', rpcId: request['rpcId'], result: { ok: true, value: { received: 'native-result' } } })); });
  const local: TraceFrame[] = []; const global: TraceFrame[] = [];
  const { harness } = capturedAdapter(local, global);
  harness.nativeSinks.set('web-A', { record: frame => { local.push(frame); return { envelopeId: local.length, accepted: frame.dir !== 'in' }; } });
  const host = new DshHostClient(server.endpoint);
  try {
    expect(await harness.call(host, 'commands/execute', args)).toEqual({ received: 'native-result' });
    await expect(harness.call(host, 'commands/execute', args)).rejects.toMatchObject({ code: 'uncertain' });
    expect(server.requests).toHaveLength(1);
    expect(await harness.call(host, 'session/list', { _request: {} })).toEqual({ received: 'native-result' });
    expect(server.requests).toHaveLength(2);
  } finally { await host.close(); await server.close(); }
});

it('an ambiguous native id stays global and a delayed response cannot acquire a replacement Session owner', async () => {
  let finish: (() => void) | undefined;
  const server = await rpcServer((request, response) => {
    const reply = () => response.end(JSON.stringify({ type: 'server-response', rpcId: request['rpcId'], result: { ok: true, value: 'native-result' } }));
    if (server.requests.length === 1) reply(); else finish = reply;
  });
  const local: TraceFrame[] = []; const global: TraceFrame[] = []; const replacement: TraceFrame[] = [];
  const { harness } = capturedAdapter(local, global);
  const host = new DshHostClient(server.endpoint);
  try {
    harness.sessions.set('web-B', { nativeId: 'native-A' });
    await harness.call(host, 'commands/execute', args);
    expect(local).toHaveLength(0);
    expect(global.filter(frame => frame.ch.startsWith('rpc:'))).toHaveLength(2);
    harness.sessions.delete('web-B');
    const pending = harness.call(host, 'commands/execute', args);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const nextRuntime = { nativeId: 'native-A' };
    harness.sessions.set('web-A', nextRuntime);
    harness.nativeSinks.set('web-A', { record: frame => { replacement.push(frame); return { envelopeId: 999, accepted: true }; } });
    const release = finish!; finish = undefined; release();
    expect(await pending).toBe('native-result');
    expect(local.filter(frame => frame.ch.startsWith('rpc:'))).toHaveLength(2);
    expect(replacement).toHaveLength(0);
    expect(nextRuntime).not.toHaveProperty('envelopeId');
    expect(server.requests).toHaveLength(2);
  } finally { finish?.(); await host.close(); await server.close(); }
});

it('bounded capture keeps an explicitly persisted image reference without changing or blocking its native payload', async () => {
  const server = await rpcServer((request, response) => { response.end(JSON.stringify({ type: 'server-response', rpcId: request['rpcId'], result: { ok: true, value: 'native-result' } })); });
  const local: TraceFrame[] = []; const global: TraceFrame[] = []; const { harness } = capturedAdapter(local, global);
  const host = new DshHostClient(server.endpoint, { maxRpcCaptureBytes: 300 });
  const payload = { ...args, submittedAttachments: [{ type: 'image', mediaType: 'image/png', data: Buffer.alloc(1024, 1).toString('base64') }] };
  try {
    expect(await harness.call(host, 'commands/execute', payload, 'web-A', { fileIds: ['persisted-image'], nativeRequestId: 'durable-input-id' })).toBe('native-result');
    expect(server.requests[0]?.envelope['payload']).toEqual({ args: payload });
    const outgoing = local.find(frame => frame.ch === 'rpc:commands/execute' && frame.dir === 'out');
    expect(outgoing?.frame).toMatchObject({ frame: { type: 'dsh-rpc-capture', coverage: 'oversize' },
      inputReference: { fileIds: ['persisted-image'], nativeRequestId: 'durable-input-id' }, dshTransport: { coverage: 'oversize' } });
    expect(JSON.stringify(outgoing?.frame)).not.toContain(payload.submittedAttachments[0]!.data);
    expect(await harness.call(host, 'commands/execute', args, 'web-A')).toBe('native-result');
    expect(server.requests).toHaveLength(2);
  } finally { await host.close(); await server.close(); }
});
