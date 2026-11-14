import { expect, it } from 'vitest';
import type { AgentAdapter, NativeActionRequest } from '@webdcc/protocol';
import { FakeAdapter } from '@webdcc/fake-adapter';
import { createTestApp } from './helpers.js';

async function setup() {
  const ctx = await createTestApp();
  const workspace = ctx.store.createWorkspace('native', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
  ctx.store.updateSession(session.id, { nativeId: 'native' });
  let revision = 1; let catalogue = 1; let sends = 0; let controls = 0;
  const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' });
  adapter.nativeState = () => ({ revision, nativeId: 'native', turnActive: false });
  adapter.nativeCatalog = async () => ({ revision: catalogue, actions: [{ type: 'rename', label: '修改原生标题', supported: true, schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }] });
  adapter.send = async () => { sends++; };
  adapter.executeNativeControl = async (_id, value) => { controls++; revision++; return value; };
  ctx.manager.registerAdapter(adapter);
  const base = `/api/sessions/${session.id}/native`;
  const headers = { cookie: ctx.cookie };
  return { ctx, session, base, headers, stats: () => ({ sends, controls }), changeCatalog: () => { catalogue++; }, setControl: (run: NonNullable<AgentAdapter['executeNativeControl']>) => { adapter.executeNativeControl = run; } };
}

it('native reads require auth and explicit connection; connection never sends queued input', async () => {
  const { ctx, session, base, headers, stats } = await setup();
  try {
    expect((await ctx.app.inject({ url: base })).statusCode).toBe(401);
    expect((await ctx.app.inject({ url: base, headers })).statusCode).toBe(409);
    expect(ctx.manager.getRuntime(session.id)).toBeUndefined();
    ctx.store.journal.enqueue('queued-native', session.id, 'queued-turn', { text: 'must remain queued' });
    const connect = await ctx.app.inject({ method: 'POST', url: `${base}/connect`, headers, payload: { commandId: 'connect-001', action: { type: 'connect' } } });
    expect(connect.statusCode).toBe(200); expect(connect.json().receipt.state).toBe('completed');
    expect((await ctx.app.inject({ url: `${base}?catalog=1`, headers })).statusCode).toBe(200);
    expect(stats()).toEqual({ sends: 0, controls: 0 }); expect(ctx.store.journal.queue(session.id)[0]?.state).toBe('queued');
  } finally { await ctx.close(); }
});

it('native controls bind catalogue and runtime revisions, and twenty duplicate commands execute once', async () => {
  const { ctx, session, base, headers, stats, changeCatalog } = await setup();
  try {
    await ctx.manager.connectNativeControls(session.id, { commandId: 'connect-002', action: { type: 'connect' } });
    const first = await ctx.manager.nativeControls(session.id, true); changeCatalog();
    await expect(ctx.manager.executeNativeControl(session.id, { commandId: 'stale-command', revision: first.revision, action: { type: 'rename', title: 'stale' } })).rejects.toMatchObject({ code: 'native-control-rejected' });
    expect(stats().controls).toBe(0); expect(ctx.store.nativeActions.get('stale-command', session.id)?.state).toBe('failed');
    const current = await ctx.manager.nativeControls(session.id, true);
    const command: NativeActionRequest = { commandId: 'same-command', revision: current.revision, action: { type: 'rename', title: 'exact title' } };
    const results = await Promise.all(Array.from({ length: 20 }, () => ctx.app.inject({ method: 'POST', url: `${base}/actions`, headers, payload: command })));
    expect(results.every(result => result.statusCode === 200)).toBe(true); expect(stats().controls).toBe(1);
    expect((await ctx.app.inject({ method: 'POST', url: `${base}/actions`, headers, payload: { ...command, action: { type: 'rename', title: 'different' } } })).statusCode).toBe(409);
    expect(ctx.store.nativeActions.get('same-command', session.id)?.state).toBe('completed');
  } finally { await ctx.close(); }
});

it('lost native outcomes block fresh IDs; explicit preflight rejection allows corrected retry and secret bodies are absent', async () => {
  const { ctx, session, setControl } = await setup();
  try {
    await ctx.manager.connectNativeControls(session.id, { commandId: 'connect-003', action: { type: 'connect' } });
    const current = await ctx.manager.nativeControls(session.id, true);
    setControl(async () => { throw Object.assign(new Error('invalid schema'), { code: 'native-control-rejected' }); });
    await expect(ctx.manager.executeNativeControl(session.id, { commandId: 'invalid-answer', revision: current.revision, action: { type: 'elicitation', requestId: 'request', content: 'never-stored-secret' } })).rejects.toThrow('invalid schema');
    setControl(async () => ({ confirmed: false }));
    const sent = await ctx.manager.executeNativeControl(session.id, { commandId: 'corrected-answer', revision: current.revision, action: { type: 'elicitation', requestId: 'request', content: 'never-stored-secret' } });
    expect(sent.receipt.state).toBe('submitted');
    expect(JSON.stringify(sent.receipt)).not.toContain('never-stored-secret');
    await expect(ctx.manager.executeNativeControl(session.id, { commandId: 'fresh-answer-id', revision: current.revision, action: { type: 'elicitation', requestId: 'request', content: 'never-stored-secret' } })).rejects.toThrow('不能重复提交');
    setControl(async () => { throw new Error('native connection lost'); });
    await expect(ctx.manager.executeNativeControl(session.id, { commandId: 'lost-action', revision: current.revision, action: { type: 'rename', title: 'rename' } })).rejects.toThrow('native connection lost');
    expect(ctx.store.nativeActions.get('lost-action', session.id)?.state).toBe('uncertain');
    await expect(ctx.manager.executeNativeControl(session.id, { commandId: 'new-lost-action', revision: current.revision, action: { type: 'rename', title: 'rename' } })).rejects.toThrow('不能重复提交');
  } finally { await ctx.close(); }
});
