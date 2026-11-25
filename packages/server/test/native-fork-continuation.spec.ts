import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentId, NativeActionResponse, SessionDto } from '@webdcc/protocol';
import { createTestApp } from './helpers.js';
import { nativeForkFixture } from './fixtures/native-fork-runtime.js';

async function setup(agent: AgentId = 'codex', options: { dbPath?: string; cwd?: string } = {}) {
  const ctx = await createTestApp({}, undefined, {}, { dbPath: options.dbPath });
  const cwd = options.cwd ?? ctx.dataDir;
  const workspace = ctx.store.createWorkspace('Native fork', cwd);
  const fixture = nativeForkFixture(agent, cwd);
  ctx.manager.registerAdapter(fixture.adapter);
  const source = ctx.store.createSession({ workspaceId: workspace.id, agent, model: 'fixture', reasoningEffort: 'high',
    accessMode: fixture.adapter.accessModes!()[0]!.id, title: 'Original native context' });
  ctx.store.updateSession(source.id, { nativeId: 'native-source' });
  await ctx.manager.connectNativeControls(source.id, { commandId: 'connect-source', action: { type: 'connect' } });
  const snapshot = await ctx.manager.nativeControls(source.id);
  const command = { commandId: 'fork-once', revision: snapshot.revision, action: { type: 'fork' } };
  return { ctx, fixture, source: ctx.store.getSession(source.id)!, workspace, command,
    url: `/api/sessions/${source.id}/native/actions`, headers: { cookie: ctx.cookie } };
}

it.each<AgentId>(['codex', 'claude-code', 'dsh'])('%s forks once, persists one native association, and resumes the fork without new create or old input replay', async agent => {
  const { ctx, fixture, source, workspace, command, url, headers } = await setup(agent);
  try {
    ctx.store.journal.enqueue('parent-queued', source.id, 'parent-turn', { text: '  original queued input🐈\n  ' });
    const original = ctx.store.getSession(source.id);
    const responses = await Promise.all(Array.from({ length: 20 }, () => ctx.app.inject({ method: 'POST', url, headers, payload: command })));
    expect(responses.every(response => response.statusCode === 200)).toBe(true);
    expect(fixture.forkCalls()).toBe(1);
    const recovered = await ctx.app.inject({ url: `${url}/${command.commandId}`, headers });
    const receipt = recovered.json<NativeActionResponse['receipt']>();
    expect(receipt).toMatchObject({ state: 'completed', continuation: { nativeId: 'native-fork-1', sourceNativeId: 'native-source', agent } });
    const childId = receipt.continuation!.sessionId;
    const child = ctx.store.getSession(childId)!;
    expect(child).toMatchObject({ nativeId: 'native-fork-1', workspaceId: workspace.id, agent, parentId: source.id, handoffKind: 'native-fork', providerId: source.providerId, model: 'fixture' });
    expect(ctx.store.listSessions(true).filter(session => session.nativeId === 'native-fork-1')).toHaveLength(1);
    expect(ctx.store.getSession(source.id)).toEqual(original);
    expect(ctx.manager.getRuntime(childId)).toBeUndefined();
    expect(fixture.creates).toHaveLength(0); expect(fixture.sends).toHaveLength(0);
    expect(ctx.store.journal.queue(source.id)[0]?.state).toBe('queued');
    const duplicate = await ctx.app.inject({ method: 'POST', url, headers, payload: command });
    expect(duplicate.json<NativeActionResponse>()).toEqual({ receipt });
    expect((await ctx.app.inject({ url: `/api/sessions/${childId}` , headers })).json<SessionDto>().nativeId).toBe('native-fork-1');
    await ctx.manager.send(childId, { text: '  continue exact fork🐈\n  ' }, 'fork-next-input');
    expect(fixture.creates).toHaveLength(0); expect(fixture.forkCalls()).toBe(1);
    expect(fixture.sends).toMatchObject([{ sessionId: childId, input: { text: '  continue exact fork🐈\n  ' } }]);
    const resumed = fixture.resumes.find(opts => opts.sessionId === childId)!;
    expect(resumed).toMatchObject({ nativeId: 'native-fork-1', cwd: workspace.path, model: 'fixture', providerId: null });
    if (agent === 'codex') {
      expect(child.accessMode).toBe('inherit'); expect(resumed.restoreNativeHistory).toBe(true);
      expect(resumed.accessMode).toBeUndefined(); // Native inherit omits permission overrides.
    }
    if (agent === 'claude-code') {
      expect(resumed.restoreClaudeForkConfiguration).toEqual({ nativeSessionId: 'native-fork-1', source: fixture.configuration });
      expect(resumed.restoreClaudeConfiguration).toBeUndefined();
      expect(ctx.manager.claudeConfiguration(childId)).toEqual({ state: 'none' });
    }
  } finally { await ctx.close(); }
});

it.each(['foreign-directory', 'source-id', 'reused-id', 'changed-source'])('does not associate an unconfirmed %s fork or repeat its native effect', async failure => {
  const { ctx, fixture, source, command, url, headers } = await setup();
  try {
    if (failure === 'reused-id') {
      const occupied = ctx.store.createSession({ workspaceId: source.workspaceId, agent: 'codex' });
      ctx.store.updateSession(occupied.id, { nativeId: 'native-fork-1' });
    }
    if (failure === 'foreign-directory') fixture.descriptor({ sourceNativeId: 'native-source', nativeId: 'native-fork-1', cwd: join(ctx.dataDir, 'foreign') });
    if (failure === 'source-id') fixture.descriptor({ sourceNativeId: 'native-source', nativeId: 'native-source', cwd: ctx.dataDir });
    if (failure === 'changed-source') {
      const fork = fixture.adapter.executeNativeControl!;
      fixture.adapter.executeNativeControl = async (id, action) => { const result = await fork(id, action); ctx.store.updateSession(id, { model: 'replaced-model' }); return result; };
    }
    const before = ctx.store.listSessions(true).length;
    const response = await ctx.app.inject({ method: 'POST', url, headers, payload: command });
    expect(response.statusCode).toBe(409);
    expect(ctx.store.listSessions(true)).toHaveLength(before);
    expect(ctx.store.nativeActions.get(command.commandId, source.id)).toMatchObject({ state: 'uncertain' });
    expect(ctx.store.nativeActions.get(command.commandId, source.id)?.continuation).toBeUndefined();
    expect((await ctx.app.inject({ method: 'POST', url, headers, payload: { ...command, commandId: 'no-second-native-fork' } })).statusCode).toBe(409);
    expect(fixture.forkCalls()).toBe(1);
  } finally { await ctx.close(); }
});

it('rolls back the whole association when its feed cannot persist, retaining the uncertain native outcome', async () => {
  const { ctx, fixture, source, command, url, headers } = await setup();
  try {
    const append = ctx.store.appendFeed.bind(ctx.store);
    vi.spyOn(ctx.store, 'appendFeed').mockImplementation((id, patch) => {
      if (id !== source.id && patch['created']) throw new Error('Controlled feed persistence failure');
      return append(id, patch);
    });
    expect((await ctx.app.inject({ method: 'POST', url, headers, payload: command })).statusCode).toBe(500);
    expect(ctx.store.listSessions(true)).toHaveLength(1);
    expect(ctx.store.nativeActions.get(command.commandId, source.id)).toMatchObject({ state: 'uncertain' });
    expect(fixture.forkCalls()).toBe(1);
  } finally { await ctx.close(); }
});

it('recovers the fork association after server restart without a writer or another fork', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-fork-restart-'));
  const cwd = join(directory, 'workspace'); await mkdir(cwd);
  const dbPath = join(directory, 'store.db');
  const first = await setup('codex', { dbPath, cwd });
  let closed = false;
  try {
    const response = await first.ctx.manager.executeNativeControl(first.source.id, first.command);
    const child = response.receipt.continuation!;
    await first.ctx.close(); closed = true;
    const second = await createTestApp({}, undefined, {}, { dbPath });
    try {
      const fixture = nativeForkFixture('codex', cwd); second.manager.registerAdapter(fixture.adapter);
      const stored = second.store.nativeActions.get(first.command.commandId, first.source.id)!;
      expect(stored.continuation).toEqual(child); expect(stored.state).toBe('completed');
      expect(second.manager.getRuntime(child.sessionId)).toBeUndefined();
      expect(await second.manager.executeNativeControl(first.source.id, first.command)).toEqual({ receipt: stored });
      expect(fixture.forkCalls()).toBe(0); expect(fixture.resumes).toHaveLength(0);
      await second.manager.send(child.sessionId, { text: 'continue after restart' }, 'restart-input');
      expect(fixture.resumes[0]?.nativeId).toBe(child.nativeId);
      expect(fixture.creates).toHaveLength(0); expect(fixture.forkCalls()).toBe(0);
    } finally { await second.close(); }
  } finally { if (!closed) await first.ctx.close(); await rm(directory, { recursive: true, force: true }); }
});
