import { expect, it } from 'vitest';
import { claudeResultOutput } from '@webdcc/protocol';
import { createTestApp } from './helpers.js';

it('redacts structured contents and errors while preserving output identities and native lifecycle', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('structured output', ctx.dataDir);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    ctx.store.nativeEvents.addSecret('completed');
    const data = claudeResultOutput({ type: 'result', uuid: 'native-result', session_id: 'native-session', subtype: 'success', is_error: false,
      structured_output: { text: 'completed', scalar: false }, errors: ['completed'] }, 'query')!;
    const stored = ctx.store.appendEvent({ sessionId: session.id, turnId: null, itemKey: 'output', kind: 'structured.output', data });
    expect(stored.data).toMatchObject({ status: 'completed', nativeResultId: 'native-result', queryId: 'query', value: { scalar: false } });
    expect(JSON.stringify((stored.data as typeof data).value)).not.toContain('completed');
    expect((stored.data as typeof data).errors?.[0]).not.toContain('completed');
    expect(ctx.store.allEvents(session.id)[0]?.data).toEqual(stored.data);
  } finally { await ctx.close(); }
});
