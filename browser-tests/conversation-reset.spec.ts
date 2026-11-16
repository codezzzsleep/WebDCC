import { chromium, type Browser } from '@playwright/test';
import type { AdapterEvent } from '@webdcc/protocol';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';
import { openDb } from '../packages/server/src/db.js';
import { Store } from '../packages/server/src/store.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';
import { createSourceTestApp } from './helpers.js';

it('a native reset changes the current title/transcript, retains a read-only prior view and survives refresh without hiding continued output', async () => {
  const ctx = await createSourceTestApp();
  let browser: Browser | undefined;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'claude-code');
    ctx.store.updateSession(sessionId, { title: 'Previous native conversation' });
    ctx.store.appendEvent({ sessionId, turnId: 'before-reset', itemKey: 'old-user', kind: 'user.message', data: { text: 'Previous exact user text' } });
    ctx.store.appendEvent({ sessionId, turnId: 'before-reset', itemKey: 'old-answer', kind: 'assistant.message', data: { text: 'Previous exact assistant answer', nativePhase: 'final_result' } });
    ctx.store.appendEvent({ sessionId, turnId: 'before-reset', itemKey: 'old-end', kind: 'turn.completed', data: { status: 'completed', durationMs: 1, answerItemKeys: ['old-answer'] } });
    const before = ctx.store.allEvents(sessionId);
    const emitter = ctx.manager.adapter('claude-code') as unknown as { emit(id: string, event: AdapterEvent): void };
    const replay = ClaudeAdapter.replay(sessionId);
    let frameIndex = 0;
    const emitReset = (id: string, uuid: string, trigger: string) => {
      for (const event of replay.feed({ i: ++frameIndex, t: 0, dir: 'in', ch: 'sdk', frame: {
        type: 'conversation_reset', new_conversation_id: id, uuid, session_id: ctx.store.getSession(sessionId)?.nativeId,
        trigger, user_message_uuid: '44444444-4444-4444-8444-444444444444' } })) emitter.emit(sessionId, event);
    };
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('missing test listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`);
    const timeline = page.getByTestId('timeline');
    await expect.poll(() => timeline.textContent()).toContain('Previous exact assistant answer');
    const id = '22222222-2222-4222-8222-222222222222';
    const uuid = '33333333-3333-4333-8333-333333333333';
    emitReset(id, uuid, 'clear');
    await expect.poll(() => page.getByTestId('session-title').textContent()).toBe('新会话');
    await expect.poll(() => timeline.textContent()).not.toContain('Previous exact assistant answer');
    expect(page.url()).toBe(`${base}/s/${sessionId}`);
    await page.getByRole('button', { name: '查看此前对话' }).click();
    await expect.poll(() => timeline.textContent()).toContain('Previous exact assistant answer');
    await expect.poll(() => page.getByTestId('composer-input').isDisabled()).toBe(true);
    await page.getByRole('button', { name: '返回当前对话' }).click();
    await expect.poll(() => timeline.textContent()).not.toContain('Previous exact assistant answer');
    await page.reload();
    await page.getByTestId('conversation-boundary').waitFor();
    expect(await page.getByTestId('session-title').textContent()).toBe('新会话');
    expect(await timeline.textContent()).not.toContain('Previous exact assistant answer');
    const next = '55555555-5555-4555-8555-555555555555';
    emitter.emit(sessionId, { type: 'turn.start', nativeTurnId: 'ongoing-plan-turn' });
    emitReset(next, '66666666-6666-4666-8666-666666666666', 'plan_mode_exit');
    emitter.emit(sessionId, { type: 'native-id', nativeId: next });
    emitter.emit(sessionId, { type: 'item.complete', itemKey: 'continued-answer', kind: 'assistant.message',
      data: { text: 'Continued output in the new native context', nativePhase: 'final_result' }, nativeTurnId: 'ongoing-plan-turn', native: { session_id: next } });
    emitter.emit(sessionId, { type: 'turn.end', nativeTurnId: 'ongoing-plan-turn', status: 'completed', native: { session_id: next } });
    await expect.poll(() => timeline.textContent()).toContain('Continued output in the new native context');
    emitReset(id, uuid, 'clear'); // An old duplicate must not wipe the newer view.
    await page.reload();
    await expect.poll(() => timeline.textContent()).toContain('Continued output in the new native context');
    expect(ctx.store.getSession(sessionId)?.conversation?.id).toBe(next);
    expect(ctx.store.allEvents(sessionId)).toEqual(expect.arrayContaining(before));
  } finally { await browser?.close(); await ctx.close(); }
}, 60000);

it('opening a legacy database restores its raw reset boundary and keeps prior history separate after browser refresh', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'wdcc-legacy-reset-browser-'));
  const dbPath = join(scratch, 'state.db');
  const db = openDb(dbPath);
  let browser: Browser | undefined;
  let ctx: Awaited<ReturnType<typeof createSourceTestApp>> | undefined;
  try {
    const old = new Store(db);
    const path = join(scratch, 'workspace');
    await mkdir(path);
    const workspace = old.createWorkspace('Legacy workspace', path);
    const session = old.createSession({ workspaceId: workspace.id, agent: 'claude-code', title: 'Stale legacy title' });
    old.appendEvent({ sessionId: session.id, turnId: 'prior', itemKey: 'old-answer', kind: 'assistant.message', data: { text: 'Original legacy answer', nativePhase: 'final_result' } });
    old.appendEvent({ sessionId: session.id, turnId: 'prior', itemKey: 'old-complete', kind: 'turn.completed', data: { status: 'completed', durationMs: 1, answerItemKeys: ['old-answer'] } });
    old.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'legacy-reset', kind: 'unknown', data: { nativeType: 'conversation_reset' },
      native: { type: 'conversation_reset', new_conversation_id: '22222222-2222-4222-8222-222222222222', uuid: '33333333-3333-4333-8333-333333333333' } });
    const original = old.allEvents(session.id);
    db.prepare('DELETE FROM app_settings WHERE key = ?').run('conversation-index-v1');
    db.close();
    ctx = await createSourceTestApp({ dbPath });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('missing test listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    await page.getByTestId('conversation-boundary').waitFor();
    expect(await page.getByTestId('session-title').textContent()).toBe('新会话');
    expect(await page.getByTestId('timeline').textContent()).not.toContain('Original legacy answer');
    await page.getByRole('button', { name: '查看此前对话' }).click();
    await expect.poll(() => page.getByTestId('timeline').textContent()).toContain('Original legacy answer');
    expect(await page.getByTestId('composer-input').isDisabled()).toBe(true);
    await page.reload();
    await page.getByTestId('conversation-boundary').waitFor();
    expect(await page.getByTestId('timeline').textContent()).not.toContain('Original legacy answer');
    expect(ctx.store.allEvents(session.id)).toEqual(original);
  } finally {
    await browser?.close();
    await ctx?.close();
    if (db.open) db.close();
    await rm(scratch, { recursive: true, force: true });
  }
}, 60000);
