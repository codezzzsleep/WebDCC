import { expect, it } from 'vitest';
import { DshAdapter } from '../src/adapter.js';
import { waitUntil } from '../src/host.js';
import { createDshSubagentFixture, childRecord } from './subagent-fixture.js';

it('a durable DSH child catalog identifies a child without claiming it is running', () => {
  const native = DshAdapter.replay('parent', 'native-parent');
  const events = native.feed({ i: 1, t: 0, dir: 'in', ch: 'mux:session/follow', frame: { type: 'item', value: {
    type: 'event', event: { type: 'subagent/catalog', seq: 1, time: 1000, data: {
      version: 3, childId: 'native-child', childCreatedAt: 1000,
      mode: 'continuable', name: 'reviewer', label: 'Review the work',
    } },
  } } });
  expect(events).toContainEqual(expect.objectContaining({ kind: 'tool.call', data: expect.objectContaining({
    name: 'subagent', status: 'unknown', input: expect.objectContaining({
      childId: 'native-child', parentSessionId: 'native-parent', mode: 'continuable',
    }),
  }) }));
});

it('reads each real-address child state and partial result without activating or writing any child', async () => {
  const fixture = await createDshSubagentFixture();
  try {
    const result = await fixture.adapter.listSubagents('parent');
    expect(result).toMatchObject({ nativeId: 'native-parent', asOfSeq: 10, items: [
      { childId: 'reviewer', parentSessionId: 'native-parent', mode: 'continuable', status: 'completed', result: { seq: 5, text: 'REVIEWER CHILD ONLY FINAL' }, lastTurn: { turn: 1, seq: 6, reason: { kind: 'completed' } } },
      { childId: 'failing', status: 'failed', result: { text: 'PARTIAL CHILD OUTPUT' }, lastTurn: { reason: { kind: 'max-tokens' } } },
      { childId: 'once', mode: 'one-shot', status: 'completed' },
      { childId: 'external', mode: 'external', status: 'unknown', error: expect.stringContaining('外部') },
    ] });
    expect(fixture.calls.filter(call => call.method === 'session/page')).toHaveLength(3);
    expect(fixture.calls.filter(call => call.method === 'session/page').every(call => (call.args['request'] as { address: unknown }).address !== undefined)).toBe(true);
    expect(fixture.calls.some(call => JSON.stringify(call.args).includes('external') && call.method !== 'session/projections')).toBe(false);
    expect(new Set(fixture.calls.map(call => call.method))).toEqual(new Set(['session/projections', 'session/state', 'session/page']));
    expect(JSON.stringify(fixture.calls)).not.toContain('activate');
  } finally { await fixture.close(); }
});

it('pending native input and queued/running state override an earlier completed turn', async () => {
  const fixture = await createDshSubagentFixture();
  try {
    const state = fixture.states.get('reviewer')!;
    Object.assign(state, { active: true, running: true, pendingInput: ['approval'] });
    expect((await fixture.adapter.listSubagents('parent')).items[0]?.status).toBe('waiting');
    state.pendingInput = [];
    expect((await fixture.adapter.listSubagents('parent')).items[0]?.status).toBe('running');
    state.running = false; state.queue = [{ id: 'queued-input', placement: 'queued', rpcId: 'native-input', content: [] }];
    expect((await fixture.adapter.listSubagents('parent')).items[0]).toMatchObject({ status: 'pending', state: { queue: [{ id: 'queued-input', rpcId: 'native-input' }] } });
    state.queue = []; state.cursor = 7; fixture.records.get('reviewer')!.push(childRecord(7, 'turn/start', { turn: 2 }));
    expect((await fixture.adapter.listSubagents('parent')).items[0]?.status).toBe('unknown');
  } finally { await fixture.close(); }
});

it('retains parent/child/native input/tool identities while paging at the same native cut', async () => {
  const fixture = await createDshSubagentFixture();
  try {
    fixture.setPageSize(3);
    const first = await fixture.adapter.readSubagentHistory('parent', 'reviewer', { limit: 100 });
    expect(first).toMatchObject({ address: { kind: 'subagent', parentSessionId: 'native-parent', childSessionId: 'reviewer', mode: 'continuable' }, cursor: 6, hasMore: true, nextCursor: 4 });
    fixture.records.get('reviewer')!.push(childRecord(7, 'turn/start', { turn: 2 }));
    fixture.states.get('reviewer')!.cursor = 7;
    const older = await fixture.adapter.readSubagentHistory('parent', 'reviewer', { limit: 100, throughSeq: first.cursor, beforeSeq: first.nextCursor });
    const oldest = await fixture.adapter.readSubagentHistory('parent', 'reviewer', { limit: 100, throughSeq: first.cursor, beforeSeq: older.nextCursor });
    const records = [...oldest.records, ...older.records, ...first.records];
    expect(records).toEqual(fixture.records.get('reviewer')!.slice(0, 7));
    expect(records[2]?.event.data).toMatchObject({ source: { kind: 'user', rpcId: 'reviewer-request' } });
    expect(records[3]?.event.data).toMatchObject({ callId: 'reviewer-tool' });
    expect(records[4]?.event.data).toMatchObject({ toolCallId: 'reviewer-tool' });
    expect(new Set(records.map(record => record.event.seq)).size).toBe(7);
    expect(older.cursor).toBe(6); expect(oldest.hasMore).toBe(false);
  } finally { await fixture.close(); }
});

it('rejects foreign-parent and external history reads before addressing those children', async () => {
  const fixture = await createDshSubagentFixture();
  try {
    for (const child of ['some-other-parents-child', 'external']) await expect(fixture.adapter.readSubagentHistory('parent', child, { limit: 100 })).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.calls.filter(call => call.method !== 'session/projections')).toEqual([]);
    expect((await fixture.adapter.readSubagentHistory('parent', 'once', { limit: 100 })).address.mode).toBe('one-shot');
    await expect(fixture.adapter.readSubagentHistory('parent', 'reviewer', { limit: 201 })).rejects.toMatchObject({ statusCode: 400 });
  } finally { await fixture.close(); }
});

it('a missing or gapped native child result remains unknown and is not reported as completed', async () => {
  const fixture = await createDshSubagentFixture();
  try {
    fixture.setPageSize(200);
    fixture.records.get('reviewer')!.splice(4, 1);
    const result = await fixture.adapter.listSubagents('parent');
    expect(result.items[0]).toMatchObject({ childId: 'reviewer', status: 'unknown', error: expect.stringContaining('缺口') });
    expect(result.items[0]?.result).toBeUndefined();
    await expect(fixture.adapter.readSubagentHistory('parent', 'reviewer', { limit: 100 })).rejects.toMatchObject({ statusCode: 409 });
    fixture.states.delete('failing');
    expect((await fixture.adapter.listSubagents('parent')).items[1]?.status).toBe('unknown');
  } finally { await fixture.close(); }
});

it('a physical native WS generation change rejects late passive reads and re-reads the current catalog', async () => {
  const fixture = await createDshSubagentFixture();
  const held = fixture.hold('session/page', 'reviewer');
  try {
    const read = fixture.adapter.readSubagentHistory('parent', 'reviewer', { limit: 100 });
    const rejected = expect(read).rejects.toMatchObject({ statusCode: 409 });
    await held.seen;
    fixture.disconnect();
    await waitUntil(() => !fixture.client.isConnected, 2000, 'physical fixture WS loss');
    held.release(); await rejected;
    await waitUntil(() => fixture.client.isConnected, 8000, 'physical fixture WS reconnect');
    expect((await fixture.adapter.listSubagents('parent')).items[0]?.status).toBe('completed');
  } finally { held.release(); await fixture.close(); }
});

it('an inherited parent completion and answer cannot settle a new child before its own descriptor', async () => {
  const fixture = await createDshSubagentFixture();
  try {
    fixture.records.set('reviewer', [childRecord(0, 'turn/start', { turn: 7 }),
      childRecord(1, 'assistant/message', { turn: 7, message: { id: 'parent-message', content: [{ type: 'text', text: 'PARENT INHERITED ANSWER' }] } }),
      childRecord(2, 'turn/end', { turn: 7, reason: { kind: 'completed' } }),
      childRecord(3, 'subagent/descriptor', { version: 3, mode: 'continuable', provider: 'fork', label: 'New child' })]);
    fixture.descriptorSeqs.set('reviewer', 3);
    fixture.states.set('reviewer', { cursor: 3, active: false, running: false, queue: null, pendingInput: [] });
    const child = (await fixture.adapter.listSubagents('parent')).items[0];
    expect(child).toMatchObject({ status: 'unknown', ownDescriptorSeq: 3 });
    expect(child?.result).toBeUndefined(); expect(child?.lastTurn).toBeUndefined();
    const history = await fixture.adapter.readSubagentHistory('parent', 'reviewer', { limit: 100 });
    expect(history).toMatchObject({ ownDescriptorSeq: 3 });
    expect(history.records).toEqual(fixture.records.get('reviewer')!.slice(1));
  } finally { await fixture.close(); }
});

it('missing native descriptor identity preserves raw history while withholding unowned results', async () => {
  const fixture = await createDshSubagentFixture();
  try {
    fixture.descriptorSeqs.set('reviewer', null);
    const child = (await fixture.adapter.listSubagents('parent')).items[0];
    expect(child?.status).toBe('unknown'); expect(child?.result).toBeUndefined();
    const history = await fixture.adapter.readSubagentHistory('parent', 'reviewer', { limit: 100 });
    expect(history.ownDescriptorSeq).toBeUndefined(); expect(history.records.length).toBeGreaterThan(0);
  } finally { await fixture.close(); }
});
