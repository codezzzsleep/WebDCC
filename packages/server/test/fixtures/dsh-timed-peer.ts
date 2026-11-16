/** Controlled native HTTP/mux producer. This fixture never executes an Agent or Provider. */
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DshHostClient, StreamFrame } from '../../../adapters/dsh/src/host.js';
import type { TestApp } from '../helpers.js';
import { bindDshQuestionFixture } from './dsh-question.js';

export async function bindDshTimedPeer(ctx: Pick<TestApp, 'store' | 'manager' | 'dataDir'>, remainingMs = 6000) {
  const base = bindDshQuestionFixture(ctx);
  const calls: { endpoint: string; args: Record<string, unknown> }[] = [];
  const waits = new Map<string, WebSocket>();
  let seq = 0; let lastCallId = 'timed-call';
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { rpcId: string; method: string; payload: { args: Record<string, unknown> } };
      calls.push({ endpoint: body.method, args: body.payload.args });
      let value: unknown;
      if (body.method === 'userQuestions/answer') value = true;
      else if (body.method === 'session/projections') value = { kind: 'sequenced', asOfSeq: seq, values: { subagentCatalog: [] } };
      else if (body.method === 'session/state') value = { cursor: seq, active: true, running: false, pendingInput: [], queue: null };
      else if (body.method === 'commands/list') value = { commands: [] };
      else if (body.method === 'session/modelCatalog') value = { groups: [] };
      else if (body.method !== '$events/result') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: {
          code: 'fixture-read-unavailable', message: 'This controlled peer only provides the timed-question contract.',
        } } })); return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, ...(value === undefined ? {} : { value }) } }));
    })().catch(error => { response.writeHead(500); response.end(String(error)); });
  });
  const mux = new WebSocketServer({ server });
  mux.on('connection', socket => {
    socket.on('message', input => {
      const frame = JSON.parse(input.toString()) as { type: string; streamId: string; endpoint?: string };
      if (frame.type === 'open') {
        if (frame.endpoint !== 'userQuestions/attachWait') {
          socket.send(JSON.stringify({ type: 'error', streamId: frame.streamId, error: { code: 'fixture-read-unavailable', message: 'Snapshot outside the timed-question fixture scope.' } })); return;
        }
        waits.set(frame.streamId, socket);
        socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { remainingMs } }));
      } else if (frame.type === 'cancel') waits.delete(frame.streamId);
    });
    socket.on('close', () => { for (const [id, owner] of waits) if (owner === socket) waits.delete(id); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('timed fixture listener missing');
  const url = `http://127.0.0.1:${address.port}/`;
  const client = (base.native.adapter as unknown as { newHost(endpoint: string): DshHostClient }).newHost(url);
  Object.assign(base.native.adapter, { client });
  base.native.adapter.hostIdentity = async () => ({ url, source: 'native-bootstrap', status: 'verified', version: '0.2.2-rc.1',
    fingerprint: 'f'.repeat(64), profile: { scope: 'current-host-profile', identity: 'unavailable-in-api' } });
  await client.connect();
  base.feed({ type: 'ready', clientId: 'timed-native-client' });
  const event = (type: string, data: unknown) => base.feed({ type: 'event', event: { type, seq: ++seq, time: Date.now(), data } });
  const endWaits = () => {
    for (const [streamId, socket] of waits) socket.send(JSON.stringify({ type: 'end', streamId } satisfies StreamFrame));
    waits.clear();
  };
  return { ...base, client, calls, waits,
    ask(callId = 'timed-call', eventId = 'timed-waterfall') {
      lastCallId = callId;
      const questions = [{ id: 'one', question: 'Native timed choice', options: [{ label: 'Original label' }, { label: 'Other label' }] }];
      event('tool/call', { callId, name: 'ask_user_question', arguments: JSON.stringify({ questions, timeout: Math.ceil(remainingMs / 1000) }) });
      base.feed({ type: 'waterfall', event: 'user-questions/request', agentId: 'native-question-root', eventId,
        request: { questions, wait: { callId, timed: true } } });
      return `${eventId}:one`;
    },
    continued() {
      event('tool/result', { message: { toolCallId: lastCallId, isError: false, content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: lastCallId }) }] } });
      base.feed({ type: 'cancel', eventId: 'timed-waterfall' }); endWaits();
    },
    answered(selected = ['Original label'], custom?: string) {
      base.feed({ type: 'projection', seq: ++seq, changes: [{ key: 'userQuestions', val: { active: [], settled: [
        { callId: lastCallId, answers: [{ id: 'one', selected, ...(custom === undefined ? {} : { custom }) }] },
      ] } }] }); endWaits();
    },
    disconnectNative() { for (const socket of mux.clients) socket.terminate(); },
    async closePeer() {
      await base.native.adapter.shutdown(); await client.close();
      for (const socket of mux.clients) socket.terminate();
      await new Promise<void>(resolve => mux.close(() => resolve()));
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
