import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { Command } from '@webdcc/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import { CommandDispatcher } from '../src/dispatcher.js';
import { createTestApp } from './helpers.js';

const agents = ['codex', 'claude-code', 'dsh'] as const;
async function evidence(name: string, value: unknown): Promise<void> {
  const directory = process.env['WDCC_OWNER_ADMISSION_EVIDENCE_DIR'];
  if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
}

it.each(agents)('%s owner SQL failure is definitely unsubmitted, retained after reopening, and recoverable with a new user command', async agent => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-owner-admission-')); const path = join(directory, 'db.sqlite');
  const ctx = await createTestApp({}, undefined, {}, { dbPath: path }); const fault = openDb(path);
  const adapter = ctx.manager.adapter(agent)!; let resumes = 0; let sends = 0;
  adapter.resume = async () => { resumes++; }; adapter.send = async () => { sends++; };
  try {
    const workspace = ctx.store.createWorkspace('owner admission', directory);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent }); ctx.store.updateSession(session.id, { nativeId: 'controlled-native' });
    fault.exec("CREATE TRIGGER refuse_owner BEFORE INSERT ON native_owners BEGIN SELECT RAISE(ABORT, 'controlled owner SQL failure'); END");
    const command: Command = { op: 'send', sessionId: session.id, clientCommandId: `failed-${agent}`, text: 'retained input' };
    const submit = (value: Command) => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: value } });
    const rejected = await submit(command); const record = ctx.store.journal.get(command.clientCommandId);
    await evidence(`before-retry-${agent}`, { command, response: rejected.json(), record, resumes, sends,
      queue: ctx.store.journal.queue(session.id), owner: ctx.store.nativeOwners.get(session.id) ?? null, events: ctx.store.allEvents(session.id) });
    expect(rejected.json()).toMatchObject({ ok: false, code: 'failed', error: 'controlled owner SQL failure' });
    expect(record).toMatchObject({ state: 'failed', turnId: null }); expect(resumes).toBe(0); expect(sends).toBe(0);
    expect(ctx.manager.getRuntime(session.id)).toBeUndefined(); expect(ctx.store.nativeOwners.get(session.id)).toBeUndefined();
    expect(ctx.store.journal.queue(session.id)).toHaveLength(0); expect(ctx.store.allEvents(session.id)).toHaveLength(0);
    const replay = await submit(command); expect(replay.json()).toEqual(rejected.json()); expect(resumes).toBe(0);
    fault.exec('DROP TRIGGER refuse_owner'); const accepted = await submit({ ...command, clientCommandId: `new-${agent}` });
    expect(accepted.json().ok).toBe(true); expect(resumes).toBe(1); expect(sends).toBe(1);
    expect(ctx.store.journal.get(command.clientCommandId)).toEqual(record);
    const reopened = openDb(path);
    try { expect(new Store(reopened).journal.get(command.clientCommandId)).toEqual(record); }
    finally { reopened.close(); }
    await evidence(`recovered-${agent}`, { replay: replay.json(), accepted: accepted.json(), oldRecord: ctx.store.journal.get(command.clientCommandId),
      newRecord: ctx.store.journal.get(`new-${agent}`), resumes, sends, events: ctx.store.allEvents(session.id) });
  } finally { fault.close(); await ctx.close(); await rm(directory, { recursive: true, force: true }); }
});

it.each(agents)('%s an error after resume starts remains uncertain and is never replayed blindly', async agent => {
  const ctx = await createTestApp(); const adapter = ctx.manager.adapter(agent)!; let resumes = 0;
  adapter.resume = async () => { resumes++; throw new Error('controlled unknown resume outcome'); };
  try {
    const workspace = ctx.store.createWorkspace('unknown resume', ctx.dataDir); const session = ctx.store.createSession({ workspaceId: workspace.id, agent });
    ctx.store.updateSession(session.id, { nativeId: 'controlled-native' });
    const command = { op: 'send', sessionId: session.id, clientCommandId: `resume-${agent}`, text: 'unknown resume input' };
    const response = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    await evidence(`resume-${agent}`, { response: response.json(), record: ctx.store.journal.get(command.clientCommandId), resumes,
      queue: ctx.store.journal.queue(session.id), events: ctx.store.allEvents(session.id) });
    expect(response.json()).toMatchObject({ ok: false, code: 'uncertain' }); expect(resumes).toBe(1);
    expect(ctx.store.journal.get(command.clientCommandId)?.state).toBe('uncertain');
    const replay = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    expect(replay.json().code).toBe('uncertain'); expect(resumes).toBe(1);
  } finally { await ctx.close(); }
});

it.each(agents)('%s an unknown send result retains its uncertain input instead of being mislabeled unsubmitted', async agent => {
  const ctx = await createTestApp(); const adapter = ctx.manager.adapter(agent)!; let sends = 0;
  adapter.resume = async () => undefined; adapter.send = async () => { sends++; throw new Error('controlled unknown send outcome'); };
  try {
    const workspace = ctx.store.createWorkspace('unknown send', ctx.dataDir); const session = ctx.store.createSession({ workspaceId: workspace.id, agent });
    ctx.store.updateSession(session.id, { nativeId: 'controlled-native' });
    const command = { op: 'send', sessionId: session.id, clientCommandId: `send-${agent}`, text: 'native outcome unknown' };
    const response = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    await evidence(`send-${agent}`, { response: response.json(), record: ctx.store.journal.get(command.clientCommandId), sends,
      queue: ctx.store.journal.queue(session.id), events: ctx.store.allEvents(session.id) });
    expect(response.json()).toMatchObject({ ok: false, code: 'uncertain' }); expect(sends).toBe(1);
    expect(ctx.store.journal.queue(session.id)[0]?.state).toBe('uncertain');
    expect(ctx.store.allEvents(session.id).some(event => event.kind === 'turn.completed')).toBe(false);
  } finally { await ctx.close(); }
});

it('a live owner conflict remains explicit without releasing or changing its generation', async () => {
  const ctx = await createTestApp(); const other = new SessionManager(ctx.store, { idleDisposeMin: 0 });
  const adapter = new FakeAdapter({ id: 'codex' }); let resumes = 0; adapter.resume = async () => { resumes++; }; other.registerAdapter(adapter);
  try {
    const workspace = ctx.store.createWorkspace('owner conflict', ctx.dataDir); const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const owner = ctx.store.nativeOwners.get(session.id); const dispatcher = new CommandDispatcher(ctx.store, other, ctx.files);
    const result = await dispatcher.dispatch({ op: 'send', sessionId: session.id, clientCommandId: 'owner-conflict', text: 'not admitted' });
    expect(result).toMatchObject({ ok: false, code: 'conflict' }); expect(resumes).toBe(0);
    expect(ctx.store.nativeOwners.get(session.id)).toEqual(owner);
    expect(ctx.store.journal.get('owner-conflict')?.state).toBe('failed');
  } finally { await other.disposeAll(); await ctx.close(); }
});

it('a real owner write-lock timeout preserves SQLITE_BUSY and becomes a failed unsubmitted receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-owner-admission-lock-')); const path = join(directory, 'db.sqlite');
  const ctx = await createTestApp({}, undefined, {}, { dbPath: path }); const peer = openDb(path);
  const adapter = ctx.manager.adapter('codex')!; let resumes = 0; adapter.resume = async () => { resumes++; };
  const acquire = ctx.store.nativeOwners.acquire.bind(ctx.store.nativeOwners);
  let observed: { code?: string; nativeAdmission?: string } | undefined;
  ctx.store.nativeOwners.acquire = (...args) => {
    peer.exec('BEGIN IMMEDIATE');
    try { return acquire(...args); }
    catch (error) { observed = error as typeof observed; throw error; }
    finally { peer.exec('ROLLBACK'); }
  };
  try {
    const workspace = ctx.store.createWorkspace('owner SQL lock', directory); const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    ctx.store.updateSession(session.id, { nativeId: 'controlled-native' });
    const command = { op: 'send', sessionId: session.id, clientCommandId: 'owner-lock', text: 'never submitted' };
    const response = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    await evidence('lock-timeout', { command, response: response.json(), observed, record: ctx.store.journal.get(command.clientCommandId), resumes,
      owner: ctx.store.nativeOwners.get(session.id) ?? null, queue: ctx.store.journal.queue(session.id), events: ctx.store.allEvents(session.id) });
    expect(observed).toMatchObject({ code: 'SQLITE_BUSY', nativeAdmission: 'not-submitted' });
    expect(response.json()).toMatchObject({ ok: false, code: 'failed', error: 'database is locked' }); expect(resumes).toBe(0);
    expect(ctx.store.journal.get(command.clientCommandId)?.state).toBe('failed'); expect(ctx.store.nativeOwners.get(session.id)).toBeUndefined();
    expect(ctx.store.journal.queue(session.id)).toHaveLength(0); expect(ctx.store.allEvents(session.id)).toHaveLength(0);
  } finally { peer.close(); await ctx.close(); await rm(directory, { recursive: true, force: true }); }
});
