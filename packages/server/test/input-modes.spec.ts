import { expect, it } from 'vitest';
import type { CodexInputModeCatalog, EventData, UserInput } from '@webdcc/protocol';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

it('mode discovery requires authentication and the correct Agent without activating a native Session', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('mode discovery', ctx.dataDir);
    const sessionId = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' }).id;
    const adapter = ctx.manager.adapter('codex')!;
    const catalog: CodexInputModeCatalog = { modes: [{ id: 'plan', label: '计划' }, { id: 'default', label: '默认' }], observedMode: null };
    adapter.inputModes = async () => catalog;
    adapter.create = async () => { throw new Error('read must not activate'); };
    adapter.resume = async () => { throw new Error('read must not resume'); };
    expect((await ctx.app.inject({ method: 'GET', url: '/api/agents/codex/input-modes?sessionId=' + sessionId })).statusCode).toBe(401);
    const response = await ctx.app.inject({ method: 'GET', url: '/api/agents/codex/input-modes?sessionId=' + sessionId, headers: { cookie: ctx.cookie } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual(catalog);
    expect(ctx.manager.getRuntime(sessionId)).toBeUndefined();
    const other = await seedWorkspaceAndSession(ctx, 'dsh');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/agents/codex/input-modes?sessionId=' + other.sessionId, headers: { cookie: ctx.cookie } })).statusCode).toBe(400);
  } finally { await ctx.close(); }
});

it('HTTP input preserves mode and original text through the durable queue and later dispatch', async () => {
  const ctx = await createTestApp({ delayMs: 20 });
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    const adapter = ctx.manager.adapter('codex')!; const send = adapter.send.bind(adapter);
    const received: UserInput[] = [];
    adapter.send = async (id, input) => { received.push(structuredClone(input)); await send(id, input); };
    await ctx.manager.send(sessionId, { text: 'first' }, 'MODE-FIRST');
    const text = '  计划正文\r\n  ';
    const contentParts = { version: 1 as const, collaborationMode: 'plan' as const, parts: [{ type: 'text' as const, text }] };
    const response = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: {
      command: { op: 'send', clientCommandId: 'MODE-QUEUED', sessionId, text, contentParts, intent: 'queue' },
    } });
    expect(response.json()).toMatchObject({ ok: true, value: { queued: true } });
    expect(ctx.store.journal.queue(sessionId).find(row => row.commandId === 'MODE-QUEUED')?.input.contentParts).toEqual(contentParts);
    await expect.poll(() => received.length).toBe(2);
    expect(received[1]).toMatchObject({ text, contentParts });
    expect((ctx.store.allEvents(sessionId).find(event => event.kind === 'user.message' && (event.data as EventData['user.message']).text === text)!.data as EventData['user.message']).contentParts).toEqual(contentParts);
  } finally { await ctx.close(); }
});

it('a Codex mode cannot reach a different Harness', async () => {
  const ctx = await createTestApp();
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'claude-code');
    await expect(ctx.manager.send(sessionId, { text: 'original', contentParts: { version: 1, parts: [{ type: 'text', text: 'original' }], collaborationMode: 'plan' } })).rejects.toMatchObject({ statusCode: 400 });
    expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'user.message')).toHaveLength(0);
  } finally { await ctx.close(); }
});
