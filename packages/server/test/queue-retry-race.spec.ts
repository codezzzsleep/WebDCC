import { expect, it, vi } from 'vitest';
import { createTestApp, seedWorkspaceAndSession, TEST_TOKEN } from './helpers.js';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { UserInput } from '@webdcc/protocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.js';
import { CommandJournal } from '../src/command-journal.js';

async function queuedFixture(internal = false) {
  const ctx = await createTestApp(); const { sessionId } = await seedWorkspaceAndSession(ctx);
  const command = { op: 'send' as const, clientCommandId: 'queued-retry', sessionId, text: ' original queued\r\n', intent: 'queue' as const };
  if (!internal) ctx.store.journal.claim(command);
  const row = ctx.store.journal.enqueue(command.clientCommandId, sessionId, 'queued-turn', { text: command.text, delivery: 'queue' });
  ctx.store.journal.preparationError(row.turnId, 'controlled preparation error');
  return { ...ctx, sessionId, command, row: ctx.store.journal.queue(sessionId)[0]! };
}

it.each(['dispatching', 'native-accepted', 'uncertain', 'failed', 'completed', 'cancelled'] as const)('NP-03 retry cannot change a %s admission back to queued', async state => {
  const ctx = await queuedFixture();
  try {
    if (state === 'cancelled') ctx.store.journal.cancel(ctx.sessionId, ctx.command.clientCommandId);
    else ctx.store.journal.inputState(ctx.row.turnId, state);
    expect(() => ctx.store.retryQueuePreparation(ctx.row)).toThrow('已变化');
    expect(ctx.store.journal.get(ctx.command.clientCommandId)?.state).toBe(state);
    expect(ctx.store.journal.get(ctx.command.clientCommandId)?.turnId).toBe(ctx.row.turnId);
  } finally { await ctx.close(); }
});

it('NP-03 a changed command mapping rolls back preparation and queue notification', async () => {
  const ctx = await queuedFixture();
  try {
    ctx.store.journal.state(ctx.command.clientCommandId, 'uncertain'); const before = ctx.store.queueSnapshot(ctx.sessionId);
    expect(() => ctx.store.retryQueuePreparation(ctx.row)).toThrow('已变化');
    expect(ctx.store.queueSnapshot(ctx.sessionId)).toEqual(before);
    expect(ctx.store.journal.get(ctx.command.clientCommandId)?.state).toBe('uncertain');
  } finally { await ctx.close(); }
});

it('NP-03 notification failure rolls back the paired persistent retry updates', async () => {
  const ctx = await queuedFixture();
  try {
    ctx.store.journal.state(ctx.command.clientCommandId, 'queued', { ok: false, error: 'original preparation error' });
    const command = ctx.store.journal.get(ctx.command.clientCommandId); const snapshot = ctx.store.queueSnapshot(ctx.sessionId);
    vi.spyOn(ctx.store, 'appendFeed').mockImplementation(() => { throw new Error('controlled feed failure'); });
    expect(() => ctx.store.retryQueuePreparation(ctx.row)).toThrow('controlled feed failure');
    expect(ctx.store.journal.get(ctx.command.clientCommandId)).toEqual(command); expect(ctx.store.queueSnapshot(ctx.sessionId)).toEqual(snapshot);
  } finally { vi.restoreAllMocks(); await ctx.close(); }
});

it.each([false, true])('NP-03 a valid retry preserves queue content and supports internal=%s admissions', async internal => {
  const ctx = await queuedFixture(internal);
  try {
    ctx.store.retryQueuePreparation(ctx.row); const current = ctx.store.journal.queue(ctx.sessionId)[0]!;
    expect(current).toEqual({ ...ctx.row, preparationError: undefined });
    if (internal) expect(ctx.store.journal.get(ctx.command.clientCommandId)).toBeUndefined();
    else expect(ctx.store.journal.get(ctx.command.clientCommandId)).toMatchObject({ state: 'queued', turnId: ctx.row.turnId, result: { ok: true, value: { turnId: ctx.row.turnId, queued: true } } });
  } finally { await ctx.close(); }
});

it('NP-03 normal Manager retry admits the original input once with its persistent IDs', async () => {
  const ctx = await createTestApp();
  class CapturingAdapter extends FakeAdapter { readonly inputs: UserInput[] = []; override async send(_id: string, input: UserInput): Promise<void> { this.inputs.push(structuredClone(input)); } }
  const adapter = new CapturingAdapter(); ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx); const command = { op: 'send' as const, clientCommandId: 'normal-retry', sessionId, text: ' exact original\r\n', intent: 'queue' as const };
    ctx.store.journal.claim(command); const row = ctx.store.journal.enqueue(command.clientCommandId, sessionId, 'same-queued-turn', { text: command.text, delivery: 'queue' });
    ctx.store.journal.preparationError(row.turnId, 'controlled error');
    await ctx.manager.retryQueuedInput(sessionId, command.clientCommandId);
    expect(adapter.inputs).toHaveLength(1); expect(adapter.inputs[0]).toMatchObject({ text: command.text, nativeRequestId: ctx.store.journal.nativeRequestId(row.turnId) });
    expect(ctx.store.journal.get(command.clientCommandId)).toMatchObject({ turnId: row.turnId, state: 'native-accepted' });
  } finally { await ctx.close(); }
});

it.each(['turn', 'input', 'session'])('NP-03 a stale %s retry reference cannot mutate the accepted input', async kind => {
  const ctx = await queuedFixture();
  try {
    const before = ctx.store.queueSnapshot(ctx.sessionId);
    const expected = kind === 'turn' ? { ...ctx.row, turnId: 'different-turn' }
      : kind === 'input' ? { ...ctx.row, input: { ...ctx.row.input, text: 'changed text' } } : { ...ctx.row, sessionId: 'different-session' };
    expect(() => ctx.store.retryQueuePreparation(expected)).toThrow('已变化'); expect(ctx.store.queueSnapshot(ctx.sessionId)).toEqual(before);
  } finally { await ctx.close(); }
});

it('NP-03 a successfully retried queued preparation survives SQLite reopen with its original input and receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-retry-reopen-')); const path = join(root, 'queue.sqlite');
  const ctx = await createTestApp({}, TEST_TOKEN, {}, { dbPath: path });
  let sessionId: string; const commandId = 'persistent-retry'; let original: UserInput | undefined;
  try {
    ({ sessionId } = await seedWorkspaceAndSession(ctx));
    const command = { op: 'send' as const, clientCommandId: commandId, sessionId, text: ' unchanged persistent\r\n', intent: 'queue' as const };
    ctx.store.journal.claim(command); const row = ctx.store.journal.enqueue(commandId, sessionId, 'persistent-turn', { text: command.text, delivery: 'queue' }); original = row.input;
    ctx.store.journal.preparationError(row.turnId, 'controlled error'); ctx.store.retryQueuePreparation(ctx.store.journal.queue(sessionId)[0]!);
  } finally { await ctx.close(); }
  const db = openDb(path); const journal = new CommandJournal(db);
  try {
    expect(journal.queue(sessionId)[0]).toMatchObject({ commandId, turnId: 'persistent-turn', input: original, state: 'queued' });
    expect(journal.queue(sessionId)[0]?.preparationError).toBeUndefined();
    expect(journal.get(commandId)).toMatchObject({ state: 'queued', turnId: 'persistent-turn', result: { ok: true, value: { turnId: 'persistent-turn', queued: true } } });
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

it('NP-03 100 concurrent HTTP retries admit one original input and reject later changed states', async () => {
  const ctx = await createTestApp();
  class CapturingAdapter extends FakeAdapter { readonly inputs: UserInput[] = []; override async send(_id: string, input: UserInput): Promise<void> { this.inputs.push(structuredClone(input)); } }
  const adapter = new CapturingAdapter(); ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx); const command = { op: 'send' as const, clientCommandId: 'concurrent-retry', sessionId, text: 'original', intent: 'queue' as const };
    ctx.store.journal.claim(command); const row = ctx.store.journal.enqueue(command.clientCommandId, sessionId, 'same-turn', { text: command.text, delivery: 'queue' }); ctx.store.journal.preparationError(row.turnId, 'controlled error');
    const results = await Promise.all(Array.from({ length: 100 }, () => ctx.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/queue/${command.clientCommandId}/retry`, headers: { cookie: ctx.cookie } })));
    expect(results.filter(result => result.statusCode === 200)).toHaveLength(1); expect(results.filter(result => result.statusCode === 409)).toHaveLength(99);
    expect(adapter.inputs).toHaveLength(1); expect(adapter.inputs[0]).toMatchObject({ text: command.text, nativeRequestId: ctx.store.journal.nativeRequestId(row.turnId) });
  } finally { await ctx.close(); }
});

it('NP-03 an acknowledged cancellation wins over a retry still validating its queued input', async () => {
  const ctx = await createTestApp(); let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const reached = new Promise<void>(resolve => { entered = resolve; });
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    const command = { op: 'send' as const, clientCommandId: 'retry-race', sessionId, text: ' original queued\r\n', intent: 'queue' as const };
    ctx.store.journal.claim(command); const row = ctx.store.journal.enqueue(command.clientCommandId, sessionId, 'queued-turn', { text: command.text, delivery: 'queue' });
    ctx.store.journal.preparationError(row.turnId, 'controlled validation failure');
    const original = ctx.manager.prepareInput.bind(ctx.manager);
    vi.spyOn(ctx.manager, 'prepareInput').mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
    const retry = ctx.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/queue/${command.clientCommandId}/retry`, headers: { cookie: ctx.cookie } }).then(value => value);
    await reached;
    const cancel = await ctx.app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/queue/${command.clientCommandId}`, headers: { cookie: ctx.cookie } });
    expect(cancel.statusCode).toBe(204); expect(ctx.store.journal.get(command.clientCommandId)?.state).toBe('cancelled');
    release(); const retried = await retry;
    expect(retried.statusCode).toBe(409); expect(ctx.store.journal.get(command.clientCommandId)?.state).toBe('cancelled');
    expect(ctx.store.journal.queue(sessionId)).toEqual([]); expect(ctx.store.allEvents(sessionId).some(event => event.kind === 'user.message')).toBe(false);
  } finally { release(); vi.restoreAllMocks(); await ctx.close(); }
});
