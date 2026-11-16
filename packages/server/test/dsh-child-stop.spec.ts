import { expect, it, vi } from 'vitest';
import { createTestApp } from './helpers.js';
import { childRecord, createDshSubagentFixture } from '../../adapters/dsh/test/subagent-fixture.js';
import { waitUntil } from '../../adapters/dsh/src/host.js';

async function setup() {
  const ctx = await createTestApp();
  const workspace = ctx.store.createWorkspace('Independent DSH Stop', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
  const native = await createDshSubagentFixture(session.id); native.cold();
  ctx.store.updateSession(session.id, { nativeId: native.parentId }); ctx.manager.registerAdapter(native.adapter);
  const post = (child: string, commandId: string) => ctx.app.inject({ method: 'POST',
    url: `/api/sessions/${session.id}/subagents/${child}/interrupt`, headers: { cookie: ctx.cookie }, payload: { commandId } });
  return { ctx, session, native, post, close: async () => { await ctx.close(); await native.close(); } };
}

it('a cold parent stops only its child using the official user interrupt, retains its ACK and never resumes the parent', async () => {
  const { ctx, session, native, post, close } = await setup();
  const create = vi.spyOn(native.adapter, 'create'); const resume = vi.spyOn(native.adapter, 'resume');
  const state = native.states.get('reviewer')!; Object.assign(state, { active: true, running: true });
  try {
    const first = await post('reviewer', 'stop-reviewer-001'); expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ receipt: { commandId: 'stop-reviewer-001', type: 'dsh-child-interrupt', state: 'submitted', reference: { id: 'reviewer' } },
      result: { accepted: true, confirmed: false, address: { parentSessionId: native.parentId, childSessionId: 'reviewer', mode: 'continuable' } } });
    const repeat = await post('reviewer', 'stop-reviewer-001'); expect(repeat.statusCode).toBe(200); expect(repeat.json().receipt.state).toBe('submitted');
    expect((await post('failing', 'stop-reviewer-001')).statusCode).toBe(409);
    const writes = native.calls.filter(call => /interrupt|prompt|cancel/.test(call.method));
    expect(writes).toMatchObject([{ method: 'subagents/interruptByUser', args: { childSessionId: 'reviewer' } }]); expect(writes).toHaveLength(1);
    expect(writes[0]?.args).toEqual({ childSessionId: 'reviewer' });
    // The receipt proves acceptance; the fixture deliberately remains running.
    expect((await ctx.manager.listSubagents(session.id)).items[0]?.status).toBe('running');
    state.running = false; state.cursor = 7; native.records.get('reviewer')!.push(childRecord(7, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } }));
    expect((await ctx.manager.listSubagents(session.id)).items[0]?.status).toBe('stopped');
    expect(ctx.store.nativeActions.get('stop-reviewer-001', session.id)?.state).toBe('submitted');
    expect(create).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
    expect(ctx.manager.getRuntime(session.id)).toBeUndefined(); expect(ctx.store.nativeOwners.get(session.id)).toBeUndefined();
    expect(ctx.store.allEvents(session.id)).toEqual([]);
  } finally { await close(); }
});

it('a different actual Host during awaited child preflight cannot receive a stale Stop', async () => {
  const { ctx, session, native, post, close } = await setup();
  const host = await native.adapter.hostIdentity();
  vi.spyOn(native.adapter, 'hostIdentity').mockResolvedValueOnce(host).mockResolvedValueOnce(host).mockResolvedValueOnce({ ...host, fingerprint: 'a'.repeat(64) });
  try {
    expect((await post('reviewer', 'stop-new-host-001')).statusCode).toBe(409);
    expect(native.calls.some(call => call.method === 'subagents/interruptByUser')).toBe(false);
    expect(ctx.store.nativeActions.get('stop-new-host-001', session.id)?.state).toBe('failed');
    expect(ctx.manager.getRuntime(session.id)).toBeUndefined();
  } finally { await close(); }
});

it('untrusted child addresses and modes are rejected before a native Stop can be dispatched', async () => {
  const { ctx, session, native, post, close } = await setup();
  try {
    for (const child of ['foreign', 'external', 'once']) expect((await post(child, `stop-${child}-001`)).statusCode).toBe(409);
    expect(native.calls.some(call => /interrupt|prompt|cancel/.test(call.method))).toBe(false);
    expect(ctx.manager.getRuntime(session.id)).toBeUndefined(); expect(ctx.store.nativeOwners.get(session.id)).toBeUndefined();
    expect(ctx.store.nativeActions.get('stop-foreign-001', session.id)?.state).toBe('failed');
    expect((await post('reviewer', 'invalid')).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/subagents/reviewer/interrupt`, payload: { commandId: 'unauth-stop-001' } })).statusCode).toBe(401);
  } finally { await close(); }
});

it('a Store parent replacement during native preflight prevents the Stop, while a lost ACK stays uncertain and is never resent', async () => {
  const first = await setup(); const held = first.native.hold('session/projections', first.native.parentId);
  try {
    const request = first.post('reviewer', 'stop-preflight-001'); await held.seen;
    first.ctx.store.updateSession(first.session.id, { nativeId: 'new-native-parent' }); held.release();
    expect((await request).statusCode).toBe(409);
    expect(first.native.calls.some(call => call.method === 'subagents/interruptByUser')).toBe(false);
    expect(first.ctx.store.nativeActions.get('stop-preflight-001', first.session.id)?.state).toBe('failed');
  } finally { held.release(); await first.close(); }
  const second = await setup(); const ack = second.native.hold('subagents/interruptByUser', 'reviewer');
  try {
    const request = second.post('reviewer', 'stop-lost-ack-001'); await ack.seen;
    second.native.disconnect(); await waitUntil(() => !second.native.client.isConnected, 2000, 'native socket loss during Stop');
    ack.release(); expect((await request).statusCode).toBe(503);
    expect(second.ctx.store.nativeActions.get('stop-lost-ack-001', second.session.id)?.state).toBe('uncertain');
    const retry = await second.post('reviewer', 'stop-lost-ack-001'); expect(retry.statusCode).toBe(200); expect(retry.json().receipt.state).toBe('uncertain');
    expect(second.native.calls.filter(call => call.method === 'subagents/interruptByUser')).toHaveLength(1);
  } finally { ack.release(); await second.close(); }
});
