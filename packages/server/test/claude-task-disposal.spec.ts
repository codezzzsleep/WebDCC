import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { currentClaudeTasks, currentClaudeTaskViews, type AdapterEvent, type StoredEvent } from '@webdcc/protocol';
import { FakeAdapter } from '@webdcc/fake-adapter';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocked.query }));
import { ClaudeAdapter } from '../../adapters/claude/src/adapter.js';

afterEach(() => { mocked.query.mockReset(); vi.restoreAllMocks(); });

async function fixture(dbPath?: string) {
  let closed = false;
  let wake: (() => void) | undefined;
  let closeFailure = false;
  let closeGate: Promise<void> | undefined;
  let closeAttempts = 0;
  const queue: SDKMessage[] = [];
  const delivered: SDKMessage[] = [];
  const query = {
    async *[Symbol.asyncIterator]() {
      while (!closed || queue.length) {
        const message = queue.shift();
        if (message !== undefined) { delivered.push(message); yield message; }
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    },
    close: vi.fn(() => {
      closeAttempts++;
      if (closeFailure) throw new Error('controlled native close failure');
      const finish = () => { closed = true; wake?.(); };
      if (closeGate !== undefined) return closeGate.then(finish);
      finish();
    }),
  };
  mocked.query.mockImplementationOnce(() => query as unknown as Query);
  const ctx = await createTestApp({}, undefined, {}, dbPath === undefined ? {} : { dbPath });
  ctx.manager.registerAdapter(new ClaudeAdapter());
  const { sessionId } = await seedWorkspaceAndSession(ctx, 'claude-code');
  let seq = 0;
  const push = (subtype: string, fields: Record<string, unknown> = {}) => {
    queue.push({ type: 'system', subtype, session_id: 'controlled-native', uuid: `controlled-${++seq}`, ...fields } as unknown as SDKMessage);
    wake?.();
  };
  push('init', { model: 'controlled-model', cwd: '/tmp' });
  for (const task_id of ['running', 'paused', 'completed', 'failed', 'stopped']) {
    push('task_started', { task_id, run_id: '001', description: task_id, is_backgrounded: true, tool_use_id: `${task_id}-tool` });
    if (task_id === 'paused') push('task_updated', { task_id, run_id: '001', patch: { status: 'paused' } });
    if (['completed', 'failed', 'stopped'].includes(task_id)) push('task_notification', { task_id, run_id: '001', status: task_id, summary: `${task_id} summary`, output_file: `/tmp/${task_id}` });
  }
  push('background_tasks_changed', { tasks: ['running', 'paused'].map(task_id => ({ task_id, run_id: '001', task_type: 'local_agent', description: task_id })) });
  await vi.waitFor(() => expect(currentClaudeTasks(ctx.store.allEvents(sessionId)).find(task => task.taskId === 'paused')).toMatchObject({ status: 'paused', backgroundPresence: 'present' }));
  return { ...ctx, sessionId, query, push, delivered, closeAttempts: () => closeAttempts, failClose(value: boolean) { closeFailure = value; }, gateClose(value?: Promise<void>) { closeGate = value; } };
}

it.each(['dispose', 'disposeAll'] as const)('recovers truthful Claude task states through production %s and SQLite reopen', async method => {
  const scratch = await mkdtemp(join(tmpdir(), 'wdcc-claude-disposal-'));
  const dbPath = join(scratch, 'state.db');
  const ctx = await fixture(dbPath);
  let appClosed = false;
  try {
    const before = ctx.store.allEvents(ctx.sessionId);
    if (method === 'dispose') await ctx.manager.dispose(ctx.sessionId); else await ctx.manager.disposeAll();
    const events = ctx.store.allEvents(ctx.sessionId);
    const tasks = currentClaudeTasks(events);
    for (const taskId of ['running', 'paused']) expect(tasks.find(task => task.taskId === taskId)).toMatchObject({ status: 'unknown', nativeStatus: taskId, backgroundPresence: 'unknown' });
    for (const status of ['completed', 'failed', 'stopped']) expect(tasks.find(task => task.taskId === status)).toMatchObject({ status, terminalNotification: status, summary: `${status} summary`, outputFile: `/tmp/${status}`, runId: '001', toolUseId: `${status}-tool` });
    expect(events.filter(event => event.native !== undefined)).toEqual(before.filter(event => event.native !== undefined));
    expect(currentClaudeTaskViews(events).tasks.find(task => task.taskId === 'running')?.status).toBe('unknown');
    const response = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${ctx.sessionId}/events`, headers: { cookie: ctx.cookie } });
    expect(response.statusCode).toBe(200);
    expect(currentClaudeTaskViews(response.json<{ events: StoredEvent[] }>().events).tasks.find(task => task.taskId === 'running')?.status).toBe('unknown');
    expect(ctx.query.close).toHaveBeenCalledTimes(1);
    await ctx.close(); appClosed = true;
    const db = openDb(dbPath);
    try { expect(currentClaudeTasks(new Store(db).allEvents(ctx.sessionId))).toEqual(tasks); }
    finally { db.close(); }
  } finally { if (!appClosed) await ctx.close(); await rm(scratch, { recursive: true, force: true }); }
});

it('keeps disposal fencing and rejects a different adapter query observation and late native lifecycle', async () => {
  const ctx = await fixture();
  let release!: () => void;
  try {
    const foreign = new FakeAdapter({ id: 'claude-code' });
    ctx.manager.registerAdapter(foreign);
    (foreign as unknown as { emit(id: string, event: AdapterEvent): void }).emit(ctx.sessionId, { type: 'item.complete', kind: 'internal', itemKey: 'foreign-query', scope: 'session', data: { nativeType: 'claude-query-runtime', claudeTaskRuntime: { id: 'foreign-query', state: 'started' } } });
    ctx.gateClose(new Promise<void>(resolve => { release = resolve; }));
    const closing = ctx.manager.dispose(ctx.sessionId);
    await vi.waitFor(() => expect(ctx.query.close).toHaveBeenCalledTimes(1));
    expect(currentClaudeTasks(ctx.store.allEvents(ctx.sessionId)).find(task => task.taskId === 'running')?.status).toBe('unknown');
    ctx.push('task_progress', { task_id: 'running', run_id: '001', summary: 'late progress must stay fenced' });
    await vi.waitFor(() => expect(ctx.delivered.some(message => (message as unknown as { summary?: string }).summary === 'late progress must stay fenced')).toBe(true));
    release(); await closing;
    const events = ctx.store.allEvents(ctx.sessionId);
    expect(events.some(event => event.itemKey === 'foreign-query')).toBe(false);
    expect(currentClaudeTasks(events).find(task => task.taskId === 'running')).toMatchObject({ status: 'unknown', nativeStatus: 'running' });
    expect(events.some(event => (event.native as { summary?: string } | undefined)?.summary === 'late progress must stay fenced')).toBe(false);
  } finally { release?.(); await ctx.close(); }
});

it('keeps tasks unconfirmed and reports an actual query close failure', async () => {
  const ctx = await fixture();
  try {
    ctx.failClose(true);
    await expect(ctx.manager.dispose(ctx.sessionId)).rejects.toThrow('controlled native close failure');
    expect(currentClaudeTasks(ctx.store.allEvents(ctx.sessionId)).find(task => task.taskId === 'running')).toMatchObject({ status: 'unknown', nativeStatus: 'running' });
    expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('error');
  } finally { ctx.failClose(false); await ctx.close(); }
});

it('still closes the owned query when task observation persistence fails and reports that failure', async () => {
  const ctx = await fixture();
  try {
    const append = ctx.store.appendEvent.bind(ctx.store);
    vi.spyOn(ctx.store, 'appendEvent').mockImplementation(value => {
      if (value.itemKey.endsWith(':unavailable')) throw new Error('controlled observation persistence failure');
      return append(value);
    });
    await expect(ctx.manager.dispose(ctx.sessionId)).rejects.toThrow('controlled observation persistence failure');
    expect(ctx.query.close).toHaveBeenCalledTimes(1);
    expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('error');
  } finally { vi.restoreAllMocks(); await ctx.close(); }
});

it('preserves both observation and native close failures and can retry owned cleanup', async () => {
  const ctx = await fixture();
  try {
    const append = ctx.store.appendEvent.bind(ctx.store);
    vi.spyOn(ctx.store, 'appendEvent').mockImplementation(value => {
      if (value.itemKey.endsWith(':unavailable')) throw new Error('controlled observation persistence failure');
      return append(value);
    });
    ctx.failClose(true);
    const error = await ctx.manager.dispose(ctx.sessionId).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as Error).cause).toBe((error as AggregateError).errors[1]);
    expect((error as AggregateError).errors.map((error: Error) => error.message)).toEqual(['controlled observation persistence failure', 'controlled native close failure']);
    expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('error');
    vi.restoreAllMocks(); ctx.failClose(false);
    await ctx.manager.dispose(ctx.sessionId);
    expect(currentClaudeTasks(ctx.store.allEvents(ctx.sessionId)).find(task => task.taskId === 'running')?.status).toBe('unknown');
    expect(ctx.closeAttempts()).toBe(2);
  } finally { vi.restoreAllMocks(); ctx.failClose(false); await ctx.close(); }
});
