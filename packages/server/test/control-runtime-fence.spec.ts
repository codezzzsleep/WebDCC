import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import type { AdapterEvent, AgentId } from '@webdcc/protocol';
import { FakeAdapter } from '@webdcc/fake-adapter';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

const cases = (['codex', 'claude-code', 'dsh'] as AgentId[]).flatMap(agent =>
  ['set-model', 'set-reasoning-effort', 'set-access-mode'].map(op => ({ agent, op })));

it.each(cases)('$agent $op late unavailable failure cannot dispose the replacement runtime', async ({ agent, op }) => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: agent });
  let emit!: (sessionId: string, event: AdapterEvent) => void;
  adapter.onEvent = callback => { emit = callback; };
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0; let closes = 0;
  const failure = async () => { calls++; await gate; throw Object.assign(new Error('old query unavailable'), { code: 'native-runtime-unavailable', statusCode: 503 }); };
  adapter.setModel = failure; adapter.setReasoningEffort = failure; adapter.setAccessMode = failure;
  adapter.dispose = async () => { closes++; };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, agent);
    const old = ctx.manager.getRuntime(sessionId)!.identity;
    const command = { op, sessionId, clientCommandId: `old-${op}`, model: 'next', reasoningEffort: 'high', accessMode: adapter.accessModes()[1]!.id };
    const response = ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    await expect.poll(() => calls).toBe(1);
    await ctx.manager.dispose(sessionId);
    await ctx.manager.slashCommands(sessionId);
    const runtime = ctx.manager.getRuntime(sessionId)!;
    expect(runtime.identity.generation).toBe(old.generation + 1);
    emit(sessionId, { type: 'turn.start', nativeTurnId: 'current-native-turn', runtime: runtime.identity });
    const owner = ctx.store.nativeOwners.get(sessionId);
    const turnId = runtime.turnId;
    const events = ctx.store.allEvents(sessionId);
    const session = ctx.store.getSession(sessionId);
    release(); const result = await response;
    const evidence = process.env['WDCC_CONTROL_FENCE_EVIDENCE_DIR'];
    if (evidence !== undefined) await writeFile(join(evidence, `${agent}-${op}.json`), JSON.stringify({ agent, op, old, current: runtime.identity,
      response: result.json(), closes, runtimePresent: ctx.manager.getRuntime(sessionId) !== undefined,
      before: { owner, turnId, events, session }, after: { owner: ctx.store.nativeOwners.get(sessionId), events: ctx.store.allEvents(sessionId), session: ctx.store.getSession(sessionId) } }, null, 2));
    expect(result.json()).toMatchObject({ ok: false, error: 'old query unavailable' });
    expect(closes).toBe(1);
    expect(ctx.manager.getRuntime(sessionId)).toBe(runtime);
    expect(ctx.store.nativeOwners.get(sessionId)).toEqual(owner);
    expect(runtime.turnId).toBe(turnId);
    expect(ctx.store.allEvents(sessionId)).toEqual(events);
    expect(ctx.store.getSession(sessionId)).toEqual(session);
    emit(sessionId, { type: 'item.complete', itemKey: 'current-output', kind: 'assistant.message', data: { text: 'current native output' }, runtime: runtime.identity, nativeTurnId: 'current-native-turn' });
    expect(ctx.store.allEvents(sessionId).at(-1)?.data).toMatchObject({ text: 'current native output' });
    emit(sessionId, { type: 'item.complete', itemKey: 'old-output', kind: 'assistant.message', data: { text: 'stale' }, runtime: old });
    expect(ctx.store.nativeEvents.list(sessionId).at(-1)?.disposition).toBe('stale-generation');
    expect(ctx.store.allEvents(sessionId).some(event => event.itemKey === 'old-output')).toBe(false);
    adapter.setModel = async () => { calls++; };
    await ctx.manager.setModel(sessionId, 'valid-current-model');
    expect(calls).toBe(2); expect(closes).toBe(1);
    expect(ctx.store.getSession(sessionId)?.model).toBe('valid-current-model');
  } finally { release(); await ctx.close(); }
});

it.each([false, true])('current unavailable failure still closes its own runtime (activated by operation=%s)', async activate => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: 'claude-code' });
  let closes = 0; adapter.dispose = async () => { closes++; };
  const failure = Object.assign(new Error('current query unavailable'), { code: 'native-runtime-unavailable', statusCode: 503 });
  adapter.setModel = async () => { throw failure; };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'claude-code');
    if (activate) await ctx.manager.dispose(sessionId);
    await expect(ctx.manager.setModel(sessionId, 'broken')).rejects.toBe(failure);
    expect(closes).toBe(activate ? 2 : 1);
    expect(ctx.manager.getRuntime(sessionId)).toBeUndefined();
    expect(ctx.store.nativeOwners.get(sessionId)?.state).toBe('released');
    expect(ctx.store.getSession(sessionId)?.model).not.toBe('broken');
  } finally { await ctx.close(); }
});

it('a runtime-free reconciliation failure cannot inherit a concurrently activated owner', async () => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: 'codex' });
  let entered = false; let closes = 0; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const failure = Object.assign(new Error('read-only observation unavailable'), { code: 'native-runtime-unavailable' });
  adapter.observe = async () => { entered = true; await gate; throw failure; };
  adapter.dispose = async () => { closes++; };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex'); await ctx.manager.dispose(sessionId);
    const pending = ctx.manager.reconcile(sessionId).catch(error => error);
    await expect.poll(() => entered).toBe(true);
    await ctx.manager.slashCommands(sessionId); const runtime = ctx.manager.getRuntime(sessionId)!;
    const owner = ctx.store.nativeOwners.get(sessionId);
    release(); expect(await pending).toBe(failure);
    expect(closes).toBe(1); expect(ctx.manager.getRuntime(sessionId)).toBe(runtime);
    expect(ctx.store.nativeOwners.get(sessionId)).toEqual(owner);
  } finally { release(); await ctx.close(); }
});

it('the failure receipt and replacement owner remain consistent through a second SQLite connection and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-control-fence-')); const path = join(directory, 'state.db');
  const ctx = await createTestApp({}, undefined, {}, { dbPath: path }); const second = openDb(path);
  const adapter = new FakeAdapter({ id: 'claude-code' }); let entered = false;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  adapter.setModel = async () => { entered = true; await gate; throw Object.assign(new Error('old query unavailable'), { code: 'native-runtime-unavailable', statusCode: 503 }); };
  adapter.dispose = async () => undefined; ctx.manager.registerAdapter(adapter);
  let closed = false;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'claude-code');
    const command = { op: 'set-model', sessionId, model: 'unconfirmed', clientCommandId: 'persistent-old-control' };
    const pending = ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    await expect.poll(() => entered).toBe(true); await ctx.manager.dispose(sessionId); await ctx.manager.slashCommands(sessionId);
    const owner = new Store(second).nativeOwners.get(sessionId);
    release(); expect((await pending).json()).toMatchObject({ ok: false });
    const receipt = new Store(second).journal.get(command.clientCommandId);
    expect(receipt).toMatchObject({ state: 'uncertain' }); expect(new Store(second).nativeOwners.get(sessionId)).toEqual(owner);
    const duplicate = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    expect(duplicate.json()).toMatchObject({ ok: false, code: 'uncertain' }); expect(new Store(second).journal.get(command.clientCommandId)).toEqual(receipt);
    await ctx.close(); closed = true;
    const reopened = openDb(path);
    try {
      const store = new Store(reopened);
      expect(store.journal.get(command.clientCommandId)).toEqual(receipt);
      expect(store.nativeOwners.get(sessionId)).toMatchObject({ generation: owner!.generation, state: 'released' });
      expect(store.allEvents(sessionId).some(event => event.kind === 'turn.completed')).toBe(false);
      expect(store.getSession(sessionId)?.model).not.toBe('unconfirmed');
    } finally { reopened.close(); }
  } finally { release(); second.close(); if (!closed) await ctx.close(); await rm(directory, { recursive: true, force: true }); }
});

it('a queued control waits for unavailable cleanup, then binds the runtime it actually activates', async () => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: 'claude-code' });
  let finishClose!: () => void; const closeGate = new Promise<void>(resolve => { finishClose = resolve; });
  let closes = 0; const models: string[] = []; let resumes = 0;
  adapter.dispose = async () => { closes++; if (closes === 1) await closeGate; };
  adapter.resume = async () => { resumes++; };
  const failure = Object.assign(new Error('current query unavailable'), { code: 'native-runtime-unavailable', statusCode: 503 });
  adapter.setModel = async (_id, model) => { models.push(model); if (model === 'broken') throw failure; };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'claude-code');
    const old = ctx.manager.getRuntime(sessionId)!.identity;
    const first = ctx.manager.setModel(sessionId, 'broken').catch(error => error);
    const second = ctx.manager.setModel(sessionId, 'valid').then(() => 'ok', error => error);
    await expect.poll(() => closes).toBe(1);
    await new Promise(resolve => setImmediate(resolve));
    expect(models).toEqual(['broken']); expect(resumes).toBe(0);
    finishClose();
    expect(await first).toBe(failure); expect(await second).toBe('ok');
    const current = ctx.manager.getRuntime(sessionId)!.identity;
    expect(current.generation).toBe(old.generation + 1);
    expect(models).toEqual(['broken', 'valid']); expect(resumes).toBe(1);
    expect(closes).toBe(1); expect(ctx.store.getSession(sessionId)?.model).toBe('valid');
    adapter.setModel = async () => { throw failure; };
    await expect(ctx.manager.setModel(sessionId, 'broken-again')).rejects.toBe(failure);
    expect(closes).toBe(2); expect(ctx.manager.getRuntime(sessionId)).toBeUndefined();
  } finally { finishClose(); await ctx.close(); }
});

it('an unavailable old control cannot close a new durable owner even while the old runtime object remains', async () => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: 'codex' });
  let entered = false; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let closes = 0; adapter.dispose = async () => { closes++; };
  const failure = Object.assign(new Error('old owner unavailable'), { code: 'native-runtime-unavailable' });
  adapter.setModel = async () => { entered = true; await gate; throw failure; };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    const old = ctx.manager.getRuntime(sessionId)!;
    const pending = ctx.manager.setModel(sessionId, 'broken').catch(error => error);
    await expect.poll(() => entered).toBe(true);
    ctx.store.nativeOwners.close(sessionId, old.identity); ctx.store.nativeOwners.release(sessionId, old.identity, true);
    const identity = ctx.store.nativeOwners.acquire('other-manager', sessionId, 'codex', old.nativeId);
    ctx.store.nativeOwners.activate(sessionId, identity, old.nativeId); ctx.store.nativeOwners.observe(sessionId, identity, 'new-native-turn');
    const owner = ctx.store.nativeOwners.get(sessionId);
    release(); expect(await pending).toBe(failure);
    expect(closes).toBe(0); expect(ctx.manager.getRuntime(sessionId)).toBe(old);
    expect(ctx.store.nativeOwners.get(sessionId)).toEqual(owner);
  } finally { release(); await ctx.close(); }
});
