import { expect, it } from 'vitest';
import { DshAdapter } from '../src/adapter.js';
import type { TraceFrame } from '@webdcc/protocol';
import { DshHostClient } from '../src/host.js';

const frame = (value: unknown, i = 1): TraceFrame => ({ i, t: i, dir: 'in', ch: 'mux:$events', frame: { type: 'item', value } });

it('NP-11 pairs native durable approval IDs with waterfall IDs and preserves the actual outcome', () => {
  const replay = DshAdapter.replay('session');
  replay.feed(frame({ type: 'event', event: { type: 'approval/asked', seq: 1, data: { id: 'durable', callId: 'tool', toolName: 'bash' } } }));
  replay.feed(frame({ type: 'waterfall', event: 'approval/request', eventId: 'waterfall', request: { callId: 'tool', toolName: 'bash' } }));
  expect(replay.feed(frame({ type: 'event', event: { type: 'approval/decided', seq: 2, data: { id: 'durable', outcome: 'rejected' } } }))).toContainEqual(expect.objectContaining({ kind: 'approval.resolved', data: { approvalId: 'waterfall', optionId: 'rejected', by: 'other' } }));
});

it('NP-11 keeps questions after failed replies and closes each card on a native cancellation', async () => {
  const replay = DshAdapter.replay('session');
  replay.feed(frame({ type: 'ready', clientId: 'client' }));
  replay.feed(frame({ type: 'waterfall', event: 'user-questions/request', eventId: 'question', request: { questions: [{ id: 'one', question: 'first' }, { id: 'two', question: 'second' }] } }));
  expect(await replay.adapter.answer('session', 'question:one', { selected: [], custom: 'first text' })).toEqual({ submitted: false });
  const original = DshHostClient.prototype.rpc;
  // The replay fixture captures outbound RPC; use the real adapter state and
  // a failing transport to exercise the retry window at its boundary.
  const client = (replay.adapter as unknown as { client: DshHostClient }).client;
  const rpc = client.rpc;
  client.rpc = async () => { throw new Error('offline'); };
  await expect(replay.adapter.answer('session', 'question:two', { selected: [], custom: 'second text' })).rejects.toThrow('offline');
  client.rpc = rpc;
  expect(await replay.adapter.answer('session', 'question:two', { selected: [], custom: 'second text' })).toEqual({ submitted: true });
  expect(replay.replies.at(-1)).toMatchObject({ endpoint: '$events/result', args: { eventId: 'question', outcome: { value: { answers: [{ id: 'one', selected: [], custom: 'first text' }, { id: 'two', selected: [], custom: 'second text' }] } } } });
  expect(DshHostClient.prototype.rpc).toBe(original);
  replay.feed(frame({ type: 'waterfall', event: 'user-questions/request', eventId: 'cancel-me', request: { questions: [{ id: 'one', question: 'pending' }] } }));
  expect(replay.feed(frame({ type: 'cancel', eventId: 'cancel-me' }))).toContainEqual(expect.objectContaining({ kind: 'question', data: { questionId: 'cancel-me:one', prompt: '', status: 'skipped' } }));
  await expect(replay.adapter.answer('session', 'cancel-me:one', 'too late')).rejects.toThrow('不存在');
});

it('NP-11 limits child controls to the exact direct parent and continuable catalog entries', async () => {
  const replay = DshAdapter.replay('session');
  replay.feed(frame({ type: 'snapshot', header: { id: 'native-parent' }, cursor: -1, records: [], hasMore: false }));
  replay.feed(frame({ type: 'event', event: { type: 'subagent/catalog', seq: 0, time: 1000, data: { childId: 'child', mode: 'continuable' } } }));
  await replay.adapter.sendSubagent('session', 'child', '  original\r\n');
  expect(replay.replies.at(-1)).toMatchObject({ endpoint: 'subagents/prompt', args: { request: { parentSessionId: 'native-parent', childSessionId: 'child', mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: '  original\r\n' }] } } });
  await replay.adapter.interruptSubagent('session', 'child');
  expect(replay.replies.at(-1)).toMatchObject({ endpoint: 'subagents/interruptByParent', args: { parentSessionId: 'native-parent', childSessionId: 'child', mode: 'continuable' } });
  await expect(replay.adapter.sendSubagent('session', 'other-parent-child', 'text')).rejects.toMatchObject({ statusCode: 409 });
  replay.feed(frame({ type: 'event', event: { type: 'subagent/catalog', seq: 1, time: 1001, data: { childId: 'one-shot', mode: 'one-shot' } } }));
  await expect(replay.adapter.interruptSubagent('session', 'one-shot')).rejects.toMatchObject({ statusCode: 409 });
});
