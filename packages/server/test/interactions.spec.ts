import { mkdtemp, rm } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent } from '@webdcc/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

it('NP-06 twenty distinct client commands for one approval produce one native submission', async () => {
  const ctx = await createTestApp();
  const adapter = new FakeAdapter({ id: 'codex' });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let submitted = 0;
  adapter.respond = async () => { submitted++; await gate; };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    ctx.store.appendEvent({ sessionId, turnId: 'turn', itemKey: 'approval', kind: 'approval.request', data: { approvalId: 'approval', title: 'Native approval', detail: '', options: [{ id: 'accept', label: 'Allow' }] } });
    const first = ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: { op: 'approve', sessionId, approvalId: 'approval', optionId: 'accept', clientCommandId: 'FIRST' } } }).then(response => response);
    await expect.poll(() => submitted).toBe(1);
    const responses = await Promise.all(Array.from({ length: 19 }, (_, i) => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: { op: 'approve', sessionId, approvalId: 'approval', optionId: 'accept', clientCommandId: `OTHER-${i}` } } })));
    expect(responses.every(response => response.json().ok === false && response.json().code === 'conflict')).toBe(true);
    expect(submitted).toBe(1);
    release(); expect((await first).json()).toMatchObject({ ok: true });
    expect(ctx.store.interactions.get(sessionId, 'approve', 'approval')?.state).toBe('resolved');
    expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'approval.resolved')).toHaveLength(1);
  } finally { release(); await ctx.close(); }
});

it('NP-06 grouped question claims prevent an earlier answer from triggering a second batch while the last answer is sending', async () => {
  const ctx = await createTestApp();
  const adapter = new FakeAdapter({ id: 'codex' });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const received: string[] = [];
  adapter.answer = async (_id, questionId) => { received.push(questionId); if (questionId === 'one') return { submitted: false }; await gate; return { submitted: true, questionIds: ['one', 'two'] }; };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    for (const id of ['one', 'two']) ctx.store.appendEvent({ sessionId, turnId: 'turn', itemKey: id, kind: 'question', data: { questionId: id, groupId: 'native-group', prompt: id } });
    expect(await ctx.manager.answer(sessionId, 'one', 'first')).toEqual({ submitted: false });
    const last = ctx.manager.answer(sessionId, 'two', 'last');
    await new Promise(resolve => setImmediate(resolve));
    await expect(ctx.manager.answer(sessionId, 'one', 'competing edit')).rejects.toMatchObject({ statusCode: 409 });
    expect(received).toEqual(['one', 'two']);
    release(); await last;
    expect(ctx.store.interactions.get(sessionId, 'answer', 'one')?.state).toBe('resolved');
    expect(ctx.store.interactions.get(sessionId, 'answer', 'two')?.state).toBe('resolved');
  } finally { release(); await ctx.close(); }
});

it('NP-06 unknown native reply failures block new commands', async () => {
  const ctx = await createTestApp();
  const adapter = new FakeAdapter({ id: 'codex' });
  let count = 0;
  adapter.answer = async () => { count++; throw new Error('response lost'); };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    ctx.store.appendEvent({ sessionId, turnId: 'turn', itemKey: 'q', kind: 'question', data: { questionId: 'q', prompt: 'Question' } });
    await expect(ctx.manager.answer(sessionId, 'q', 'first')).rejects.toThrow('response lost');
    await expect(ctx.manager.answer(sessionId, 'q', 'retry')).rejects.toMatchObject({ code: 'uncertain' });
    expect(count).toBe(1);
    expect(ctx.store.interactions.get(sessionId, 'answer', 'q')?.state).toBe('uncertain');
  } finally { await ctx.close(); }
});

it('NP-06 SIGKILL retains request claims and recovery blocks blind native reply replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-interaction-crash-'));
  const child = fork(join(import.meta.dirname, 'fixtures/interaction-crash.ts'), [directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errorText = ''; child.stderr?.on('data', data => { errorText += String(data); });
  let db: ReturnType<typeof openDb> | undefined;
  try {
    const [value] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(errorText); })]);
    const sessionId = (value as { sessionId: string }).sessionId;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    expect(child.signalCode).toBe('SIGKILL');
    db = openDb(join(directory, 'db.sqlite'));
    const store = new Store(db);
    store.interactions.recover(); store.journal.recover();
    expect(store.interactions.get(sessionId, 'approve', 'approval')?.state).toBe('uncertain');
    expect(store.journal.get('CRASH-APPROVAL')?.state).toBe('uncertain');
    expect(() => store.interactions.claim(sessionId, 'approve', 'approval', 'NEW')).toThrow('待核对');
    expect(store.allEvents(sessionId)).toHaveLength(1);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); db?.close(); await rm(directory, { recursive: true, force: true }); }
});

it('NP-06 partial grouped answers survive as journal input and recovery keeps the whole request uncertain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-grouped-recovery-'));
  let db = openDb(join(directory, 'db.sqlite'));
  try {
    let store = new Store(db);
    const workspace = store.createWorkspace('fixture', directory);
    const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    for (const id of ['one', 'two']) store.appendEvent({ sessionId: session.id, turnId: 'turn', itemKey: id, kind: 'question', data: { questionId: id, groupId: 'group', prompt: id } });
    store.journal.claim({ op: 'answer', clientCommandId: 'COLLECTED', sessionId: session.id, questionId: 'one', answer: 'accepted partial\r\n' });
    store.interactions.finish(store.interactions.claim(session.id, 'answer', 'one', 'COLLECTED'), true);
    db.close(); db = openDb(join(directory, 'db.sqlite')); store = new Store(db);
    store.interactions.recover();
    expect(store.journal.get('COLLECTED')?.payload).toMatchObject({ answer: 'accepted partial\r\n' });
    expect(store.interactions.get(session.id, 'answer', 'one')?.state).toBe('uncertain');
    expect(store.interactions.get(session.id, 'answer', 'two')?.state).toBe('uncertain');
    expect(() => store.interactions.claim(session.id, 'answer', 'two', 'LATE')).toThrow('待核对');
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

it('NP-06/47 indexes a legacy database without changing its session identity, history or resolved interactions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-interaction-migration-'));
  let db = openDb(join(directory, 'db.sqlite'));
  try {
    let store = new Store(db);
    const workspace = store.createWorkspace('fixture', directory);
    const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    store.appendEvent({ sessionId: session.id, turnId: 'turn', itemKey: 'a', kind: 'approval.request', data: { approvalId: 'a', title: 'request', detail: 'private detail', options: [{ id: 'accept', label: 'Allow' }] } });
    store.appendEvent({ sessionId: session.id, turnId: 'turn', itemKey: 'done', kind: 'approval.resolved', data: { approvalId: 'a', optionId: 'accept', by: 'user' } });
    const events = store.allEvents(session.id);
    db.exec('DROP TABLE interactions'); db.pragma('user_version = 4'); db.close();
    db = openDb(join(directory, 'db.sqlite')); store = new Store(db);
    expect(store.getSession(session.id)?.id).toBe(session.id);
    expect(store.allEvents(session.id)).toEqual(events);
    const row = store.interactions.get(session.id, 'approve', 'a');
    expect(row?.state).toBe('resolved');
    expect(row?.request).not.toContain('private detail');
    expect(() => store.interactions.claim(session.id, 'approve', 'a', 'RETRY')).toThrow('已经结束');
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

it('NP-06 a native cancellation during a submitted answer wins over the later local completion and clears waiting state', async () => {
  const ctx = await createTestApp();
  const adapter = new FakeAdapter({ id: 'codex' });
  let callback!: (id: string, event: AdapterEvent) => void;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  adapter.onEvent = cb => { callback = cb; };
  adapter.answer = async () => { await gate; return { submitted: true, questionIds: ['q'] }; };
  ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    callback(sessionId, { type: 'item.complete', itemKey: 'q', kind: 'question', data: { questionId: 'q', prompt: 'Answer' } });
    expect(ctx.store.getSession(sessionId)?.status).toBe('waiting');
    const pending = ctx.manager.answer(sessionId, 'q', 'local answer');
    await new Promise(resolve => setImmediate(resolve));
    callback(sessionId, { type: 'item.complete', itemKey: 'cancelled-q', kind: 'question', data: { questionId: 'q', prompt: '', status: 'skipped' } });
    release(); await pending;
    expect(ctx.store.interactions.get(sessionId, 'answer', 'q')?.state).toBe('cancelled');
    expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'question').at(-1)?.data).toMatchObject({ status: 'skipped' });
    expect(ctx.store.getSession(sessionId)?.status).toBe('idle');
  } finally { release(); await ctx.close(); }
});
