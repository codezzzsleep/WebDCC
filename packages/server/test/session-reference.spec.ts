import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { SessionReferenceIdentity, SessionReferenceResponse } from '@webdcc/protocol';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

it.each(['codex', 'claude-code', 'dsh'])('%s reference preserves original identity and early/late saved records without sending or changing history', async agent => {
  const ctx = await createTestApp();
  try {
    const { sessionId, workspaceId } = await seedWorkspaceAndSession(ctx, agent);
    const nativeId = agent === 'codex' ? '019ba535-dac6-7de5-a658-d837bedda232' : `native-${agent}-identity`;
    ctx.store.updateSession(sessionId, { nativeId, title: '旧会话中文标题\n原记录' });
    ctx.store.nativeEvents.addSecret('private-reference-secret');
    const append = (index: number, text: string) => ctx.store.appendEvent({ sessionId, turnId: 'first-turn', kind: 'assistant.message', itemKey: `message-${index}`, data: { text } });
    ctx.store.appendEvent({ sessionId, turnId: 'first-turn', kind: 'user.message', itemKey: 'early-question', data: { text: 'EARLY-QUESTION-保留中文\r\n原始换行' } });
    for (let index = 0; index < 140; index++) append(index, `original-${index}`);
    ctx.store.appendEvent({ sessionId, turnId: 'first-turn', kind: 'command', itemKey: 'command-failure', data: { command: 'read original', outputTail: 'TOOL-RESULT-EXACT\nprivate-reference-secret', status: 'failed', exitCode: 1 } });
    ctx.store.appendEvent({ sessionId, turnId: 'first-turn', kind: 'turn.completed', itemKey: 'first-end', data: { status: 'failed', durationMs: 10 } });
    ctx.store.appendEvent({ sessionId, turnId: 'second-turn', kind: 'assistant.message', itemKey: 'late-answer', data: { text: 'LATEST-ANSWER-记录', incomplete: true } });
    const before = ctx.store.allEvents(sessionId);
    const endpoint = `/api/sessions/${sessionId}/reference`;
    expect((await ctx.app.inject(endpoint)).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: endpoint, payload: {} })).statusCode).toBe(401);
    const metadata = await ctx.app.inject({ url: endpoint, headers: { cookie: ctx.cookie } });
    expect(metadata.statusCode).toBe(200); expect(metadata.headers['cache-control']).toBe('no-store');
    expect((metadata.json() as SessionReferenceIdentity).nativeId).toBe(nativeId);
    expect(await lstat(join(ctx.store.getWorkspace(workspaceId)!.path, '.webdcc')).then(() => true, () => false)).toBe(false);
    const response = await ctx.app.inject({ method: 'POST', url: endpoint, headers: { cookie: ctx.cookie }, payload: {} });
    expect(response.statusCode, response.body).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    const reference = response.json() as SessionReferenceResponse;
    expect(reference).toMatchObject({ sessionId, nativeId, agent, throughSeq: before.at(-1)!.seq, eventCount: before.length });
    const bytes = await readFile(reference.absolutePath); const text = bytes.toString('utf8');
    expect(reference.absolutePath).toBe(join(ctx.store.getWorkspace(workspaceId)!.path, reference.path));
    expect(reference.sha256).toBe(createHash('sha256').update(bytes).digest('hex')); expect(reference.bytes).toBe(bytes.length);
    expect(text).toContain('EARLY-QUESTION-保留中文\r\n原始换行'); expect(text).toContain('LATEST-ANSWER-记录');
    expect(text.indexOf('EARLY-QUESTION')).toBeLessThan(text.indexOf('LATEST-ANSWER'));
    expect(text).toContain('TOOL-RESULT-EXACT'); expect(text).toContain('"status": "failed"');
    expect(text).toContain('"incomplete": true'); expect(text).not.toContain('private-reference-secret');
    expect(ctx.store.allEvents(sessionId)).toEqual(before);
    const same = (await ctx.app.inject({ method: 'POST', url: endpoint, headers: { cookie: ctx.cookie }, payload: {} })).json() as SessionReferenceResponse;
    expect(same.path).toBe(reference.path);
    append(141, 'NEW-RECORD-AFTER-COPY');
    expect((await readFile(reference.absolutePath, 'utf8'))).not.toContain('NEW-RECORD-AFTER-COPY');
    const next = (await ctx.app.inject({ method: 'POST', url: endpoint, headers: { cookie: ctx.cookie }, payload: {} })).json() as SessionReferenceResponse;
    expect(next.throughSeq).toBe(reference.throughSeq + 1); expect(next.path).not.toBe(reference.path);
    expect(await readFile(next.absolutePath, 'utf8')).toContain('NEW-RECORD-AFTER-COPY');
  } finally { await ctx.close(); }
});

it('reference copying rejects missing sources and workspace directory links without writing outside', async () => {
  const ctx = await createTestApp(); const outside = await mkdtemp(join(tmpdir(), 'wdcc-reference-outside-'));
  try {
    for (const method of ['GET', 'POST'] as const) expect((await ctx.app.inject({ method, url: '/api/sessions/missing/reference', headers: { cookie: ctx.cookie }, ...(method === 'POST' ? { payload: {} } : {}) })).statusCode).toBe(404);
    const { sessionId, workspaceId } = await seedWorkspaceAndSession(ctx, 'codex');
    const root = ctx.store.getWorkspace(workspaceId)!.path;
    await symlink(outside, join(root, '.webdcc'));
    const response = await ctx.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/reference`, headers: { cookie: ctx.cookie }, payload: {} });
    expect(response.statusCode).toBe(409); expect(await readdir(outside)).toEqual([]);
  } finally { await ctx.close(); await rm(outside, { recursive: true, force: true }); }
});
