import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Command } from '@webdcc/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { CommandJournal } from '../src/command-journal.js';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

it.each(['dsh', 'codex', 'claude-code'].flatMap(agent => [false, true].map(reject => ({ agent, reject }))))('keeps $agent cancellation after preparation (reject=$reject) and database reopens', async ({ agent, reject }) => {
  const scratch = await mkdtemp(join(tmpdir(), 'wdcc-send-cancel-'));
  const dbPath = join(scratch, 'state.db');
  const ctx = await createTestApp({}, undefined, {}, { dbPath });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  let closed = false;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, agent);
    const original = ctx.manager.prepareInput.bind(ctx.manager);
    let preparations = 0;
    ctx.manager.prepareInput = async (...args) => {
      if (++preparations === 3) {
        entered(); await gate;
        if (reject) throw Object.assign(new Error('input rejected before submission'), { statusCode: 400 });
      }
      return original(...args);
    };
    let nativeSends = 0;
    ctx.manager.adapter(agent)!.send = async () => { nativeSends++; };
    const command: Command = { op: 'send', clientCommandId: 'cancel-during-send', sessionId, text: '  original\r\ntext  ', intent: 'send' };
    const request = () => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    const sending = request().then(response => response);
    await reached;
    const queued = ctx.store.journal.queue(sessionId)[0]!;
    const cancelled = await ctx.app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/queue/${command.clientCommandId}`, headers: { cookie: ctx.cookie } });
    expect(cancelled.statusCode).toBe(204);
    expect(ctx.store.journal.get(command.clientCommandId)?.state).toBe('cancelled');
    release();
    const response = await sending;
    expect(response.statusCode).toBe(reject ? 200 : 409);
    expect(response.json()).toMatchObject({ ok: false, code: reject ? 'bad-request' : 'conflict' });
    expect(ctx.store.journal.get(command.clientCommandId)).toMatchObject({ state: 'cancelled', turnId: queued.turnId, payload: command, result: response.json() });
    const receipt = await ctx.app.inject({ method: 'GET', url: `/api/commands/${command.clientCommandId}`, headers: { cookie: ctx.cookie } });
    expect(receipt.json()).toMatchObject({ state: 'cancelled', result: response.json() });
    expect((await request()).body).toBe(response.body);
    expect(preparations).toBe(3);
    expect(nativeSends).toBe(0);
    expect(ctx.store.journal.queue(sessionId)).toEqual([]);
    expect(ctx.store.allEvents(sessionId).filter(event => ['user.message', 'turn.started'].includes(event.kind))).toEqual([]);
    expect(() => ctx.store.journal.nativeRequestId(queued.turnId)).toThrow('原生输入身份尚未持久化');
    const changed = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: { ...command, text: 'changed' } } });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: 'command-conflict' });
    await ctx.close(); closed = true;
    const db = openDb(dbPath);
    try {
      const store = new Store(db);
      expect(store.journal.get(command.clientCommandId)).toMatchObject({ state: 'cancelled', result: response.json(), payload: command, turnId: queued.turnId });
      expect(db.prepare('SELECT state, input FROM input_queue WHERE command_id = ?').get(command.clientCommandId)).toMatchObject({ state: 'cancelled', input: JSON.stringify(queued.input) });
      expect(store.journal.queue(sessionId)).toEqual([]);
    } finally { db.close(); }
  } finally {
    release();
    if (!closed) await ctx.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

it('retains newer input admission and terminal state committed by a second SQLite connection', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'wdcc-send-result-race-'));
  const dbPath = join(scratch, 'state.db');
  const ctx = await createTestApp({}, undefined, {}, { dbPath });
  const otherDb = openDb(dbPath);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    const other = new CommandJournal(otherDb);
    for (const state of ['dispatching', 'native-accepted', 'completed', 'failed', 'cancelled', 'uncertain'] as const) {
      const command: Command = { op: 'send', clientCommandId: `late-${state}`, sessionId, text: '  original text  ' };
      const turnId = `turn-${state}`;
      ctx.store.journal.claim(command);
      ctx.store.journal.enqueue(command.clientCommandId, sessionId, turnId, { text: command.text });
      const observedState = ctx.store.journal.get(command.clientCommandId)!.state;
      other.inputState(turnId, state);
      const receipt = { ok: false, code: 'conflict' };
      expect(ctx.store.journal.settleSendResult(command.clientCommandId, observedState, 'failed', receipt)).toEqual(receipt);
      expect(ctx.store.journal.get(command.clientCommandId)).toMatchObject({ state, turnId, payload: command, result: receipt });
      expect(otherDb.prepare('SELECT state, input FROM input_queue WHERE turn_id = ?').get(turnId)).toEqual({ state, input: JSON.stringify({ text: command.text }) });
    }
  } finally {
    otherDb.close(); await ctx.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

it('keeps the first terminal receipt through late success, failure and database write rejection', async () => {
  const ctx = await createTestApp();
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    for (const state of ['completed', 'failed', 'cancelled', 'uncertain'] as const) {
      const command: Command = { op: 'send', clientCommandId: state, sessionId, text: 'original' };
      ctx.store.journal.claim(command);
      const original = { ok: state === 'completed', value: { state, identity: 'first-receipt' } };
      ctx.store.journal.state(state, state, original);
      for (const late of [{ ok: true }, { ok: false, code: 'uncertain' }]) {
        expect(ctx.store.journal.settleSendResult(state, state, late.ok ? 'completed' : 'failed', late)).toEqual(original);
        expect(ctx.store.journal.get(state)).toMatchObject({ state, result: original });
      }
    }
    const scratch = await mkdtemp(join(tmpdir(), 'wdcc-result-rollback-'));
    const db = openDb(join(scratch, 'state.db'));
    try {
      const journal = new CommandJournal(db);
      journal.claim({ op: 'send', clientCommandId: 'rollback', sessionId, text: 'original' });
      db.exec("CREATE TRIGGER reject_result BEFORE UPDATE ON command_journal BEGIN SELECT RAISE(ABORT, 'controlled-write-failure'); END");
      expect(() => journal.settleSendResult('rollback', 'received', 'completed', { ok: true })).toThrow('controlled-write-failure');
      expect(journal.get('rollback')).toMatchObject({ state: 'received' });
      expect(journal.get('rollback')?.result).toBeUndefined();
    } finally { db.close(); await rm(scratch, { recursive: true, force: true }); }
  } finally { await ctx.close(); }
});
