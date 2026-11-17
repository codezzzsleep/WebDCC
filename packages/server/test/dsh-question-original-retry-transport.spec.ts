/** Production RPC capture and SQLite with controlled HTTP failure; no native Host/Provider. */
import { expect, it, vi } from 'vitest';
import type { CreateOpts, NativeFrameSink, SessionDto, TraceFrame, DshQuestionRecoveryView } from '@webdcc/protocol';
import { DshHostClient } from '../../adapters/dsh/src/host.js';
import { createTestApp } from './helpers.js';
import { bindDshQuestionOriginalRetry } from './fixtures/dsh-question-original-retry.js';

it('durably captures the full batch before HTTP and only bypasses the ordinary write fence for its same-event retry', async () => {
  const ctx = await createTestApp(); const group = bindDshQuestionOriginalRetry(ctx); const host = new DshHostClient('http://native.test/dsh/');
  const captures: TraceFrame[] = []; const requests: Record<string, unknown>[] = [];
  try {
    const launch = await (ctx.manager as unknown as { prepareLaunch(session: SessionDto, options: CreateOpts): Promise<CreateOpts> })
      .prepareLaunch(group.session, { sessionId: group.session.id, cwd: ctx.dataDir });
    const sink = launch.nativeEvents!;
    (group.native.adapter as unknown as { nativeSinks: Map<string, NativeFrameSink> }).nativeSinks.set(group.session.id, {
      record(frame) { captures.push(frame); return sink.record(frame); },
    });
    group.client.rpc = host.rpc.bind(host);
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit) => {
      expect(String(url)).toBe('http://native.test/dsh/api/$events/result');
      const body = JSON.parse(String(init.body)) as { rpcId: string; payload: { args: Record<string, unknown> } };
      const original = ctx.store.interactions.dshQuestionOriginal(ctx.store.interactions.get(group.session.id, 'answer', group.ids[1]!)!);
      expect(original?.answers).toEqual([{ id: 'one', selected: ['Keep'], custom: 'first\r\n ' }, { id: 'two', selected: ['Second'], custom: '\n second' }]);
      requests.push(body.payload.args);
      if (requests.length === 1) throw new Error('controlled first HTTP transport loss');
      return new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true } }));
    });
    const post = (id: string, questionId: string, answer: unknown, retryOf?: { commandId: string; revision: string }) => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: {
      op: 'answer', sessionId: group.session.id, questionId, answer, clientCommandId: id, ...(retryOf === undefined ? {} : { retryOf }),
    } } });
    expect((await post('http-partial', group.ids[0]!, { selected: ['Keep'], custom: 'first\r\n ' })).json()).toMatchObject({ ok: true, value: { submitted: false } });
    expect((await post('http-original', group.ids[1]!, { selected: ['Second'], custom: '\n second' })).json()).toMatchObject({ ok: false, code: 'uncertain' });
    group.reoffer();
    const response = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${group.session.id}/dsh/question-recovery?${new URLSearchParams({ questionId: group.ids[1]! })}`, headers: { cookie: ctx.cookie } });
    const view = response.json() as DshQuestionRecoveryView;
    expect(view.status).toBe('available'); if (view.status !== 'available') throw new Error(view.reason);
    const answers = view.items.map(({ id, selected, custom }) => ({ id, selected, custom }));
    expect((await post('http-explicit-retry', group.ids[1]!, { answers }, view.retryOf)).json()).toMatchObject({ ok: true, value: { confirmed: false } });
    await expect(group.native.adapter.interrupt(group.session.id)).rejects.toMatchObject({ code: 'uncertain' });
    expect(requests).toEqual([{ clientId: 'current-client', eventId: group.eventId, outcome: { kind: 'result', value: { answers } } },
      { clientId: 'replacement-question-client', eventId: group.eventId, outcome: { kind: 'result', value: { answers } } }]);
    expect(captures.filter(frame => frame.ch === 'rpc:$events/result' && frame.dir === 'out')).toHaveLength(2);
    expect(captures.some(frame => (frame.frame as { dshTransport?: { coverage: string } }).dshTransport?.coverage === 'transport-error')).toBe(true);
    group.record('tool/result', { message: { toolCallId: group.callId, isError: false, content: [{ type: 'text', text: JSON.stringify({ answers }) }] } });
    expect(ctx.store.journal.get('http-original')?.state).toBe('uncertain'); expect(ctx.store.journal.get('http-explicit-retry')?.state).toBe('uncertain');
  } finally { vi.unstubAllGlobals(); await host.close(); await ctx.close(); }
});
