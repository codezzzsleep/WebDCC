import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import type { AdapterEvent, AgentId } from '@webdcc/protocol';
import { FakeAdapter } from '@webdcc/fake-adapter';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';

it.each(['codex', 'claude-code', 'dsh'] as AgentId[])('%s current unknown send retains native observation until its own terminal', async agent => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: agent }); let emit!: (id: string, event: AdapterEvent) => void;
  adapter.onEvent = callback => { emit = callback; }; let sends = 0;
  adapter.send = async id => { sends++; emit(id, { type: 'turn.start', nativeTurnId: 'native-current' });
    emit(id, { type: 'item.start', itemKey: 'answer', kind: 'assistant.message', data: { text: 'streaming' }, nativeTurnId: 'native-current' });
    throw new Error('native send outcome unknown'); };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, agent);
    const command = { op: 'send', clientCommandId: 'unknown-send', sessionId, text: ' original\r\n' };
    const response = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    const turnId = ctx.store.journal.get(command.clientCommandId)!.turnId!; const runtime = ctx.manager.getRuntime(sessionId)!;
    const directory = process.env['WDCC_UNCERTAIN_TURN_EVIDENCE_DIR'];
    if (directory !== undefined) await writeFile(join(directory, `${agent}.json`), JSON.stringify({ agent, command, response: response.json(), turnId,
      runtime: { turnId: runtime.turnId, status: runtime.status, hot: [...runtime.hot.values()] }, owner: ctx.store.nativeOwners.get(sessionId),
      record: ctx.store.journal.get(command.clientCommandId), queue: ctx.store.journal.queue(sessionId), events: ctx.store.allEvents(sessionId) }, null, 2));
    expect(response.json()).toMatchObject({ ok: false, code: 'uncertain' });
    expect(ctx.store.allEvents(sessionId).some(event => event.kind === 'turn.completed')).toBe(false);
    expect(runtime.turnId).toBe(turnId); expect(runtime.status).toBe('running');
    expect([...runtime.hot.values()]).toHaveLength(1);
    expect(ctx.store.nativeOwners.get(sessionId)).toMatchObject({ state: 'active', activeNativeTurnId: 'native-current' });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } })).json()).toMatchObject({ ok: false, code: 'uncertain' });
    ctx.store.journal.enqueue('queued-after-unknown', sessionId, 'queued-turn', { text: 'next', delivery: 'queue' });
    expect(ctx.store.journal.next(sessionId)).toBeUndefined(); expect(sends).toBe(1);
    emit(sessionId, { type: 'turn.end', nativeTurnId: 'unrelated-native', status: 'failed' });
    expect(runtime.turnId).toBe(turnId);
    emit(sessionId, { type: 'item.delta', itemKey: 'answer', field: 'text', append: ' after lost response', nativeTurnId: 'native-current' });
    expect([...runtime.hot.values()][0]?.data).toMatchObject({ text: 'streaming after lost response' });
    // Keep the later queued input blocked on preparation, while proving that
    // the current native terminal itself releases the uncertain admission.
    ctx.store.journal.preparationError('queued-turn', 'controlled pause');
    emit(sessionId, { type: 'item.complete', itemKey: 'answer', kind: 'assistant.message', data: { text: 'streaming after lost response', phase: 'final' }, nativeTurnId: 'native-current' });
    emit(sessionId, { type: 'turn.end', nativeTurnId: 'native-current', status: 'completed' });
    await expect.poll(() => ctx.store.journal.get(command.clientCommandId)?.state, { timeout: 5000 }).toBe('completed');
    expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'turn.completed')).toHaveLength(1);
    expect(runtime.turnId).toBeNull(); expect(sends).toBe(1);
  } finally { await ctx.close(); }
});

it('SIGKILL and database reopen retain the unknown command, native identity and unfinished source turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-uncertain-send-crash-'));
  const child = fork(join(import.meta.dirname, 'fixtures/uncertain-send-crash.ts'), [directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let db: ReturnType<typeof openDb> | undefined; let manager: SessionManager | undefined;
  try {
    const [value] = await once(child, 'message'); const before = value as { sessionId: string; turnId: string; nativeRequestId: string; owner: { generation: number } };
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    db = openDb(join(directory, 'state.db')); const store = new Store(db); manager = new SessionManager(store, { idleDisposeMin: 0 });
    manager.registerAdapter(new FakeAdapter({ id: 'codex' }));
    const evidence = process.env['WDCC_UNCERTAIN_TURN_EVIDENCE_DIR'];
    if (evidence !== undefined) await writeFile(join(evidence, 'crash-reopen.json'), JSON.stringify({ signal: child.signalCode, processExited: child.exitCode !== null || child.signalCode !== null,
      before, owner: store.nativeOwners.get(before.sessionId), command: store.journal.get('crash-command'), queue: store.journal.queue(before.sessionId),
      nativeRequestId: store.journal.nativeRequestId(before.turnId), events: store.allEvents(before.sessionId) }, null, 2));
    expect(store.journal.get('crash-command')).toMatchObject({ state: 'uncertain', turnId: before.turnId });
    expect(store.journal.nativeRequestId(before.turnId)).toBe(before.nativeRequestId);
    expect(store.nativeOwners.get(before.sessionId)).toMatchObject({ state: 'uncertain', generation: before.owner.generation, activeNativeTurnId: 'native-uncertain' });
    expect(store.allEvents(before.sessionId).some(event => event.kind === 'turn.completed')).toBe(false);
    expect(store.allEvents(before.sessionId).find(event => event.kind === 'user.message')?.data).toMatchObject({ text: 'kept original' });
    await expect(manager.send(before.sessionId, { text: 'blind restart' })).rejects.toMatchObject({ statusCode: 409 });
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await manager?.disposeAll(); db?.close(); await rm(directory, { recursive: true, force: true }); }
});

it('a current unknown failure preserves completed admission rows and their original receipt', async () => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: 'codex' }); let emit!: (id: string, event: AdapterEvent) => void;
  adapter.onEvent = callback => { emit = callback; };
  adapter.send = async id => {
    emit(id, { type: 'turn.start', nativeTurnId: 'native' });
    const turnId = ctx.store.journal.get('confirmed-input')!.turnId!;
    ctx.store.journal.inputState(turnId, 'completed');
    ctx.store.journal.state('confirmed-input', 'completed', { ok: true, value: { confirmed: true } });
    throw new Error('lost RPC after confirmed admission');
  };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    ctx.store.journal.claim({ op: 'send', sessionId, text: 'original', clientCommandId: 'confirmed-input' });
    await expect(ctx.manager.send(sessionId, { text: 'original' }, 'confirmed-input')).rejects.toThrow('lost RPC');
    expect(ctx.store.journal.get('confirmed-input')).toMatchObject({ state: 'completed', result: { ok: true, value: { confirmed: true } } });
    expect(ctx.store.journal.queue(sessionId)).toEqual([]);
    expect(ctx.manager.getRuntime(sessionId)?.turnId).toBe(ctx.store.journal.get('confirmed-input')?.turnId);
    expect(ctx.store.allEvents(sessionId).some(event => event.kind === 'turn.completed')).toBe(false);
  } finally { await ctx.close(); }
});

it('a confirmed native end pending its settle timer cannot be replaced by an unknown RPC failure', async () => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: 'codex' }); let emit!: (id: string, event: AdapterEvent) => void;
  adapter.onEvent = callback => { emit = callback; };
  adapter.send = async id => { emit(id, { type: 'turn.start', nativeTurnId: 'native' }); emit(id, { type: 'turn.end', nativeTurnId: 'native', status: 'completed' }); throw new Error('lost response after native end'); };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await expect(ctx.manager.send(sessionId, { text: 'original' })).rejects.toThrow('lost response');
    expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'turn.completed')).toHaveLength(0);
    await expect.poll(() => ctx.store.allEvents(sessionId).find(event => event.kind === 'turn.completed')?.data, { timeout: 5000 }).toMatchObject({ status: 'completed' });
  } finally { await ctx.close(); }
});

it('an unknown send without any observed native turn closes only the unbound observation and remains uncertain', async () => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: 'codex' }); let closes = 0;
  adapter.send = async () => { throw new Error('no native identity received'); }; adapter.dispose = async () => { closes++; };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await expect(ctx.manager.send(sessionId, { text: 'original' }, 'unbound')).rejects.toThrow('no native identity');
    expect(ctx.store.allEvents(sessionId).some(event => event.kind === 'turn.completed')).toBe(false);
    expect(ctx.store.journal.queue(sessionId)[0]?.state).toBe('uncertain');
    expect(ctx.store.journal.nativeRequestId(ctx.store.journal.queue(sessionId)[0]!.turnId)).toBeTruthy();
    expect(ctx.manager.getRuntime(sessionId)).toBeUndefined(); expect(closes).toBe(1);
    await expect(ctx.manager.send(sessionId, { text: 'blind retry' })).rejects.toMatchObject({ statusCode: 409 });
  } finally { await ctx.close(); }
});

it('unconfirmed closure of an unbound turn preserves the original unknown input error and records cleanup failure', async () => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: 'codex' });
  const original = new Error('original unknown send');
  adapter.send = async () => { throw original; }; adapter.dispose = async () => { throw new Error('native close unconfirmed'); };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    await expect(ctx.manager.send(sessionId, { text: 'original' }, 'unconfirmed-close')).rejects.toBe(original);
    expect(ctx.store.journal.queue(sessionId)[0]?.state).toBe('uncertain');
    expect(ctx.store.nativeOwners.get(sessionId)?.state).toBe('uncertain');
    expect(ctx.store.allEvents(sessionId).some(event => event.kind === 'turn.completed')).toBe(false);
    expect(ctx.store.allEvents(sessionId).some(event => event.kind === 'notice' && (event.data as { nativeType?: string }).nativeType === 'uncertain-input-close-failed')).toBe(true);
  } finally { adapter.dispose = async () => undefined; await ctx.close(); }
});
