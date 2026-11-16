import type { AdapterEvent, EventData, SessionDto } from '@webdcc/protocol';
import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../adapters/claude/src/adapter.js';
import { Store } from '../src/store.js';
import { openDb } from '../src/db.js';
import { createTestApp, seedWorkspaceAndSession, TEST_TOKEN } from './helpers.js';

const oldId = '11111111-1111-4111-8111-111111111111';
const nextId = '22222222-2222-4222-8222-222222222222';
const resetUuid = '33333333-3333-4333-8333-333333333333';

it('persists a native-declared context boundary, clears title and hot state, and keeps prior history under the same Web id', async () => {
  const ctx = await createTestApp();
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'claude-code');
    ctx.store.updateSession(sessionId, { title: 'Prior conversation' });
    ctx.store.appendEvent({ sessionId, turnId: 'old-turn', itemKey: 'old-user', kind: 'user.message', data: { text: 'original user text' } });
    const original = ctx.store.appendEvent({ sessionId, turnId: 'old-turn', itemKey: 'old-answer', kind: 'assistant.message', data: { text: 'original answer' } });
    const emitter = ctx.manager.adapter('claude-code') as unknown as { emit(id: string, event: AdapterEvent): void };
    emitter.emit(sessionId, { type: 'native-id', nativeId: oldId });
    const replay = ClaudeAdapter.replay(sessionId);
    const reset = { type: 'conversation_reset', new_conversation_id: nextId, uuid: resetUuid, session_id: oldId, trigger: 'clear',
      user_message_uuid: '44444444-4444-4444-8444-444444444444', timestamp: '2000-01-01T00:00:00.000Z' };
    const emitReset = () => { for (const event of replay.feed({ i: 2, t: 5, dir: 'in', ch: 'sdk', frame: reset })) emitter.emit(sessionId, event); };
    emitReset();
    const response = await ctx.app.inject({ url: `/api/sessions/${sessionId}`, headers: { cookie: ctx.cookie } });
    expect(response.statusCode).toBe(200);
    const session = response.json<SessionDto>();
    expect(session.id).toBe(sessionId);
    expect(session.title).toBeUndefined();
    expect(session.conversation).toMatchObject({ id: nextId, uuid: resetUuid, previousTitle: 'Prior conversation', previousNativeId: oldId,
      userMessageUuid: reset.user_message_uuid, timestamp: reset.timestamp });
    expect(ctx.store.allEvents(sessionId)).toContainEqual(original);
    expect(ctx.store.listSessions()).toHaveLength(1);
    expect(ctx.store.conversation(sessionId)).toEqual(session.conversation);
    const count = ctx.store.allEvents(sessionId).length;
    ctx.store.updateSession(sessionId, { title: 'New conversation title' });
    emitReset();
    expect(ctx.store.allEvents(sessionId)).toHaveLength(count);
    expect(ctx.store.getSession(sessionId)?.title).toBe('New conversation title');
  } finally { await ctx.close(); }
});

it('keeps the context and old transcript across a file-backed database reopen', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'wdcc-conversation-reopen-'));
  const path = join(scratch, 'state.db');
  const ctx = await createTestApp({}, TEST_TOKEN, {}, { dbPath: path });
  let closed = false;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'claude-code');
    ctx.store.updateSession(sessionId, { title: 'Old persisted title' });
    const prior = ctx.store.appendEvent({ sessionId, turnId: 'prior', kind: 'user.message', itemKey: 'prior', data: { text: 'keep this exact history\r\n' } });
    const emitter = ctx.manager.adapter('claude-code') as unknown as { emit(id: string, event: AdapterEvent): void };
    for (const event of ClaudeAdapter.replay(sessionId).feed({ i: 1, t: 0, dir: 'in', ch: 'sdk', frame: {
      type: 'conversation_reset', new_conversation_id: nextId, uuid: resetUuid, session_id: oldId, trigger: 'onboarding' } })) emitter.emit(sessionId, event);
    const context = ctx.store.getSession(sessionId)?.conversation;
    await ctx.close(); closed = true;
    const db = openDb(path);
    try {
      const reopened = new Store(db);
      expect(reopened.getSession(sessionId)?.conversation).toEqual(context);
      expect(reopened.getSession(sessionId)?.title).toBeUndefined();
      expect(reopened.allEvents(sessionId)).toContainEqual(prior);
    } finally { db.close(); }
  } finally { if (!closed) await ctx.close(); await rm(scratch, { recursive: true, force: true }); }
});

it('rolls back the boundary and title atomically if persisting the context fails, without claiming a native reset did not occur', async () => {
  const ctx = await createTestApp();
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'claude-code');
    ctx.store.updateSession(sessionId, { title: 'Must be retained on local failure' });
    const original = ctx.store.allEvents(sessionId);
    const save = vi.spyOn(ctx.store, 'saveConversation').mockImplementation(() => { throw new Error('controlled projection write failure'); });
    const emitter = ctx.manager.adapter('claude-code') as unknown as { emit(id: string, event: AdapterEvent): void };
    for (const event of ClaudeAdapter.replay(sessionId).feed({ i: 1, t: 0, dir: 'in', ch: 'sdk', frame: {
      type: 'conversation_reset', new_conversation_id: nextId, uuid: resetUuid, session_id: oldId } })) emitter.emit(sessionId, event);
    save.mockRestore();
    expect(ctx.store.getSession(sessionId)?.title).toBe('Must be retained on local failure');
    expect(ctx.store.conversation(sessionId)).toBeUndefined();
    expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'notice' && (event.data as EventData['notice']).contextReset !== undefined)).toEqual([]);
    expect(ctx.store.allEvents(sessionId)).toEqual(expect.arrayContaining(original));
    expect(ctx.store.getSession(sessionId)?.status).toBe('error');
    const raw = ctx.store.nativeEvents.list(sessionId, 0, 100).map(row => ctx.store.nativeEvents.get(row.id)?.payload);
    expect(JSON.stringify(raw)).toContain(resetUuid);
  } finally { await ctx.close(); }
});
