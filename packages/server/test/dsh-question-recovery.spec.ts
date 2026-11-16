import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';
import { bindDshQuestionFixture } from './fixtures/dsh-question.js';

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
