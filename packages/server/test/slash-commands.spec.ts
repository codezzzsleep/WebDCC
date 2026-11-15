import { expect, it } from 'vitest';
import type { AgentAdapter } from '@webdcc/protocol';
import { FakeAdapter } from '@webdcc/fake-adapter';
import { createTestApp } from './helpers.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, CURRENT_SCHEMA_VERSION } from '../src/db.js';
import { Store } from '../src/store.js';
import { codexSlashCommands } from '../../adapters/codex/src/slash.js';

it('authenticated pre-creation discovery reads the Codex catalog without creating or resuming a session', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('new slash', ctx.dataDir);
    const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' });
    const calls: (string | undefined)[] = [];
    adapter.previewSlashCommands = async cwd => { calls.push(cwd); return codexSlashCommands; };
    adapter.create = async () => { throw new Error('Discovery activated a writer'); };
    adapter.resume = async () => { throw new Error('Discovery resumed a writer'); };
    adapter.send = async () => { throw new Error('Discovery sent model input'); };
    ctx.manager.registerAdapter(adapter);
    const url = `/api/agents/codex/slash-commands?workspaceId=${workspace.id}`;
    expect((await ctx.app.inject({ url })).statusCode).toBe(401);
    const response = await ctx.app.inject({ url, headers: { cookie: ctx.cookie } });
    expect(response.json()).toMatchObject({ agent: 'codex', status: 'ready', commands: expect.any(Array) });
    expect(response.json().commands).toEqual(codexSlashCommands);
    expect(calls).toEqual([workspace.path]);
    expect(ctx.store.listSessions()).toEqual([]);
    expect((await ctx.app.inject({ url: '/api/agents/codex/slash-commands?workspaceId=missing', headers: { cookie: ctx.cookie } })).statusCode).toBe(404);
  } finally { await ctx.close(); }
});

it('pre-creation discovery preserves failure and empty reasons without using session-bound fallback', async () => {
  const ctx = await createTestApp();
  try {
    const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' });
    adapter.slashCommands = async () => { throw new Error('Session-bound fallback used'); };
    ctx.manager.registerAdapter(adapter);
    const read = () => ctx.app.inject({ url: '/api/agents/codex/slash-commands', headers: { cookie: ctx.cookie } });
    expect((await read()).json()).toMatchObject({ status: 'empty', reason: expect.stringContaining('建立原生会话后') });
    adapter.previewSlashCommands = async () => { throw new Error('native version unavailable'); };
    expect((await read()).json()).toMatchObject({ status: 'error', reason: expect.stringContaining('native version unavailable'), commands: [] });
    adapter.previewSlashCommands = async () => [];
    expect((await read()).json()).toMatchObject({ status: 'empty', reason: expect.stringContaining('没有返回'), commands: [] });
    expect(ctx.store.listSessions()).toEqual([]);
  } finally { await ctx.close(); }
});

it('pre-creation metadata explains a baseline preview and keeps it out of the session-bound catalog', async () => {
  const ctx = await createTestApp();
  try {
    const adapter: AgentAdapter = new FakeAdapter({ id: 'dsh' });
    adapter.previewSlashCommands = async () => ({ commands: [{ name: '/goal', source: 'native baseline' }], reason: '实际会话目录将在创建后核对' });
    adapter.slashCommands = async () => [{ name: '/project-only', source: 'actual scoped directory' }];
    ctx.manager.registerAdapter(adapter);
    const preview = await ctx.app.inject({ url: '/api/agents/dsh/slash-commands', headers: { cookie: ctx.cookie } });
    expect(preview.json()).toMatchObject({ status: 'ready', reason: '实际会话目录将在创建后核对', commands: [{ name: '/goal' }] });
    expect(ctx.store.listSessions()).toEqual([]);
  } finally { await ctx.close(); }
});

async function fixture() {
  const ctx = await createTestApp(); const workspace = ctx.store.createWorkspace('slash', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
  ctx.store.updateSession(session.id, { nativeId: 'native-slash-session' });
  const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' });
  adapter.slashCommands = async () => [{ name: '/goal', route: 'native-control', supportsAttachments: false }, { name: '/theme', route: 'native-terminal' }];
  ctx.manager.registerAdapter(adapter);
  const headers = { cookie: ctx.cookie }; const url = `/api/sessions/${session.id}/slash-commands`;
  return { ctx, adapter, session, headers, url };
}
it('catalog distinguishes native failure from a successfully read empty directory and preserves the reason', async () => {
  const { ctx, adapter, headers, url } = await fixture();
  try {
    expect((await ctx.app.inject({ url })).statusCode).toBe(401);
    adapter.slashCommands = async () => { throw new Error('Host rejected catalog: native permission denied'); };
    const failed = await ctx.app.inject({ url, headers });
    expect(failed.json()).toMatchObject({ commands: [], status: 'error', reason: expect.stringContaining('native permission denied') });
    adapter.slashCommands = async () => [];
    expect((await ctx.app.inject({ url, headers })).json()).toMatchObject({ commands: [], status: 'empty', revision: expect.any(String) });
  } finally { await ctx.close(); }
});
it('twenty copies of an API-backed slash command execute once, preserve the complete line and persist its output', async () => {
  const { ctx, adapter, session, headers, url } = await fixture();
  try {
    let calls = 0; let line = '';
    adapter.executeSlashControl = async (_id, input) => { calls++; line = input; return { text: 'Native goal is paused' }; };
    adapter.send = async () => { throw new Error('slash controls must not enter the model-input path'); };
    const catalog = await ctx.manager.slashCommandCatalog(session.id);
    const payload = { commandId: 'SLASH-ONCE', revision: catalog.revision, line: '/goal\n  pause  ' };
    const replies = await Promise.all(Array.from({ length: 20 }, () => ctx.app.inject({ method: 'POST', url, headers, payload })));
    expect(replies.every(reply => reply.statusCode === 200)).toBe(true); expect(calls).toBe(1); expect(line).toBe(payload.line);
    expect(ctx.store.nativeActions.get(payload.commandId, session.id)?.state).toBe('completed');
    expect(ctx.store.allEvents(session.id).filter(event => event.kind === 'notice')).toHaveLength(1);
    expect(ctx.store.allEvents(session.id).at(-1)?.data).toMatchObject({ nativeType: 'slash.command', text: expect.stringContaining('Native goal is paused') });
    expect(ctx.store.journal.queue(session.id)).toHaveLength(0);
    const replay = await ctx.app.inject({ method: 'POST', url, headers, payload });
    expect(replay.json()).toMatchObject({ result: { text: 'Native goal is paused' } });
    expect((await ctx.app.inject({ url: `${url}/${payload.commandId}`, headers })).json()).toMatchObject({ result: { text: 'Native goal is paused' } });
    expect((await ctx.app.inject({ url: `${url}/${payload.commandId}` })).statusCode).toBe(401);
    expect(calls).toBe(1);
  } finally { await ctx.close(); }
});
it('stale directory revisions and terminal-only command names cannot become arbitrary native API calls', async () => {
  const { ctx, adapter, session, headers, url } = await fixture();
  try {
    let calls = 0; adapter.executeSlashControl = async () => { calls++; return {}; };
    const catalog = await ctx.manager.slashCommandCatalog(session.id);
    const stale = await ctx.app.inject({ method: 'POST', url, headers, payload: { commandId: 'STALE-CATALOG', revision: 'stale', line: '/goal' } });
    expect(stale.statusCode).toBe(409);
    const terminal = await ctx.app.inject({ method: 'POST', url, headers, payload: { commandId: 'TERMINAL-API', revision: catalog.revision, line: '/theme' } });
    expect(terminal.statusCode).toBe(400); expect(calls).toBe(0);
  } finally { await ctx.close(); }
});
it('native command negative results stay visible as failed and lost outcomes prevent blind resubmission', async () => {
  const { ctx, adapter, session, headers, url } = await fixture();
  try {
    const catalog = await ctx.manager.slashCommandCatalog(session.id);
    adapter.executeSlashControl = async () => ({ failed: true, text: 'Native goal service unavailable' });
    const response = await ctx.app.inject({ method: 'POST', url, headers, payload: { commandId: 'NATIVE-FAILED', revision: catalog.revision, line: '/goal' } });
    expect(response.json()).toMatchObject({ receipt: { state: 'failed' }, result: { failed: true, text: 'Native goal service unavailable' } });
    let calls = 0; adapter.executeSlashControl = async () => { calls++; throw new Error('Native response lost'); };
    await ctx.app.inject({ method: 'POST', url, headers, payload: { commandId: 'OUTCOME-LOST', revision: catalog.revision, line: '/goal pause' } });
    expect(ctx.store.nativeActions.get('OUTCOME-LOST', session.id)?.state).toBe('uncertain');
    const retry = await ctx.app.inject({ method: 'POST', url, headers, payload: { commandId: 'OUTCOME-RETRY', revision: catalog.revision, line: '/goal pause' } });
    expect(retry.statusCode).toBe(409); expect(calls).toBe(1);
  } finally { await ctx.close(); }
});
it('schema v13 upgrades without losing receipts; slash output then survives reopening the SQLite database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-slash-migration-')); const path = join(root, 'state.db');
  let db = openDb(path);
  try {
    let store = new Store(db); const workspace = store.createWorkspace('migration', root);
    const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    await store.nativeActions.execute(session.id, { commandId: 'MIGRATION-SLASH', action: { type: 'slash-goal' } }, async () => ({}));
    db.exec('DROP TABLE slash_results'); db.pragma('user_version = 13'); db.close();
    db = openDb(path); store = new Store(db);
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(store.getSession(session.id)).toBeDefined();
    expect(store.nativeActions.get('MIGRATION-SLASH', session.id)?.state).toBe('completed');
    store.nativeActions.saveSlashResult('MIGRATION-SLASH', session.id, { form: 'goal-edit', objective: '原生目标\n第二行' }); db.close();
    db = openDb(path); store = new Store(db);
    expect(store.nativeActions.slashResult('MIGRATION-SLASH', session.id)).toMatchObject({ receipt: { state: 'completed' }, result: { form: 'goal-edit', objective: '原生目标\n第二行' } });
  } finally { if (db.open) db.close(); await rm(root, { recursive: true, force: true }); }
});
