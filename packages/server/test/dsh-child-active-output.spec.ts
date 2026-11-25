import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';
import { createChildActiveOutputFixture } from '../../adapters/dsh/test/child-active-output-fixture.js';
import { childRecord } from '../../adapters/dsh/test/subagent-fixture.js';
import type { DshOpening } from '../../adapters/dsh/src/history.js';

it('reads the controlled native child opening with its current attempt and releases the passive subscription', async () => {
  const fixture = await createChildActiveOutputFixture();
  try {
    const opening = await fixture.client.snapshot<DshOpening>('session/follow', { request: {
      address: { kind: 'subagent', parentSessionId: fixture.parentId, childSessionId: 'reviewer', mode: 'continuable' },
      activate: false, assistantStream: true, maxMessages: 100,
    } });
    expect(opening.header.id).toBe('reviewer');
    expect(opening.assistantStream).toEqual(fixture.assistants.get('reviewer'));
    await expect.poll(() => fixture.canceled).toEqual([fixture.opens[0]!.streamId]);
  } finally { await fixture.close(); }
});

it('keeps fixed history windows separate and removes the transient attempt after native settlement', async () => {
  const fixture = await createChildActiveOutputFixture();
  try {
    await expect(fixture.adapter.readSubagentHistory('parent', 'reviewer', { limit: 100, includeActive: true, throughSeq: 7 })).rejects.toMatchObject({ statusCode: 400 });
    const current = await fixture.adapter.readSubagentHistory('parent', 'reviewer', { limit: 100, includeActive: true });
    expect(current.activeOutput?.attemptId).toBe('same-native-attempt-id');
    fixture.states.get('reviewer')!.running = false;
    fixture.states.get('reviewer')!.cursor = 9;
    fixture.records.get('reviewer')!.push(childRecord(8, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'native final' }] } }),
      childRecord(9, 'turn/end', { turn: 2, reason: { kind: 'completed' } }));
    const settled = await fixture.adapter.readSubagentHistory('parent', 'reviewer', { limit: 100, includeActive: true });
    expect(settled.activeOutput).toBeUndefined();
    expect(settled.records.filter(record => record.event.seq === 8)).toHaveLength(1);
    expect(fixture.opens).toHaveLength(1);
  } finally { await fixture.close(); }
});

it('does not return an attempt that starts beyond its native history cut', async () => {
  const fixture = await createChildActiveOutputFixture();
  try {
    fixture.assistants.get('reviewer')!.activeAttempt!.startedAfterSeq = 8;
    await expect(fixture.adapter.readSubagentHistory('parent', 'reviewer', { limit: 100, includeActive: true })).rejects.toMatchObject({ statusCode: 409 });
    await expect.poll(() => fixture.canceled.length).toBe(1);
  } finally { await fixture.close(); }
});

it('exposes a child current attempt through the source history route without creating a parent runtime or user prompt', async () => {
  const ctx = await createTestApp(); const fixture = await createChildActiveOutputFixture(); fixture.cold();
  try {
    ctx.manager.registerAdapter(fixture.adapter);
    const workspace = ctx.store.createWorkspace('Child active output', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    ctx.store.updateSession(session.id, { nativeId: fixture.parentId });
    const reply = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/subagents/reviewer/history?includeActive=true`, headers: { cookie: ctx.cookie } });
    expect(reply.statusCode).toBe(200);
    const body = reply.json();
    expect(body.activeOutput).toMatchObject({ attemptId: 'same-native-attempt-id', revision: 2, startedAfterSeq: 7,
      turn: 2, step: 1, nextIndex: 2, details: '部分回答：\nreviewer partial🐈\r\n ' });
    expect(body.activeOutput.stream).toEqual(fixture.assistants.get('reviewer')!.activeAttempt!.stream);
    expect(body.records).toEqual(fixture.records.get('reviewer'));
    expect((ctx.manager as unknown as { runtimes: Map<string, unknown> }).runtimes.has(session.id)).toBe(false);
    expect(fixture.calls.some(call => call.method === 'session/prompt' || call.method.startsWith('subagents/'))).toBe(false);
  } finally { await ctx.close(); await fixture.close(); }
});
