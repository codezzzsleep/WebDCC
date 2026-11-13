import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { Command } from '@webdcc/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { FileStore } from '../src/files.js';
import { SessionManager } from '../src/manager.js';
import { CommandDispatcher } from '../src/dispatcher.js';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

it('NP-03 concurrently accepts one command ID exactly once and returns 409 for a changed payload', async () => {
  const ctx = await createTestApp({ delayMs: 500 });
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx);
    const command = { op: 'send', sessionId, text: '并发的原文', clientCommandId: 'CONCURRENT' };
    const responses = await Promise.all(Array.from({ length: 20 }, () => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } })));
    expect(new Set(responses.map(response => response.body)).size).toBe(1);
    expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'user.message')).toHaveLength(1);
    expect(ctx.store.journal.queue(sessionId)).toHaveLength(1);
    const conflict = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: { ...command, text: '不同正文' } } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ ok: false, code: 'command-conflict' });
  } finally { await ctx.close(); }
});

it('NP-03 retains ACKed text and attachments after SIGKILL and blocks blind replay of native-accepted input', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wdcc-journal-crash-'));
  const child = fork(join(import.meta.dirname, 'fixtures/queue-crash.ts'), [dataDir], { execArgv: ['--import', 'tsx'], env: { ...process.env, WDCC_TEST_HOOKS: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errorOutput = '';
  child.stderr?.on('data', chunk => { errorOutput += String(chunk); });
  let db: ReturnType<typeof openDb> | undefined;
  let manager: SessionManager | undefined;
  try {
    const message = await Promise.race([once(child, 'message').then(([value]) => value as { sessionId: string; first: Command; fileId: string }), once(child, 'exit').then(() => { throw new Error(`Fixture exited: ${errorOutput}`); })]);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    db = openDb(join(dataDir, 'webdcc.db'));
    const store = new Store(db);
    manager = new SessionManager(store, { idleDisposeMin: 0 });
    const adapter = new FakeAdapter({ id: 'dsh' });
    let sends = 0;
    adapter.send = async () => { sends++; };
    manager.registerAdapter(adapter);
    const files = new FileStore(dataDir, store);
    const queue = store.journal.queue(message.sessionId);
    expect(queue.map(row => row.state)).toEqual(['uncertain', 'queued']);
    expect(queue[1]?.input.text).toBe('已确认的队列正文\r\n');
    expect(queue[1]?.input.images?.[0]?.fileId).toBe(message.fileId);
    expect((await files.readAll(message.fileId))?.buffer.toString()).toBe('queue-attachment');
    expect(store.journal.get('CRASH-QUEUED')?.result).toMatchObject({ ok: true, value: { queued: true } });
    const dispatcher = new CommandDispatcher(store, manager, files);
    expect(await dispatcher.dispatch(message.first)).toMatchObject({ ok: false, code: 'uncertain' });
    expect(sends).toBe(0);
    store.journal.cancel(message.sessionId, 'CRASH-QUEUED');
    expect(store.journal.get('CRASH-QUEUED')?.state).toBe('cancelled');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await manager?.disposeAll();
    db?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);
