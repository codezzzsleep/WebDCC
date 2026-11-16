import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';
import { bindDshSubagentFixture, createDshSubagentFixture } from '../../adapters/dsh/test/subagent-fixture.js';

it('authenticated child reads use the current parent without creating messages or accepting arbitrary child ids', async () => {
  const ctx = await createTestApp();
  const workspace = ctx.store.createWorkspace('DSH child reads', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
  const fixture = await createDshSubagentFixture(session.id);
  ctx.store.updateSession(session.id, { nativeId: fixture.parentId });
  bindDshSubagentFixture(ctx.manager, ctx.store.getSession(session.id)!, workspace.path, fixture.adapter, fixture.parentId);
  const get = (path: string) => ctx.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/subagents${path}`, headers: { cookie: ctx.cookie } });
  try {
    expect((await ctx.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/subagents` })).statusCode).toBe(401);
    const catalog = await get('');
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({ nativeId: fixture.parentId, items: [{ childId: 'reviewer', status: 'completed' }, { childId: 'failing', status: 'failed' }, { mode: 'one-shot' }, { mode: 'external', status: 'unknown' }] });
    const history = await get('/reviewer/history?limit=100');
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ address: { parentSessionId: fixture.parentId, childSessionId: 'reviewer', mode: 'continuable' }, cursor: 6 });
    for (const path of ['/foreign-child/history', '/external/history']) expect((await get(path)).statusCode).toBe(409);
    for (const path of ['/reviewer/history?limit=201', '/reviewer/history?limit=1oops', '/reviewer/history?beforeSeq=-1', '/reviewer/history?throughSeq=9007199254740992']) expect((await get(path)).statusCode).toBe(400);
    expect(ctx.store.allEvents(session.id).filter(event => ['user.message', 'assistant.message', 'turn.started'].includes(event.kind))).toEqual([]);
    expect(ctx.store.listSessions().map(item => item.id)).toEqual([session.id]);
    expect(fixture.calls.some(call => /prompt|cancel|interrupt/.test(call.method))).toBe(false);
  } finally { await ctx.close(); await fixture.close(); }
});
