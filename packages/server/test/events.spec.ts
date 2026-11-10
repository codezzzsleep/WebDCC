import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredEvent } from '@webdcc/protocol';
import { createTestApp, seedWorkspaceAndSession, type TestApp } from './helpers.js';

let ctx: TestApp;

beforeAll(async () => {
  ctx = await createTestApp({ injectUnknown: true, injectInternal: true });
});

afterAll(async () => {
  await ctx.close();
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('事件存储', () => {
  it('seq 连续、无空洞，事件顺序与写入顺序一致', async () => {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    await ctx.manager.send(sessionId, { text: '你好' });
    await waitFor(() => ctx.store.listEvents(sessionId, { limit: 500 }).some((event) => event.kind === 'turn.completed'));

    const events = ctx.store.allEvents(sessionId);
    expect(events.length).toBeGreaterThan(3);
    events.forEach((event, index) => expect(event.seq).toBe(index + 1));
    expect(events[0]?.kind).toBe('user.message');
    expect(events.at(-1)?.kind).toBe('turn.completed');
  });

  it('A11 未知事件以 unknown 保留原始帧', async () => {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    await ctx.manager.send(sessionId, { text: '来一个未知事件' });
    await waitFor(() => ctx.store.listEvents(sessionId, { limit: 500 }).some((event) => event.kind === 'turn.completed'));
    const unknown = ctx.store.allEvents(sessionId).find((event) => event.kind === 'unknown');
    expect(unknown).toBeDefined();
    expect((unknown?.data as { nativeType: string }).nativeType).toBe('fake/unknown-event');
    expect(unknown?.native).toMatchObject({ type: 'fake/unknown-event' });
  });

  it('内部事件以 internal 存储', async () => {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    await ctx.manager.send(sessionId, { text: '来一个内部事件' });
    await waitFor(() => ctx.store.listEvents(sessionId, { limit: 500 }).some((event) => event.kind === 'turn.completed'));
    const internal = ctx.store.allEvents(sessionId).find((event) => event.kind === 'internal');
    expect(internal).toBeDefined();
  });

  it('分页查询按 before/after 工作', async () => {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    await ctx.manager.send(sessionId, { text: '分页' });
    await waitFor(() => ctx.store.listEvents(sessionId, { limit: 500 }).some((event) => event.kind === 'turn.completed'));
    const all = ctx.store.allEvents(sessionId);
    const after = ctx.store.listEvents(sessionId, { after: all[1]?.seq ?? 0, limit: 2 });
    expect(after.length).toBe(2);
    expect(after[0]?.seq).toBe((all[1]?.seq ?? 0) + 1);
    const before = ctx.store.listEvents(sessionId, { before: all[2]?.seq ?? 1, limit: 10 });
    expect(before.every((event) => event.seq < (all[2]?.seq ?? 1))).toBe(true);
  });

  it('同一 clientCommandId 的命令只执行一次', async () => {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    const command = { op: 'send' as const, sessionId, text: '只发一次', clientCommandId: 'CMD-DEDUPE-1' };
    const first = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    const second = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    await waitFor(() => ctx.store.listEvents(sessionId, { limit: 500 }).some((event) => event.kind === 'turn.completed'));
    const users = ctx.store.allEvents(sessionId).filter((event) => event.kind === 'user.message');
    expect(users).toHaveLength(1);
  });

  it('导出返回 JSONL', async () => {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    await ctx.manager.send(sessionId, { text: '导出' });
    await waitFor(() => ctx.store.listEvents(sessionId, { limit: 500 }).some((event) => event.kind === 'turn.completed'));
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/export`,
      headers: { cookie: ctx.cookie },
    });
    expect(response.statusCode).toBe(200);
    const lines = response.body.trim().split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      const parsed = JSON.parse(line) as StoredEvent;
      expect(parsed.sessionId).toBe(sessionId);
    }
  });
});
