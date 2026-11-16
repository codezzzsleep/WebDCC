/** Production RPC capture/SQLite with controlled HTTP failure; no native Host/Provider. */
import { expect, it, vi } from 'vitest';
import type { CreateOpts, NativeFrameSink, SessionDto, TraceFrame, DshApprovalRecoveryView } from '@webdcc/protocol';
import { DshHostClient } from '../../adapters/dsh/src/host.js';
import { createTestApp } from './helpers.js';
import { bindDshApprovalRetry } from './fixtures/dsh-approval-retry.js';

it('only permits the proven same-event reply after a captured HTTP failure, retaining the ordinary write fence', async () => {
  const ctx = await createTestApp(); const native = bindDshApprovalRetry(ctx); const host = new DshHostClient('http://native.test/dsh/');
  const captures: TraceFrame[] = []; const requests: Record<string, unknown>[] = [];
  try {
    const launch = await (ctx.manager as unknown as { prepareLaunch(session: SessionDto, options: CreateOpts): Promise<CreateOpts> })
      .prepareLaunch(native.session, { sessionId: native.session.id, cwd: ctx.dataDir });
    const sink = launch.nativeEvents!;
    (native.native.adapter as unknown as { nativeSinks: Map<string, NativeFrameSink> }).nativeSinks.set(native.session.id, {
      record(frame) { captures.push(frame); return sink.record(frame); },
    });
    native.client.rpc = host.rpc.bind(host);
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit) => {
      expect(String(url)).toBe('http://native.test/dsh/api/$events/result');
      const body = JSON.parse(String(init.body)) as { rpcId: string; payload: { args: Record<string, unknown> } };
      requests.push(body.payload.args);
      if (requests.length === 1) throw new Error('controlled first HTTP transport loss');
      return new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true } }));
    });
    const post = (id: string, retryOf?: { commandId: string; revision: string }) => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: {
      op: 'approve', sessionId: native.session.id, approvalId: native.approvalId, optionId: 'allowed-once', clientCommandId: id,
      ...(retryOf === undefined ? {} : { retryOf }),
    } } });
    expect((await post('http-original')).json()).toMatchObject({ ok: false, code: 'uncertain' });
    native.reoffer();
    const response = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${native.session.id}/dsh/approval-recovery?approvalId=${native.approvalId}`, headers: { cookie: ctx.cookie } });
    const recovery = response.json() as DshApprovalRecoveryView;
    expect(recovery.status).toBe('available'); if (recovery.status !== 'available') throw new Error(recovery.reason);
    expect((await post('http-explicit-retry', recovery.retryOf)).json()).toEqual({ ok: true });
    await expect(native.native.adapter.interrupt(native.session.id)).rejects.toMatchObject({ code: 'uncertain' });
    expect(requests).toEqual([
      { clientId: 'current-client', eventId: native.approvalId, outcome: { kind: 'result', value: 'allowed-once' } },
      { clientId: 'replacement-client', eventId: native.approvalId, outcome: { kind: 'result', value: 'allowed-once' } },
    ]);
    expect(captures.filter(frame => frame.ch === 'rpc:$events/result' && frame.dir === 'out')).toHaveLength(2);
    expect(captures.some(frame => (frame.frame as { dshTransport?: { coverage: string } }).dshTransport?.coverage === 'transport-error')).toBe(true);
    native.record('approval/decided', { id: 'durable-approval', outcome: 'allowed-once' });
    expect(ctx.store.journal.get('http-original')?.state).toBe('uncertain');
    expect(ctx.store.journal.get('http-explicit-retry')?.state).toBe('uncertain');
  } finally { vi.unstubAllGlobals(); await host.close(); await ctx.close(); }
});
