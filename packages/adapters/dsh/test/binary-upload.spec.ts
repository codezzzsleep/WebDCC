import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { DshHostClient, type DshBinaryUploadObservation } from '../src/host.js';
import { DshAdapter } from '../src/adapter.js';
import type { DshResolvedAttachment } from '../src/input.js';
import type { CreateOpts, TraceFrame } from '@webdcc/protocol';

async function server(reply: (body: Buffer, response: ServerResponse) => void) {
  const requests: { body: Buffer; url?: string }[] = [];
  const http = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = Buffer.concat(chunks); requests.push({ body, url: request.url });
    reply(body, response);
  })().catch(() => response.destroy()); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address(); if (address === null || typeof address === 'string') throw new Error('Missing listener');
  return { endpoint: `http://127.0.0.1:${address.port}/prefix/`, requests,
    async close() { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); } };
}
it('native binary uploads preserve exact bytes and prefix while capture holds only a persisted file reference', async () => {
  const target = await server((body, response) => { response.end(JSON.stringify({ ok: true, value: { receiptId: 'native-receipt', file: { attachmentId: `sha256:${createHash('sha256').update(body).digest('hex')}`, name: 'proof file.bin', bytes: body.length } } })); });
  const host = new DshHostClient(target.endpoint); const frames: DshBinaryUploadObservation[] = [];
  const data = Buffer.from('original\r\n\0bytes'); const expected = Buffer.from(data);
  try {
    expect(await host.uploadFileBinary({ sessionId: 'native-A', fileId: 'saved-file', name: 'proof file.bin', data }, frame => {
      frames.push(frame); if (frame.dir === 'out') data.fill(9);
    }, () => true)).toMatchObject({ receiptId: 'native-receipt' });
    expect(target.requests[0]?.body).toEqual(expected);
    expect(target.requests[0]?.url).toBe('/prefix/api/session/uploadFileBinary?sessionId=native-A&name=proof+file.bin');
    expect(frames[0]).toMatchObject({ coverage: 'referenced', frame: { type: 'binary-upload-reference', fileId: 'saved-file', byteLength: expected.length } });
    expect(frames[1]).toMatchObject({ coverage: 'complete', frame: { ok: true, value: { receiptId: 'native-receipt' } } });
    expect(JSON.stringify(frames[0])).not.toMatch(/rpcId|original|cookie|headers|sha256/);
  } finally { await host.close(); await target.close(); }
});
it('HTTP 200 native upload errors and invalid JSON cannot become successful receipts', async () => {
  let count = 0;
  const target = await server((_body, response) => {
    if (++count === 1) response.end(JSON.stringify({ ok: false, error: { code: 'native-file-error', message: 'exact error', details: { reason: 'native' } } }));
    else response.end('{invalid private-omitted-bytes');
  });
  const frames: DshBinaryUploadObservation[] = []; const host = new DshHostClient(target.endpoint);
  try {
    const request = { sessionId: 'native-A', fileId: 'saved-file', data: Buffer.from('bytes') };
    await expect(host.uploadFileBinary(request, frame => { frames.push(frame); })).rejects.toMatchObject({ code: 'native-file-error', details: { reason: 'native' } });
    expect(frames[1]?.frame).toMatchObject({ ok: false, error: { code: 'native-file-error', details: { reason: 'native' } } });
    await expect(host.uploadFileBinary(request, frame => { frames.push(frame); })).rejects.toThrow('invalid JSON');
    expect(frames[3]).toMatchObject({ coverage: 'invalid-json' });
    expect(JSON.stringify(frames[3])).not.toMatch(/private-omitted-bytes|hash|cookie|headers/);
  } finally { await host.close(); await target.close(); }
});
it('failed binary admission prevents the HTTP POST', async () => {
  const target = await server((_body, response) => response.end('{}')); const host = new DshHostClient(target.endpoint);
  try {
    await expect(host.uploadFileBinary({ sessionId: 'native-A', fileId: 'saved-file', data: Buffer.from('bytes') }, undefined, () => false)).rejects.toMatchObject({ code: 'uncertain' });
    expect(target.requests).toHaveLength(0);
  } finally { await host.close(); await target.close(); }
});
it('a native receipt for different bytes rejects even when its byte count matches', async () => {
  const target = await server((body, response) => response.end(JSON.stringify({ ok: true, value: {
    receiptId: 'wrong-file-receipt', file: { attachmentId: `sha256:${'0'.repeat(64)}`, name: 'proof.bin', bytes: body.length },
  } })));
  const host = new DshHostClient(target.endpoint); const frames: DshBinaryUploadObservation[] = [];
  try {
    await expect(host.uploadFileBinary({ sessionId: 'native-A', fileId: 'saved-file', data: Buffer.from('exact bytes') }, frame => { frames.push(frame); })).rejects.toThrow('exact uploaded file');
    expect(frames[1]?.frame).toMatchObject({ ok: true, value: { receiptId: 'wrong-file-receipt' } });
    expect(target.requests).toHaveLength(1);
  } finally { await host.close(); await target.close(); }
});
it('an incomplete native upload capture preserves its received receipt and blocks the following prompt', async () => {
  const target = await server((body, response) => response.end(JSON.stringify({ ok: true, value: {
    receiptId: 'received-native-receipt', file: { attachmentId: `sha256:${createHash('sha256').update(body).digest('hex')}`, name: 'proof.bin', bytes: body.length },
  }, extension: 'x'.repeat(1024) })));
  const host = new DshHostClient(target.endpoint, { maxRpcCaptureBytes: 300 });
  const replay = DshAdapter.replay('A'); const frames: TraceFrame[] = [];
  const harness = replay.adapter as unknown as {
    sessions: Map<string, { nativeId: string }>;
    nativeSinks: Map<string, NonNullable<CreateOpts['nativeEvents']>>;
    uploadNativeFile(sessionId: string, runtime: unknown, client: DshHostClient, part: DshResolvedAttachment, bytes: Uint8Array): Promise<{ receiptId: string }>;
    call<T>(client: DshHostClient, endpoint: string, args: Record<string, unknown>, sessionId: string): Promise<T>;
  };
  const runtime = harness.sessions.get('A')!; runtime.nativeId = 'native-A';
  Object.assign(replay.adapter, { client: host, hostIdentity: async () => ({ status: 'verified', fingerprint: 'fixture-bootstrap' }) });
  harness.nativeSinks.set('A', { record: frame => { frames.push(frame); return { accepted: true, envelopeId: frames.length }; } });
  try {
    expect(await harness.uploadNativeFile('A', runtime, host, { type: 'file', fileId: 'saved-file', path: 'not-read', mime: 'application/octet-stream' }, Buffer.from('exact bytes'))).toMatchObject({ receiptId: 'received-native-receipt' });
    expect(frames[1]?.frame).toMatchObject({ dshUpload: { coverage: 'oversize' } });
    await expect(harness.call(host, 'session/prompt', { request: { requestId: 'input-id', sessionId: 'native-A', mode: 'queue', content: [{ type: 'file', receiptId: 'received-native-receipt' }] } }, 'A')).rejects.toMatchObject({ code: 'uncertain' });
    expect(target.requests).toHaveLength(1);
  } finally { await host.close(); await target.close(); }
});
