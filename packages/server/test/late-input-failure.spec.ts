import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import type { AdapterEvent, AgentId } from '@webdcc/protocol';
import { FakeAdapter } from '@webdcc/fake-adapter';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { CommandJournal } from '../src/command-journal.js';

const cases = (['codex', 'claude-code', 'dsh'] as AgentId[]).flatMap(agent => [false, true].map(completed => ({ agent, completed })));
it.each(cases)('$agent old send failure leaves current native B intact (A completed=$completed)', async ({ agent, completed }) => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: agent });
  let emit!: (id: string, event: AdapterEvent) => void; adapter.onEvent = callback => { emit = callback; };
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  adapter.send = async id => {
    sends++;
    emit(id, { type: 'turn.start', nativeTurnId: 'native-A' });
    if (completed) emit(id, { type: 'turn.end', nativeTurnId: 'native-A', status: 'completed' });
    emit(id, { type: 'turn.start', nativeTurnId: 'native-B' });
    await gate; throw new Error('old send response lost');
  };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, agent);
    const command = { op: 'send', clientCommandId: 'old-send', sessionId, text: ' original A\r\n' };
    const response = ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    const expectedState = completed ? 'completed' : 'uncertain';
    await expect.poll(() => ctx.store.journal.get(command.clientCommandId)?.state).toBe(expectedState);
    const oldTurn = ctx.store.journal.get(command.clientCommandId)!.turnId!;
    const currentTurn = ctx.manager.getRuntime(sessionId)!.turnId!;
    const identity = ctx.manager.getRuntime(sessionId)!.identity;
    const nativeRequestId = ctx.store.journal.nativeRequestId(oldTurn);
    expect(currentTurn).not.toBe(oldTurn);
    expect(ctx.store.nativeOwners.get(sessionId)?.activeNativeTurnId).toBe('native-B');
    release(); const received = await response;
    const evidenceDir = process.env['WDCC_LATE_FAILURE_EVIDENCE_DIR'];
    if (evidenceDir !== undefined) await writeFile(join(evidenceDir, `${agent}-${completed}.json`), JSON.stringify({ agent, completed, oldTurn, currentTurn,
      response: received.json(), record: ctx.store.journal.get(command.clientCommandId), queue: ctx.store.journal.queue(sessionId),
      runtime: { turnId: ctx.manager.getRuntime(sessionId)?.turnId, status: ctx.manager.getRuntime(sessionId)?.status },
      owner: ctx.store.nativeOwners.get(sessionId), events: ctx.store.allEvents(sessionId), sends }, null, 2));
    expect(received.json()).toMatchObject({ ok: false, code: 'uncertain' });
    expect(ctx.manager.getRuntime(sessionId)?.turnId).toBe(currentTurn);
    expect(ctx.manager.getRuntime(sessionId)?.status).toBe('running');
    expect(ctx.store.nativeOwners.get(sessionId)).toMatchObject({ generation: identity.generation, activeNativeTurnId: 'native-B', state: 'active' });
    expect(ctx.store.allEvents(sessionId).some(event => event.kind === 'turn.completed' && event.turnId === currentTurn)).toBe(false);
    expect(ctx.store.journal.get(command.clientCommandId)?.state).toBe(expectedState);
    expect(ctx.store.journal.nativeRequestId(oldTurn)).toBe(nativeRequestId);
    expect(sends).toBe(1);
    if (!completed) {
      const duplicate = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
      expect(duplicate.json()).toMatchObject({ ok: false, code: 'uncertain' }); expect(sends).toBe(1);
    }
  } finally { release(); await ctx.close(); }
});

it.each(['queued', 'completed', 'failed', 'cancelled'] as const)('a late failure preserves a %s admission and its existing receipt after database reopen', async state => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-late-input-state-')); const path = join(directory, 'state.db');
  let db = openDb(path); const second = openDb(path);
  try {
    const store = new Store(db); const workspace = store.createWorkspace('late input', directory);
    const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const journal = store.journal; const other = new CommandJournal(second);
    journal.claim({ op: 'send', clientCommandId: 'late-state', sessionId: session.id, text: 'kept' });
    journal.enqueue('late-state', session.id, 'turn', { text: 'kept' }); journal.beginInput('turn');
    const requestId = journal.nativeRequestId('turn'); other.inputState('turn', state);
    const receipt = { ok: true, value: { origin: 'first', state } }; other.state('late-state', state, receipt);
    const before = journal.get('late-state'); const input = second.prepare('SELECT * FROM input_queue WHERE turn_id = ?').get('turn');
    for (const late of ['failed', 'uncertain'] as const) expect(journal.settleInputFailure('turn', late)).toBe(false);
    expect(journal.get('late-state')).toEqual(before); expect(second.prepare('SELECT * FROM input_queue WHERE turn_id = ?').get('turn')).toEqual(input);
    db.close(); db = openDb(path); const reopened = new CommandJournal(db);
    expect(reopened.settleInputFailure('turn', 'uncertain')).toBe(false);
    expect(reopened.get('late-state')).toEqual(before); expect(reopened.nativeRequestId('turn')).toBe(requestId);
  } finally { second.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

it('failure settlement rolls back both rows on a write error and preserves an independently confirmed command terminal', () => {
  const db = openDb(':memory:');
  try {
    const store = new Store(db); const workspace = store.createWorkspace('late input', '/tmp'); const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    store.journal.claim({ op: 'send', clientCommandId: 'late-failure', sessionId: session.id, text: 'kept' });
    store.journal.enqueue('late-failure', session.id, 'turn', { text: 'kept' }); store.journal.beginInput('turn');
    const before = store.journal.get('late-failure'); const queue = store.journal.queue(session.id);
    db.exec("CREATE TRIGGER reject_late_failure BEFORE UPDATE ON command_journal WHEN NEW.state = 'uncertain' BEGIN SELECT RAISE(ABORT, 'controlled-settlement-failure'); END");
    expect(() => store.journal.settleInputFailure('turn', 'uncertain')).toThrow('controlled-settlement-failure');
    expect(store.journal.get('late-failure')).toEqual(before); expect(store.journal.queue(session.id)).toEqual(queue);
    store.journal.state('late-failure', 'completed', { ok: true });
    expect(store.journal.settleInputFailure('turn', 'failed')).toBe(false);
    expect(store.journal.get('late-failure')).toMatchObject({ state: 'completed', result: { ok: true } }); expect(store.journal.queue(session.id)).toEqual(queue);
    expect(store.journal.settleInputFailure('missing', 'uncertain')).toBe(false);
  } finally { db.close(); }
});

it('internal input failure keeps its identity while settling only its own row', () => {
  const db = openDb(':memory:');
  try {
    const store = new Store(db); const workspace = store.createWorkspace('internal', '/tmp'); const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const row = store.journal.enqueue('internal', session.id, 'turn', { text: 'internal' }); store.journal.beginInput('turn');
    const requestId = store.journal.nativeRequestId('turn');
    expect(store.journal.settleInputFailure('turn', 'uncertain')).toBe(true);
    expect(store.journal.queue(session.id)).toEqual([{ ...row, state: 'uncertain' }]);
    expect(store.journal.nativeRequestId('turn')).toBe(requestId); expect(store.journal.get('internal')).toBeUndefined();
  } finally { db.close(); }
});

it('a failed old generation cannot finish its turn or overwrite the current owner state', async () => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: 'codex' });
  let emit!: (id: string, event: AdapterEvent) => void; adapter.onEvent = callback => { emit = callback; };
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  adapter.send = async id => { emit(id, { type: 'turn.start', nativeTurnId: 'native-A' }); await gate; throw new Error('old generation failed'); };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    const command = { op: 'send', clientCommandId: 'old-generation-send', sessionId, text: 'kept' };
    const response = ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    await expect.poll(() => ctx.store.nativeOwners.get(sessionId)?.activeNativeTurnId).toBe('native-A');
    const old = ctx.manager.getRuntime(sessionId)!.identity;
    ctx.store.nativeOwners.close(sessionId, old); ctx.store.nativeOwners.release(sessionId, old, true);
    const current = ctx.store.nativeOwners.acquire('other-owner', sessionId, 'codex', ctx.store.getSession(sessionId)!.nativeId);
    ctx.store.nativeOwners.activate(sessionId, current, ctx.store.getSession(sessionId)!.nativeId!);
    ctx.store.nativeOwners.observe(sessionId, current, 'native-B');
    release(); expect((await response).json()).toMatchObject({ ok: false, code: 'uncertain' });
    expect(ctx.store.nativeOwners.get(sessionId)).toMatchObject({ ownerId: 'other-owner', generation: current.generation, activeNativeTurnId: 'native-B', state: 'active' });
    expect(ctx.store.getSession(sessionId)?.status).toBe('running');
    expect(ctx.store.allEvents(sessionId).some(event => event.kind === 'turn.completed')).toBe(false);
    expect(ctx.store.journal.get(command.clientCommandId)?.state).toBe('uncertain');
  } finally { release(); await ctx.close(); }
});

it('an explicitly unsubmitted failure for the actual current turn still records its known failure', async () => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: 'codex' });
  let emit!: (id: string, event: AdapterEvent) => void; adapter.onEvent = callback => { emit = callback; };
  adapter.send = async id => { emit(id, { type: 'turn.start', nativeTurnId: 'native-A' }); throw Object.assign(new Error('native rejected admission'), { nativeAdmission: 'not-submitted' }); };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    const command = { op: 'send', clientCommandId: 'current-send', sessionId, text: 'kept' };
    await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    expect(ctx.store.journal.get(command.clientCommandId)?.state).toBe('failed');
    expect(ctx.manager.getRuntime(sessionId)?.turnId).toBeNull();
    expect(ctx.store.allEvents(sessionId).find(event => event.kind === 'turn.completed')?.data).toMatchObject({ status: 'failed' });
  } finally { await ctx.close(); }
});
