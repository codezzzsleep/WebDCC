import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

it('reorders an accepted queue using the observed version while retaining exact inputs and admission identities', async () => {
  const ctx = await createTestApp({ delayMs: 60000 });
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    for (const [id, text] of [['active', 'active'], ['B', '  B\r\n'], ['C', ' C ']]) {
      const result = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie },
        payload: { command: { op: 'send', clientCommandId: id, sessionId, text, intent: 'queue' } } });
      expect(result.json().ok).toBe(true);
    }
    const before = (await ctx.app.inject({ url: `/api/sessions/${sessionId}/queue`, headers: { cookie: ctx.cookie } })).json();
    const reordered = await ctx.app.inject({ method: 'PATCH', url: `/api/sessions/${sessionId}/queue`, headers: { cookie: ctx.cookie },
      payload: { commandIds: ['C', 'B'], expectedRevision: before.orderRevision ?? 'baseline-not-implemented' } });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().inputs.map((row: { commandId: string }) => row.commandId)).toEqual(['active', 'C', 'B']);
    expect(reordered.json().inputs.map(({ ordinal: _ordinal, ...row }: Record<string, unknown>) => row))
      .toEqual([before.inputs[0], before.inputs[2], before.inputs[1]].map(({ ordinal: _ordinal, ...row }: Record<string, unknown>) => row));
  } finally { await ctx.close(); }
}, 20000);

it('concurrent reorder requests reject stale, missing, duplicate and cross-session command sets', async () => {
  const ctx = await createTestApp();
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    const other = await seedWorkspaceAndSession(ctx);
    const seed = (id: string, session = sessionId) => {
      ctx.store.journal.claim({ op: 'send', clientCommandId: id, sessionId: session, text: id });
      ctx.store.journal.enqueue(id, session, `${id}-turn`, { text: id });
    };
    seed('B'); seed('C'); seed('other', other.sessionId);
    const before = ctx.store.queueSnapshot(sessionId);
    const patch = (commandIds: string[], expectedRevision = before.orderRevision) => ctx.app.inject({ method: 'PATCH',
      url: `/api/sessions/${sessionId}/queue`, headers: { cookie: ctx.cookie }, payload: { commandIds, expectedRevision } });
    for (const ids of [['B'], ['B', 'B'], ['B', 'other']]) expect((await patch(ids)).statusCode).toBe(409);
    const responses = await Promise.all(Array.from({ length: 100 }, () => patch(['C', 'B'])));
    expect(responses.filter(response => response.statusCode === 200)).toHaveLength(1);
    expect(responses.filter(response => response.statusCode === 409)).toHaveLength(99);
    expect(ctx.store.journal.next(sessionId)?.commandId).toBe('C');
    expect(ctx.store.journal.queue(other.sessionId).map(row => row.commandId)).toEqual(['other']);
    expect(ctx.store.queueSnapshot(sessionId).revision).toBeGreaterThan(before.revision);
    const fresh = ctx.store.queueSnapshot(sessionId);
    ctx.store.journal.beginInput('C-turn');
    expect((await patch(['B', 'C'], fresh.orderRevision)).statusCode).toBe(409);
    const uncertain = ctx.store.queueSnapshot(sessionId);
    ctx.store.journal.inputState('C-turn', 'uncertain');
    expect((await patch(['C', 'B'], uncertain.orderRevision)).statusCode).toBe(409);
    expect(ctx.store.journal.next(sessionId)).toBeUndefined();
    const cancelled = ctx.store.queueSnapshot(sessionId);
    ctx.store.journal.cancel(sessionId, 'B');
    expect((await patch(['B'], cancelled.orderRevision)).statusCode).toBe(409);
  } finally { await ctx.close(); }
});

it('rolls back ordinal swaps when the durable change notification cannot commit', async () => {
  const ctx = await createTestApp();
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    for (const id of ['B', 'C']) {
      ctx.store.journal.claim({ op: 'send', clientCommandId: id, sessionId, text: id });
      ctx.store.journal.enqueue(id, sessionId, `${id}-turn`, { text: id });
    }
    const before = ctx.store.queueSnapshot(sessionId);
    const append = ctx.store.appendFeed.bind(ctx.store);
    ctx.store.appendFeed = () => { throw new Error('controlled commit failure'); };
    await expect(ctx.manager.reorderQueuedInputs(sessionId, ['C', 'B'], before.orderRevision)).rejects.toThrow('controlled commit failure');
    ctx.store.appendFeed = append;
    expect(ctx.store.queueSnapshot(sessionId)).toEqual(before);
    expect(ctx.store.journal.queue(sessionId).every(row => row.ordinal > 0)).toBe(true);
  } finally { await ctx.close(); }
});

it('rejects an old order revision even after the queue is moved back to its original order', async () => {
  const ctx = await createTestApp();
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    for (const id of ['B', 'C']) {
      ctx.store.journal.claim({ op: 'send', clientCommandId: id, sessionId, text: id });
      ctx.store.journal.enqueue(id, sessionId, `${id}-turn`, { text: id });
    }
    const original = ctx.store.queueSnapshot(sessionId);
    await ctx.manager.reorderQueuedInputs(sessionId, ['C', 'B'], original.orderRevision);
    await ctx.manager.reorderQueuedInputs(sessionId, ['B', 'C'], ctx.store.queueSnapshot(sessionId).orderRevision);
    await expect(ctx.manager.reorderQueuedInputs(sessionId, ['C', 'B'], original.orderRevision)).rejects.toThrow('队列已变化');
  } finally { await ctx.close(); }
});

it('persists order, exact queue content and the observed revision across a database reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-queue-order-'));
  const dbPath = join(directory, 'test.db');
  let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
  try {
    ctx = await createTestApp({}, undefined, {}, { dbPath });
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    for (const id of ['B', 'C']) {
      ctx.store.journal.claim({ op: 'send', clientCommandId: id, sessionId, text: ` ${id}\r\n` });
      ctx.store.journal.enqueue(id, sessionId, `${id}-turn`, { text: ` ${id}\r\n`, contentParts: { version: 1,
        parts: [{ type: 'text', text: ` ${id}\r\n` }, { type: 'file', fileId: `${id}-fixture-file`, name: `${id}.txt` }] } });
    }
    const expected = await ctx.manager.reorderQueuedInputs(sessionId, ['C', 'B'], ctx.store.queueSnapshot(sessionId).orderRevision);
    await ctx.close(); ctx = undefined;
    ctx = await createTestApp({}, undefined, {}, { dbPath });
    const reopened = ctx.store.queueSnapshot(sessionId);
    expect(reopened.inputs).toEqual(expected.inputs);
    expect(reopened.orderRevision).toBe(expected.orderRevision);
    expect(reopened.revision).toBeGreaterThanOrEqual(expected.revision);
    expect(ctx.store.journal.next(sessionId)?.commandId).toBe('C');
    expect(ctx.store.journal.queue(sessionId).map(row => row.input.text)).toEqual([' C\r\n', ' B\r\n']);
  } finally { await ctx?.close(); await rm(directory, { recursive: true, force: true }); }
});

it('rejects reordering an input that is still queued while its attachment preparation is in flight', async () => {
  const ctx = await createTestApp({ delayMs: 60000 });
  let release = () => {};
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    ctx.store.journal.claim({ op: 'send', clientCommandId: 'C', sessionId, text: 'C' });
    ctx.store.journal.enqueue('C', sessionId, 'C-turn', { text: 'C' });
    const prepare = ctx.manager.prepareInput.bind(ctx.manager);
    let entered = false;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    ctx.manager.prepareInput = async (id, input, attach) => {
      const value = await prepare(id, input, attach);
      if (input.text === 'C' && attach === false) { entered = true; await barrier; }
      return value;
    };
    const sending = ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie },
      payload: { command: { op: 'send', clientCommandId: 'B', sessionId, text: 'B' } } });
    await expect.poll(() => entered).toBe(true);
    const snapshot = ctx.store.queueSnapshot(sessionId);
    expect(snapshot.inputs.map(row => row.state)).toEqual(['queued', 'queued']);
    const response = await ctx.app.inject({ method: 'PATCH', url: `/api/sessions/${sessionId}/queue`, headers: { cookie: ctx.cookie },
      payload: { commandIds: ['B', 'C'], expectedRevision: snapshot.orderRevision } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('正在准备发送');
    expect(ctx.store.queueSnapshot(sessionId)).toEqual(snapshot);
    release();
    expect((await sending).json().ok).toBe(true);
    expect(ctx.store.journal.queue(sessionId).map(row => row.commandId)).toEqual(['C', 'B']);
  } finally { release(); await ctx.close(); }
}, 20000);

it.each(['codex', 'claude-code', 'dsh'])('the controlled %s adapter receives the changed order without changing accepted input IDs', async agent => {
  const ctx = await createTestApp({ delayMs: 60000 });
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, agent);
    const adapter = ctx.manager.adapter(agent)!;
    const send = adapter.send.bind(adapter);
    const calls: { text: string; nativeRequestId?: string }[] = [];
    adapter.send = async (id, input) => { calls.push({ text: input.text, nativeRequestId: input.nativeRequestId }); await send(id, input); };
    for (const text of ['active', 'B', 'C']) await ctx.manager.send(sessionId, { text, delivery: 'queue' }, text);
    const before = ctx.store.queueSnapshot(sessionId);
    const activeId = calls[0]!.nativeRequestId;
    await ctx.manager.reorderQueuedInputs(sessionId, ['C', 'B'], before.orderRevision);
    expect(calls).toHaveLength(1);
    await ctx.manager.interrupt(sessionId);
    await expect.poll(() => calls.map(input => input.text)).toEqual(['active', 'C']);
    await ctx.manager.interrupt(sessionId);
    await expect.poll(() => calls.map(input => input.text)).toEqual(['active', 'C', 'B']);
    expect(calls[0]!.nativeRequestId).toBe(activeId);
    for (const call of calls) {
      expect(ctx.store.journal.nativeInput(sessionId, call.nativeRequestId!)?.commandId).toBe(call.text);
    }
  } finally { await ctx.close(); }
}, 20000);
