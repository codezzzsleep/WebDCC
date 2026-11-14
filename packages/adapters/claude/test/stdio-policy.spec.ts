import { expect, it } from 'vitest';
import { openDb } from '../../../server/src/db.js';
import { Store } from '../../../server/src/store.js';
import { ClaudeStdioLines, type ClaudeStdioEnvelope } from '../src/stdio-capture.js';

it('raw control frames use the real NativeFrameSink secret policy and never duplicate their original text into metadata', () => {
  const db = openDb(':memory:'); const store = new Store(db);
  const workspace = store.createWorkspace('raw-policy', '/tmp');
  const session = store.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
  const context = { sessionId: session.id, agent: 'claude-code', nativeId: 'native' };
  const ids: number[] = [];
  let seq = 0;
  const write = (envelope: ClaudeStdioEnvelope): void => { ids.push(store.nativeEvents.frame(context, { i: ++seq, t: 0, dir: envelope.stdio.stream === 'stdin' ? 'out' : 'in', ch: `claude-stdio:${envelope.stdio.stream}`, frame: envelope }, true)); };
  const secret = 'one-time-low-entropy-answer';
  try {
    const incoming = new ClaudeStdioLines('stdout', write);
    incoming.feed(Buffer.from(JSON.stringify({ type: 'control_request', request_id: 'native-request', request: { subtype: 'elicitation', requestedSchema: { type: 'object', properties: { answer: { type: 'string', writeOnly: true } } } } }) + '\n'));
    const outgoing = new ClaudeStdioLines('stdin', write);
    outgoing.feed(Buffer.from(JSON.stringify({ type: 'control_response', response: { request_id: 'native-request', subtype: 'success', response: { action: 'accept', content: { answer: secret } } } }) + '\n'));
    const stderr = new ClaudeStdioLines('stderr', write);
    for (const part of ['one-time-', 'low-entropy-', 'answer\n']) stderr.feed(Buffer.from(part));
    const bad = new ClaudeStdioLines('stdout', write);
    bad.feed(Buffer.from(secret + '\n'));
    const rows = ids.map(id => store.nativeEvents.get(id)!);
    expect(rows[0]?.nativeRequestId).toBe('native-request');
    expect(rows[1]?.nativeRequestId).toBe('native-request');
    expect(rows.every(row => row.payloadCoverage === 'restricted')).toBe(true);
    expect(rows[0]?.payload).toMatchObject({ stdio: { stream: 'stdout', coverage: 'complete', terminated: true } });
    expect(rows[2]?.payload).toMatchObject({ stdio: { stream: 'stderr', coverage: 'unstructured', byteLength: Buffer.byteLength(secret + '\n') } });
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toMatch(/one-time-|low-entropy-/);
    expect(store.nativeEvents.restricted(session.id)).toBe(true);
  } finally { db.close(); }
});
