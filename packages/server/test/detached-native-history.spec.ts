import { expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../../adapters/claude/src/adapter.js';
import { DshAdapter } from '../../adapters/dsh/src/adapter.js';
import { createTestApp } from './helpers.js';

it('reads existing native history without opening a writer or releasing an uncertain session', async () => {
  const ctx = await createTestApp();
  const adapter = new ClaudeAdapter();
  const history = vi.spyOn(adapter.nativeHistory, 'messages').mockResolvedValue({ source: 'claude-sdk', entries: [], nextOffset: 50, hasMore: true, revision: 'native-revision' });
  const create = vi.spyOn(adapter, 'create'); const resume = vi.spyOn(adapter, 'resume');
  ctx.manager.registerAdapter(adapter);
  try {
    const workspace = ctx.store.createWorkspace('Detached history', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    ctx.store.updateSession(session.id, { nativeId: 'native-source', status: 'error' });
    ctx.store.journal.enqueue('old-input', session.id, 'old-turn', { text: 'original input' });
    ctx.store.journal.inputState('old-turn', 'uncertain');
    const capabilities = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/reconciliation`, headers: { cookie: ctx.cookie } });
    expect(capabilities.json().capabilities).toMatchObject({ canObserve: false, canReadHistory: true, nativeId: 'native-source' });
    const reply = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/native/history?limit=50`, headers: { cookie: ctx.cookie } });
    expect(reply.statusCode).toBe(200); expect(reply.json()).toMatchObject({ source: 'claude-sdk', nativeId: 'native-source', nextOffset: 50 });
    expect(history).toHaveBeenCalledWith(ctx.dataDir, 'native-source', 0, 50);
    expect(create).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
    expect(ctx.store.getSession(session.id)?.status).toBe('error');
    expect(ctx.store.journal.queue(session.id)).toContainEqual(expect.objectContaining({ commandId: 'old-input', state: 'uncertain', input: { text: 'original input' } }));
    expect(ctx.store.allEvents(session.id).some(event => event.kind === 'turn.completed')).toBe(false);
  } finally { await ctx.close(); }
});

it('rejects a changed native identity while its detached history read is pending', async () => {
  const ctx = await createTestApp(); const adapter = new ClaudeAdapter();
  let finish!: (value: never) => void;
  vi.spyOn(adapter.nativeHistory, 'messages').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  ctx.manager.registerAdapter(adapter);
  try {
    const workspace = ctx.store.createWorkspace('Detached identity', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    ctx.store.updateSession(session.id, { nativeId: 'old-native' });
    const read = ctx.manager.readNativeHistory(session.id, { limit: 50 });
    ctx.store.updateSession(session.id, { nativeId: 'new-native' });
    finish({ source: 'claude-sdk', entries: [], hasMore: false, nextOffset: 0, revision: 'r' } as never);
    await expect(read).rejects.toMatchObject({ statusCode: 409 });
  } finally { await ctx.close(); }
});

it('does not spawn a new DSH Host to read a disconnected old native identity', async () => {
  const adapter = new DshAdapter();
  await expect(adapter.readNativeHistory('detached', { limit: 50 }, { nativeId: 'old-native', cwd: '/tmp' })).rejects.toMatchObject({ statusCode: 503 });
  expect(adapter.debugProcesses()).toEqual([]);
});
