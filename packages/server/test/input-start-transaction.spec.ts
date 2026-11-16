import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import type { Command, RuntimeIdentity } from '@webdcc/protocol';
import { FakeAdapter } from '@webdcc/fake-adapter';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import { FileStore } from '../src/files.js';
import { CommandDispatcher } from '../src/dispatcher.js';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

it.each(['queued-feed', 'user.message', 'turn.started', 'dispatch-feed', 'title-feed'] as const)('pre-native %s persistence failure keeps a truthful recoverable admission', async boundary => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-input-start-'));
  const dbPath = join(directory, 'state.db');
  const ctx = await createTestApp({}, undefined, {}, { dbPath });
  const second = openDb(dbPath);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    let sends = 0;
    ctx.manager.adapter('codex')!.send = async (_sessionId, input) => {
      sends++; expect(input.text).toBe(' original input\r\n');
      expect(input.nativeRequestId).toMatch(/^[0-9a-f-]{36}$/);
    };
    if (boundary === 'user.message' || boundary === 'turn.started') {
      second.exec(`CREATE TRIGGER fail_start BEFORE INSERT ON events WHEN NEW.kind = '${boundary}' BEGIN SELECT RAISE(ABORT, 'controlled-start-failure'); END`);
    } else {
      second.exec(`CREATE TRIGGER fail_start BEFORE INSERT ON feed WHEN json_type(NEW.patch, '$.${boundary === 'title-feed' ? 'title' : 'queueRevision'}') IS NOT NULL ${boundary === 'dispatch-feed' ? 'AND (SELECT COUNT(*) FROM native_input_ids) > 0' : ''} BEGIN SELECT RAISE(ABORT, 'controlled-start-failure'); END`);
    }
    const command = { op: 'send', clientCommandId: 'original-input', sessionId, text: ' original input\r\n' };
    const response = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    const evidenceDir = process.env['WDCC_ADMISSION_EVIDENCE_DIR'];
    if (evidenceDir !== undefined) await writeFile(join(evidenceDir, `start-${boundary}.json`), JSON.stringify({ boundary, statusCode: response.statusCode, response: response.json(), sends,
      command: ctx.store.journal.get(command.clientCommandId), queue: ctx.store.journal.queue(sessionId), events: ctx.store.allEvents(sessionId),
      runtime: { turnId: ctx.manager.getRuntime(sessionId)?.turnId, status: ctx.manager.getRuntime(sessionId)?.status }, nativeIds: second.prepare('SELECT * FROM native_input_ids').all() }, null, 2));
    expect(response.json()).toMatchObject({ ok: false, code: 'failed' });
    expect(sends).toBe(0);
    expect(ctx.manager.getRuntime(sessionId)?.turnId).toBeNull();
    expect(ctx.store.allEvents(sessionId)).toEqual([]);
    expect(second.prepare('SELECT * FROM native_input_ids').all()).toEqual([]);
    const record = ctx.store.journal.get(command.clientCommandId)!;
    if (boundary === 'queued-feed') {
      expect(record.state).toBe('failed');
      expect(ctx.store.journal.queue(sessionId)).toEqual([]);
    } else {
      const admission = ctx.store.journal.queue(sessionId)[0]!;
      expect(record).toMatchObject({ state: 'queued', turnId: admission.turnId });
      expect(admission).toMatchObject({ state: 'queued', input: { text: command.text }, preparationError: 'controlled-start-failure' });
      second.exec('DROP TRIGGER fail_start');
      const retried = await ctx.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/queue/${command.clientCommandId}/retry`, headers: { cookie: ctx.cookie }, payload: {} });
      expect(retried.statusCode).toBe(200);
      expect(sends).toBe(1);
      expect(ctx.store.journal.get(command.clientCommandId)).toMatchObject({ state: 'native-accepted', turnId: admission.turnId });
      expect(ctx.store.journal.queue(sessionId)[0]).toMatchObject({ ordinal: admission.ordinal, input: admission.input, commandId: admission.commandId });
      expect(ctx.store.allEvents(sessionId).map(event => event.kind)).toEqual(['user.message', 'turn.started']);
    }
  } finally { second.close(); await ctx.close(); await rm(directory, { recursive: true, force: true }); }
});

it('SIGKILL after atomic dispatch persistence retains identities and uncertainty without blindly replaying native input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-input-dispatch-crash-'));
  const child = fork(join(import.meta.dirname, 'fixtures/input-start-crash.ts'), [directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); });
  let db: ReturnType<typeof openDb> | undefined; let manager: SessionManager | undefined;
  try {
    const message = await Promise.race([once(child, 'message').then(([value]) => value as { command: Extract<Command, { op: 'send' }>; identity: RuntimeIdentity; nativeRequestId: string }),
      once(child, 'exit').then(() => { throw new Error(`Dispatch fixture exited: ${stderr}`); })]);
    const exited = once(child, 'exit'); expect(child.kill('SIGKILL')).toBe(true);
    const [, signal] = await exited; expect(signal).toBe('SIGKILL');
    db = openDb(join(directory, 'state.db')); const store = new Store(db);
    manager = new SessionManager(store, { idleDisposeMin: 0 });
    const adapter = new FakeAdapter({ id: 'codex' }); let sends = 0; adapter.send = async () => { sends++; }; manager.registerAdapter(adapter);
    const record = store.journal.get(message.command.clientCommandId)!;
    expect(record).toMatchObject({ state: 'uncertain', payload: message.command });
    expect(store.journal.queue(message.command.sessionId)[0]).toMatchObject({ commandId: message.command.clientCommandId, state: 'uncertain', input: { text: message.command.text } });
    expect(store.journal.nativeRequestId(record.turnId!)).toBe(message.nativeRequestId);
    expect(store.nativeOwners.get(message.command.sessionId)).toMatchObject({ generation: message.identity.generation, state: 'uncertain' });
    expect(store.allEvents(message.command.sessionId).filter(event => ['user.message', 'turn.started'].includes(event.kind))).toHaveLength(2);
    expect(store.allEvents(message.command.sessionId).some(event => event.kind === 'turn.completed')).toBe(false);
    const dispatcher = new CommandDispatcher(store, manager, new FileStore(directory, store));
    expect(await dispatcher.dispatch(message.command)).toMatchObject({ ok: false, code: 'uncertain' });
    expect(sends).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await manager?.disposeAll(); db?.close(); await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
