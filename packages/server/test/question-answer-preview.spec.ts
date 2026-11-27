import { expect, it } from 'vitest';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

it('previews the exact accepted group answer from its own command across refresh without changing native events', async () => {
  const ctx = await createTestApp();
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'claude-code');
    const answer = { selected: ['first'], custom: '  中文原文\n第二行  ' };
    const q = ctx.store.appendEvent({ sessionId, turnId: 'turn', kind: 'question', itemKey: 'one', data: { questionId: 'one', groupId: 'group', prompt: '受众？' } });
    ctx.store.appendEvent({ sessionId, turnId: 'turn', kind: 'question', itemKey: 'two', data: { questionId: 'two', groupId: 'group', prompt: '范围？' } });
    ctx.store.journal.claim({ op: 'answer', clientCommandId: 'actual-answer-one', sessionId, questionId: 'one', answer });
    const row = ctx.store.interactions.claim(sessionId, 'answer', 'one', 'actual-answer-one'); ctx.store.interactions.finish(row, true);
    const before = ctx.store.allEvents(sessionId);
    const url = `/api/sessions/${sessionId}/interactions/answer?interactionId=one`;
    expect((await ctx.app.inject(url)).statusCode).toBe(401);
    for (let read = 0; read < 2; read++) {
      const response = await ctx.app.inject({ url, headers: { cookie: ctx.cookie } });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({ event: q, throughSeq: before.at(-1)!.seq, submittedAnswer: { commandId: 'actual-answer-one', ...answer } });
    }
    const other = await ctx.app.inject({ url: `/api/sessions/${sessionId}/interactions/answer?interactionId=two`, headers: { cookie: ctx.cookie } });
    expect(other.json()).not.toHaveProperty('submittedAnswer');
    expect(ctx.store.allEvents(sessionId)).toEqual(before);
    expect(ctx.manager.getRuntime(sessionId)).toBeDefined(); // existing fake native session only; reads do not send
  } finally { await ctx.close(); }
});

it('never exposes sensitive answers or mismatched command identities in a question preview', async () => {
  const ctx = await createTestApp();
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    ctx.store.appendEvent({ sessionId, turnId: 'turn', kind: 'question', itemKey: 'secret', data: { questionId: 'secret', prompt: '敏感值', isSecret: true } });
    ctx.store.journal.claim({ op: 'answer', clientCommandId: 'sensitive', sessionId, questionId: 'secret', answer: { selected: [], custom: 'must-not-appear' } });
    const row = ctx.store.interactions.claim(sessionId, 'answer', 'secret', 'sensitive'); ctx.store.interactions.finish(row, true);
    const secret = await ctx.app.inject({ url: `/api/sessions/${sessionId}/interactions/answer?interactionId=secret`, headers: { cookie: ctx.cookie } });
    expect(secret.body).not.toContain('must-not-appear'); expect(secret.json()).not.toHaveProperty('submittedAnswer');
    ctx.store.appendEvent({ sessionId, turnId: 'turn', kind: 'question', itemKey: 'different', data: { questionId: 'different', prompt: '另一个问题' } });
    ctx.store.interactions.claim(sessionId, 'answer', 'different', 'sensitive');
    const mismatch = await ctx.app.inject({ url: `/api/sessions/${sessionId}/interactions/answer?interactionId=different`, headers: { cookie: ctx.cookie } });
    expect(mismatch.json()).not.toHaveProperty('submittedAnswer');
  } finally { await ctx.close(); }
});
