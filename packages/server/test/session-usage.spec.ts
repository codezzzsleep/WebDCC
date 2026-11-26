import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';
import { reduceTurn } from '@webdcc/protocol';

it('reconciles historical Codex per-response usage, including untimed and repeated cumulative updates', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('Usage', ctx.dataDir);
    const { id } = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    // Reduced from a real 12-response recording with both historical scope labels.
    const responses = [13602, 15296, 22436, 25504, 29520, 32301, 32749, 36234, 41885, 42512, 46840, 46893];
    let cumulative = 0;
    const append = (turnId: string, key: number, totalTokens: number, timed: boolean, replay = false) => {
      const last = { inputTokens: totalTokens - 100, outputTokens: 100, cachedInputTokens: 5000, reasoningOutputTokens: 80, totalTokens };
      if (!replay) cumulative += totalTokens;
      ctx.store.appendEvent({ sessionId: id, turnId, itemKey: `usage-${key}`, kind: 'usage',
        data: { inputTokens: last.inputTokens, outputTokens: last.outputTokens, scope: timed ? 'attempt' : 'turn', ...(timed ? { generationMs: 1000 } : {}) },
        native: { threadId: 'native-thread', tokenUsage: { last, total: { totalTokens: cumulative } } } });
    };
    responses.forEach((tokens, index) => append(index < 6 ? 'one' : 'two', index, tokens, index % 3 === 0));
    append('three', 12, responses[11]!, false, true);
    // A repeated snapshot arriving under a later turn does not consume the
    // previous response again.
    append('three', 13, 16800, false);
    expect(ctx.store.sessionUsage(id)).toEqual({ throughSeq: 14, resetSeq: 0, totalTokens: 402572, partial: false });
    const first = ctx.store.allEvents(id).filter(event => event.turnId === 'one');
    expect(reduceTurn(first).usage).toMatchObject({ inputTokens: 138059, outputTokens: 600 });
    expect(reduceTurn(first).usage?.tokensPerSecond).toBeUndefined();
    ctx.store.appendEvent({ sessionId: id, turnId: 'four', itemKey: 'total-only', kind: 'usage',
      data: { inputTokens: 400000, outputTokens: 3472, scope: 'turn' },
      native: { threadId: 'native-thread', tokenUsage: { total: { totalTokens: 403472 } } } });
    expect(ctx.store.sessionUsage(id)).toMatchObject({ totalTokens: 402572, partial: true });
  } finally { await ctx.close(); }
});

it('reads old Claude result cache buckets and DSH native totals, and preserves unknown amounts', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('Usage', ctx.dataDir);
    const claude = ctx.store.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    const dsh = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    const result = ctx.store.appendEvent({ sessionId: claude.id, turnId: 'one', itemKey: 'result', kind: 'turn.completed',
      data: { status: 'completed', usage: { inputTokens: 34, outputTokens: 49772 } },
      native: { type: 'result', usage: { input_tokens: 34, output_tokens: 49772, cache_read_input_tokens: 1277137, cache_creation_input_tokens: 634567 } } });
    const url = `/api/sessions/${claude.id}/usage`;
    expect((await ctx.app.inject({ url })).statusCode).toBe(401);
    const response = await ctx.app.inject({ url, headers: { cookie: ctx.cookie } });
    expect(response.json()).toEqual({ throughSeq: result.seq, resetSeq: 0, totalTokens: 1961510, partial: false });
    expect(reduceTurn([result]).usage).toMatchObject({ cacheReadInputTokens: 1277137, cacheCreationInputTokens: 634567 });

    const report = { usage: { inputTokens: 184, outputTokens: 5, totalTokens: 6333, cacheReadTokens: 6144, reasoningTokens: 4 }, type: 'usage' };
    for (const itemKey of ['attempt-one', 'attempt-two']) ctx.store.appendEvent({ sessionId: dsh.id, turnId: 'one', itemKey, kind: 'usage',
      data: { inputTokens: 184, outputTokens: 5, scope: 'attempt' }, native: report });
    ctx.store.appendEvent({ sessionId: dsh.id, turnId: 'one', itemKey: 'done', kind: 'turn.completed',
      data: { status: 'completed', usage: { inputTokens: 368, outputTokens: 10 } } });
    expect(ctx.store.sessionUsage(dsh.id)).toMatchObject({ totalTokens: 12666, partial: false });
    ctx.store.appendEvent({ sessionId: dsh.id, turnId: 'two', itemKey: 'partial', kind: 'usage',
      data: { inputTokens: 0, outputTokens: 12, scope: 'attempt' } });
    expect(ctx.store.sessionUsage(dsh.id)).toMatchObject({ totalTokens: 12678, partial: true });
  } finally { await ctx.close(); }
});

it('excludes earlier conversations and late Claude results after a reset', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('Usage', ctx.dataDir);
    const { id } = ctx.store.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    ctx.store.updateSession(id, { nativeId: 'old' });
    const result = (nativeId: string, turnId: string, outputTokens: number) => ctx.store.appendEvent({
      sessionId: id, turnId, itemKey: 'result', kind: 'turn.completed',
      data: { status: 'completed', usage: { inputTokens: 0, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      native: { session_id: nativeId },
    });
    const old = result('old', 'one', 200);
    ctx.store.saveConversation(id, { id: 'new', uuid: 'reset', previousNativeId: 'old', resetSeq: old.seq });
    ctx.store.updateSession(id, { nativeId: 'new' });
    result('old', 'late-old-turn', 5);
    const zero = result('new', 'new-turn', 0);
    expect(ctx.store.sessionUsage(id)).toEqual({ throughSeq: zero.seq, resetSeq: old.seq, totalTokens: 0, partial: false });
  } finally { await ctx.close(); }
});
