import { expect, it } from 'vitest';
import type { AdapterEvent, AgentId } from '@webdcc/protocol';
import { FakeAdapter } from '@webdcc/fake-adapter';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db.js';
import { CommandJournal } from '../src/command-journal.js';
import { Store } from '../src/store.js';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

function journalFixture(db: Db) {
  const store = new Store(db);
  const workspace = store.createWorkspace('admission', '/tmp');
  const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
  return { journal: store.journal, sessionId: session.id };
}

it.each(['codex', 'claude-code', 'dsh'] as const)('late %s send success preserves uncertainty after native autonomous continuation', async agent => {
  const ctx = await createTestApp();
  const adapter = new FakeAdapter({ id: agent });
  let emit!: (sessionId: string, event: AdapterEvent) => void;
  adapter.onEvent = callback => { emit = callback; };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  adapter.send = async (sessionId, input) => {
    sends++;
    expect(input.text).toBe(' original\r\n');
    emit(sessionId, { type: 'turn.start', nativeTurnId: 'native-A' });
    emit(sessionId, { type: 'turn.start', nativeTurnId: 'native-B' });
    await gate;
  };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, agent);
    const command = { op: 'send', clientCommandId: 'late-send', sessionId, text: ' original\r\n' };
    const responses = Promise.all(Array.from({ length: 100 }, () => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } })));
    await expect.poll(() => ctx.store.journal.get(command.clientCommandId)?.state).toBe('uncertain');
    const admission = ctx.store.journal.queue(sessionId)[0]!;
    const requestId = ctx.store.journal.nativeRequestId(admission.turnId);
    const nextTurn = ctx.manager.getRuntime(sessionId)!.turnId;
    expect(nextTurn).not.toBe(admission.turnId);
    release();
    const received = await responses;
    expect(received.every(response => response.statusCode === 200)).toBe(true);
    expect(new Set(received.map(response => response.body)).size).toBe(1);
    expect(ctx.store.journal.get(command.clientCommandId)?.state).toBe('uncertain');
    expect(ctx.store.journal.queue(sessionId)[0]).toEqual(admission);
    expect(ctx.store.journal.nativeRequestId(admission.turnId)).toBe(requestId);
    expect(ctx.manager.getRuntime(sessionId)?.turnId).toBe(nextTurn);
    const conflicting = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: { ...command, text: 'different input' } } });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({ code: 'command-conflict' });
    const blocked = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie },
      payload: { command: { ...command, clientCommandId: 'new-send', intent: 'queue' } } });
    expect(blocked.statusCode).toBe(409);
    expect(sends).toBe(1);
  } finally { release(); await ctx.close(); }
});

it.each(['uncertain', 'completed', 'failed', 'cancelled'] as const)('late steer success preserves an admission already marked %s', async state => {
  const ctx = await createTestApp();
  const agent: AgentId = 'codex';
  const adapter = new FakeAdapter({ id: agent });
  let emit!: (sessionId: string, event: AdapterEvent) => void;
  adapter.onEvent = callback => { emit = callback; };
  adapter.send = async sessionId => { emit(sessionId, { type: 'turn.start', nativeTurnId: 'native-active' }); };
  let admissionTurnId!: string;
  adapter.steer = async (sessionId, input) => {
    const admission = ctx.store.journal.nativeInputRecord(sessionId, input.nativeRequestId!)!;
    admissionTurnId = admission.admissionTurnId;
    ctx.store.journal.inputState(admissionTurnId, state);
  };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, agent);
    const active = await ctx.manager.send(sessionId, { text: 'active' });
    const command = { op: 'send', clientCommandId: 'late-steer', sessionId, text: 'steer', intent: 'steer', expectedTurnId: active.turnId };
    const response = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    expect(response.statusCode).toBe(200);
    expect(ctx.store.journal.get(command.clientCommandId)).toMatchObject({ state, turnId: admissionTurnId });
    const dbRow = ctx.store.journal.nativeInputRecord(sessionId, ctx.store.journal.nativeRequestId(admissionTurnId));
    expect(dbRow).toMatchObject({ commandId: command.clientCommandId, turnId: active.turnId, admissionTurnId, input: { text: 'steer' }, steered: true });
  } finally { await ctx.close(); }
});

it('atomic native acceptance preserves input bytes, attachment references, IDs and the first receipt across database reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-admission-'));
  const path = join(directory, 'state.db');
  let db = openDb(path);
  const second = openDb(path);
  try {
    const { journal, sessionId } = journalFixture(db);
    const other = new CommandJournal(second);
    const command = { op: 'send' as const, clientCommandId: 'admission', sessionId, text: ' original\r\n' };
    const input = { text: command.text, images: [{ fileId: 'original-file', path: '/derived/file.png', mime: 'image/png' }] };
    journal.claim(command);
    const receipt = { ok: true, value: { turnId: 'turn', queued: true } };
    const accepted = journal.enqueue(command.clientCommandId, command.sessionId, 'turn', input);
    journal.state(command.clientCommandId, 'queued', receipt);
    expect(journal.acceptInput('turn')).toBe(false);
    expect(journal.beginInput('turn')).toBe(true);
    const requestId = journal.nativeRequestId('turn');
    expect(other.acceptInput('turn')).toBe(true);
    expect(journal.acceptInput('turn')).toBe(false);
    expect(journal.get(command.clientCommandId)).toMatchObject({ state: 'native-accepted', result: receipt, payload: command });
    expect(journal.queue(command.sessionId)).toEqual([{ ...accepted, state: 'native-accepted' }]);
    db.close(); db = openDb(path);
    const reopened = new CommandJournal(db);
    expect(reopened.nativeRequestId('turn')).toBe(requestId);
    expect(reopened.get(command.clientCommandId)).toMatchObject({ state: 'native-accepted', result: receipt, payload: command });
    expect(reopened.queue(command.sessionId)).toEqual([{ ...accepted, state: 'native-accepted' }]);
    reopened.recover([command.sessionId]);
    expect(other.acceptInput('turn')).toBe(false);
    expect(reopened.get(command.clientCommandId)).toMatchObject({ state: 'uncertain', result: receipt });
    expect(reopened.next(command.sessionId)).toBeUndefined();
  } finally { second.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

it.each(['uncertain', 'completed', 'failed', 'cancelled', 'queued', 'native-accepted'] as const)('late admission does not override %s committed by a second SQLite connection', async state => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-admission-state-'));
  const path = join(directory, 'state.db');
  const db = openDb(path); const second = openDb(path);
  try {
    const { journal, sessionId } = journalFixture(db); const other = new CommandJournal(second);
    journal.claim({ op: 'send', clientCommandId: 'admission', sessionId, text: 'kept' });
    journal.enqueue('admission', sessionId, 'turn', { text: 'kept' });
    journal.beginInput('turn');
    other.inputState('turn', state);
    const before = journal.get('admission'); const queue = journal.queue(sessionId);
    expect(journal.acceptInput('turn')).toBe(false);
    expect(journal.get('admission')).toEqual(before);
    expect(journal.queue(sessionId)).toEqual(queue);
    expect(second.prepare('SELECT state FROM input_queue WHERE turn_id = ?').get('turn')).toEqual({ state });
  } finally { second.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

it.each(['state', 'session', 'turn'] as const)('native acceptance does not partially change an admission with a mismatched command %s', field => {
  const db = openDb(':memory:');
  try {
    const { journal, sessionId } = journalFixture(db);
    journal.claim({ op: 'send', clientCommandId: 'admission', sessionId, text: 'kept' });
    journal.enqueue('admission', sessionId, 'turn', { text: 'kept' }); journal.beginInput('turn');
    if (field === 'state') journal.state('admission', 'uncertain', { ok: false, code: 'uncertain' });
    else db.prepare(`UPDATE command_journal SET ${field === 'session' ? 'session_id' : 'turn_id'} = ? WHERE command_id = ?`).run('other', 'admission');
    const before = journal.get('admission'); const queue = journal.queue(sessionId);
    expect(journal.acceptInput('turn')).toBe(false);
    expect(journal.get('admission')).toEqual(before); expect(journal.queue(sessionId)).toEqual(queue);
  } finally { db.close(); }
});

it('native acceptance rolls back both rows on a command write failure and supports internal admissions', () => {
  const db = openDb(':memory:');
  try {
    const { journal, sessionId } = journalFixture(db);
    journal.claim({ op: 'send', clientCommandId: 'admission', sessionId, text: 'kept' });
    journal.enqueue('admission', sessionId, 'turn', { text: 'kept' }); journal.beginInput('turn');
    const before = journal.get('admission'); const queue = journal.queue(sessionId);
    db.exec("CREATE TRIGGER reject_accept BEFORE UPDATE ON command_journal WHEN NEW.state = 'native-accepted' BEGIN SELECT RAISE(ABORT, 'controlled-accept-failure'); END");
    expect(() => journal.acceptInput('turn')).toThrow('controlled-accept-failure');
    expect(journal.get('admission')).toEqual(before); expect(journal.queue(sessionId)).toEqual(queue);
    journal.enqueue('internal', sessionId, 'internal-turn', { text: 'internal' }); journal.beginInput('internal-turn');
    expect(journal.acceptInput('internal-turn')).toBe(true);
    expect(journal.queue(sessionId).find(row => row.commandId === 'internal')?.state).toBe('native-accepted');
    expect(journal.get('internal')).toBeUndefined();
    expect(journal.acceptInput('missing-turn')).toBe(false);
  } finally { db.close(); }
});
