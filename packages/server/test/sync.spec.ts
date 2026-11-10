import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage, StoredEvent } from '@webdcc/protocol';
import { createTestApp, seedWorkspaceAndSession, type TestApp } from './helpers.js';

let ctx: TestApp;
let port: number;

beforeAll(async () => {
  ctx = await createTestApp({ itemsPerTurn: 10_000, delayMs: 0 });
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const address = ctx.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('没有监听地址');
  port = address.port;
});

afterAll(async () => {
  await ctx.close();
});

interface Session {
  socket: WebSocket;
  send: (message: unknown) => void;
  close: () => Promise<void>;
}

async function connect(): Promise<Session> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { cookie: ctx.cookie } });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return {
    socket,
    send: (message) => socket.send(JSON.stringify(message)),
    close: () =>
      new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close();
      }),
  };
}

describe('A10 事件完整性（10,000 帧 + 20 次断线重连）', () => {
  it('客户端最终事件序列与数据库一致', async () => {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    const received = new Map<number, StoredEvent>();
    let duplicated = 0;
    let reconnects = 0;
    let turnDone = false;

    const onMessage = (message: ServerMessage): void => {
      if (message.op === 'event') {
        if (received.has(message.event.seq)) duplicated += 1;
        received.set(message.event.seq, message.event);
        if (message.event.kind === 'turn.completed') turnDone = true;
      }
      if (message.op === 'ping') return;
    };

    const lastSeq = (): number => Math.max(0, ...received.keys());
    let session = await connect();
    session.socket.on('message', (raw: Buffer) => onMessage(JSON.parse(raw.toString()) as ServerMessage));
    session.send({ op: 'hello', clientId: 'test-client', feedAfter: 0, subscribe: [{ sessionId, afterSeq: 0 }] });

    // 开始一轮大体量输出
    await ctx.manager.send(sessionId, { text: '产生一万帧' });

    // 每收到 500 条事件就断线重连一次，共 20 次
    const started = Date.now();
    while (reconnects < 20 && Date.now() - started < 60_000) {
      const target = (reconnects + 1) * 500;
      const waitStart = Date.now();
      while (received.size < target && Date.now() - waitStart < 10_000) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await session.close();
      reconnects += 1;
      session = await connect();
      session.socket.on('message', (raw: Buffer) => onMessage(JSON.parse(raw.toString()) as ServerMessage));
      session.send({ op: 'hello', clientId: 'test-client', feedAfter: 0, subscribe: [{ sessionId, afterSeq: lastSeq() }] });
    }

    // 等这一轮彻底结束
    const doneStart = Date.now();
    while (!turnDone && Date.now() - doneStart < 30_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await session.close();

    const final = await connect();
    final.socket.on('message', (raw: Buffer) => onMessage(JSON.parse(raw.toString()) as ServerMessage));
    final.send({ op: 'hello', clientId: 'test-client', feedAfter: 0, subscribe: [{ sessionId, afterSeq: lastSeq() }] });
    const sessionRow = ctx.store.getSession(sessionId);
    const finalWait = Date.now();
    while (received.size < (sessionRow?.lastSeq ?? 0) && Date.now() - finalWait < 20_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await final.close();

    const dbEvents = ctx.store.allEvents(sessionId);
    expect(turnDone).toBe(true);
    expect(reconnects).toBe(20);
    expect(duplicated).toBe(0);
    expect(received.size).toBe(dbEvents.length);

    // seq 连续、无空洞
    const seqs = [...received.keys()].sort((a, b) => a - b);
    seqs.forEach((seq, index) => expect(seq).toBe(index + 1));

    // 逐条与数据库一致
    for (const dbEvent of dbEvents) {
      const clientEvent = received.get(dbEvent.seq);
      expect(clientEvent, `seq ${dbEvent.seq}`).toBeDefined();
      expect(clientEvent?.kind).toBe(dbEvent.kind);
      expect(clientEvent?.itemKey).toBe(dbEvent.itemKey);
    }

    // 10,000 条 bulk 事件都在
    const bulk = dbEvents.filter((event) => event.itemKey.startsWith('bulk-'));
    expect(bulk.length).toBe(10_000);
  }, 120_000);

  it('侧边栏日志可以补差', async () => {
    const workspaces = ctx.store.listWorkspaces();
    expect(workspaces.length).toBeGreaterThan(0);
    const entries = ctx.store.feedSince(0, 1000);
    expect(entries.length).toBeGreaterThan(0);
    const cursor = entries[0]?.feedSeq ?? 0;
    const later = ctx.store.feedSince(cursor, 1000);
    expect(later.every((entry) => entry.feedSeq > cursor)).toBe(true);
  });
});
