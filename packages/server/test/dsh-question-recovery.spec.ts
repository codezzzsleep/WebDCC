import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';
import { bindDshQuestionFixture } from './fixtures/dsh-question.js';
import type { DshHostClient } from '../../adapters/dsh/src/host.js';

it('source question claims and current HTTP lookup stay sent until the matching native business result', async () => {
  const ctx = await createTestApp(); const { session, ask, result } = bindDshQuestionFixture(ctx); const id = ask();
  try {
    expect(await ctx.manager.answer(session.id, id, { selected: ['Continue'] }, 'native-answer-command')).toMatchObject({ submitted: true, confirmed: false });
    expect(ctx.store.interactions.get(session.id, 'answer', id)?.state).toBe('sent');
    const lookup = () => ctx.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/interactions/answer?${new URLSearchParams({ interactionId: id })}`, headers: { cookie: ctx.cookie } });
    expect((await lookup()).json().event.data).toMatchObject({ questionId: id, submission: 'sent' });
    expect((await lookup()).json().event.data.status).toBeUndefined();
    result(['Continue']);
    expect(ctx.store.interactions.get(session.id, 'answer', id)?.state).toBe('resolved');
    expect(ctx.store.getSession(session.id)?.status).toBe('idle');
    expect((await lookup()).json().event.data).toMatchObject({ questionId: id, toolCallId: 'native-question-call', status: 'answered', resolution: 'native-acknowledged' });
  } finally { await ctx.close(); }
});

it('another native UI answer retires only its exact foreground question, including a prior forwarding cancellation', async () => {
  const ctx = await createTestApp(); const { session, ask, result, feed } = bindDshQuestionFixture(ctx); const id = ask(); const other = ask('other-call', 'other-waterfall');
  try {
    feed({ type: 'cancel', eventId: 'native-question-waterfall' });
    result(['Stop']);
    expect(ctx.store.interactions.get(session.id, 'answer', id)?.state).toBe('resolved');
    expect(ctx.store.latestInteractionEvent(session.id, 'answer', id).event?.data).toMatchObject({ status: 'answered', resolution: 'external' });
    expect(ctx.store.interactions.get(session.id, 'answer', other)?.state).toBe('pending');
  } finally { await ctx.close(); }
});

for (const outcome of ['external-answer', 'native-cancel', 'matching-answer-lost-ack'] as const)
  it(`the actual command receipt preserves native ${outcome} when it races the reply transport`, async () => {
    const ctx = await createTestApp(); const { session, ask, result, native, feed } = bindDshQuestionFixture(ctx); const id = ask();
    const client = (native.adapter as unknown as { client: DshHostClient }).client;
    let release!: () => void;
    client.rpc = async <T>() => {
      await new Promise<void>(resolve => { release = resolve; });
      if (outcome === 'matching-answer-lost-ack') throw new Error('HTTP reply lost after native answer');
      return undefined as T;
    };
    const commandId = `native-command-${outcome}`;
    try {
      const sending = ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie },
        payload: { command: { op: 'answer', clientCommandId: commandId, sessionId: session.id, questionId: id, answer: { selected: ['Continue'] } } } });
      await expect.poll(() => typeof release).toBe('function');
      if (outcome === 'native-cancel') feed({ type: 'event', event: { type: 'tool/result', seq: 2, time: 2,
        data: { message: { toolCallId: 'native-question-call', isError: true, content: [{ type: 'text', text: 'question aborted' }] }, error: { name: 'UserQuestionError', code: 'ASK_ABORTED' } } } });
      else result(outcome === 'external-answer' ? ['Stop'] : ['Continue']);
      release();
      const response = (await sending).json();
      if (outcome === 'matching-answer-lost-ack') {
        expect(response).toMatchObject({ ok: true, value: { confirmed: true } });
        expect(ctx.store.journal.get(commandId)?.state).toBe('completed');
      } else {
        expect(response).toMatchObject({ ok: false, code: 'uncertain' });
        expect(ctx.store.journal.get(commandId)?.state).toBe('uncertain');
      }
    } finally { release?.(); await ctx.close(); }
  });
