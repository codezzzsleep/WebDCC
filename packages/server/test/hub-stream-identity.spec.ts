import { once } from 'node:events';
import { expect, it } from 'vitest';
import WebSocket from 'ws';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent, ServerMessage } from '@webdcc/protocol';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

async function wireFixture() {
  const ctx = await createTestApp();
  const adapter = new FakeAdapter({ id: 'codex' });
  let receive!: (sessionId: string, event: AdapterEvent) => void;
  adapter.onEvent = callback => { receive = callback; }; adapter.send = async () => undefined;
  ctx.manager.registerAdapter(adapter);
  const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
  const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(address.replace('http:', 'ws:') + '/api/ws', { headers: { cookie: ctx.cookie } });
  const received: ServerMessage[] = [];
  socket.on('message', data => received.push(JSON.parse(data.toString()) as ServerMessage));
  await once(socket, 'open');
  socket.send(JSON.stringify({ op: 'hello', clientId: 'stream-identity', feedAfter: 0, subscribe: [{ sessionId, afterSeq: 0 }] }));
  await expect.poll(() => received.some(message => message.op === 'snapshot'), { timeout: 2000 }).toBe(true);
  received.length = 0;
  return { ...ctx, sessionId, received, emit: (event: AdapterEvent) => receive(sessionId, event),
    async close() { const closed = once(socket, 'close'); socket.close(); await closed; await ctx.close(); } };
}

it('real WS sends distinct turn identity for equal item keys queued within one delta flush', async () => {
  const ctx = await wireFixture();
  try {
    const first = await ctx.manager.send(ctx.sessionId, { text: 'First' });
    ctx.emit({ type: 'turn.start', nativeTurnId: 'a' });
    ctx.emit({ type: 'item.start', nativeTurnId: 'a', itemKey: 'shared', kind: 'assistant.message', data: { text: '' } });
    ctx.emit({ type: 'item.delta', nativeTurnId: 'a', itemKey: 'shared', field: 'text', append: 'A' });
    ctx.emit({ type: 'turn.end', nativeTurnId: 'a', status: 'interrupted' });
    const second = await ctx.manager.send(ctx.sessionId, { text: 'Second' });
    ctx.emit({ type: 'turn.start', nativeTurnId: 'b' });
    ctx.emit({ type: 'item.start', nativeTurnId: 'b', itemKey: 'shared', kind: 'assistant.message', data: { text: '' } });
    ctx.emit({ type: 'item.delta', nativeTurnId: 'b', itemKey: 'shared', field: 'text', append: 'B' });
    await expect.poll(() => ctx.received.filter(message => message.op === 'delta').length, { timeout: 2000 }).toBe(2);
    const deltas = ctx.received.filter(message => message.op === 'delta');
    expect(deltas).toEqual([
      { op: 'delta', sessionId: ctx.sessionId, turnId: first.turnId, itemKey: 'shared', field: 'text', append: 'A' },
      { op: 'delta', sessionId: ctx.sessionId, turnId: second.turnId, itemKey: 'shared', field: 'text', append: 'B' },
    ]);
  } finally { await ctx.close(); }
});

it('buffered deltas are delivered before an authoritative item update', async () => {
  const ctx = await wireFixture();
  try {
    const turn = await ctx.manager.send(ctx.sessionId, { text: 'First' });
    ctx.emit({ type: 'turn.start', nativeTurnId: 'a' });
    ctx.emit({ type: 'item.start', nativeTurnId: 'a', itemKey: 'shared', kind: 'assistant.message', data: { text: '' } });
    ctx.emit({ type: 'item.delta', nativeTurnId: 'a', itemKey: 'shared', field: 'text', append: 'partial' });
    ctx.emit({ type: 'item.update', nativeTurnId: 'a', itemKey: 'shared', data: { text: 'authoritative snapshot' } });
    await expect.poll(() => ctx.received.some(message => message.op === 'delta'), { timeout: 2000 }).toBe(true);
    const relevant = ctx.received.filter(message => message.op === 'delta' || message.op === 'update' && !(message.data as { started?: boolean }).started);
    expect(relevant).toEqual([
      { op: 'delta', sessionId: ctx.sessionId, turnId: turn.turnId, itemKey: 'shared', field: 'text', append: 'partial' },
      { op: 'update', sessionId: ctx.sessionId, turnId: turn.turnId, itemKey: 'shared', data: { text: 'authoritative snapshot' } },
    ]);
  } finally { await ctx.close(); }
});
