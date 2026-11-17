import { expect, it } from 'vitest';
import type { TraceFrame } from '@webdcc/protocol';
import { DshAdapter } from '../src/adapter.js';
import type { DshHostClient } from '../src/host.js';
import captured from '../../../../fixtures/dsh/question-settlement.json' with { type: 'json' };

const questions = [{ id: 'one', question: 'Exact native question', options: [{ label: 'Continue' }] }];
const input = (value: unknown): TraceFrame => ({ i: 1, t: 1, dir: 'in', ch: 'mux:$events', frame: { type: 'item', value } });
const event = (type: string, seq: number, data: unknown) => input({ type: 'event', event: { type, seq, time: seq, data } });
const waterfall = () => input({ type: 'waterfall', event: 'user-questions/request', eventId: 'question-waterfall', agentId: 'native-root', request: { questions } });
function pendingQuestion() {
  const replay = DshAdapter.replay('local', 'native-root');
  replay.feed(input({ type: 'ready', clientId: 'client-one' }));
  replay.feed(event('tool/call', 1, { callId: 'question-call', name: 'ask_user_question', arguments: JSON.stringify({ questions }) }));
  replay.feed(waterfall());
  return replay;
}

it('a void foreground reply only submits an answer; its exact native tool result settles the original question', async () => {
  const replay = pendingQuestion();
  const answer = { selected: ['Continue'], custom: '  exact answer\r\n  ' };
  expect(await replay.adapter.answer('local', 'question-waterfall:one', answer)).toMatchObject({ submitted: true, confirmed: false });
  const resolved = replay.feed(event('tool/result', 2, { message: { toolCallId: 'question-call', content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'one', ...answer }] }) }], isError: false } }));
  expect(resolved).toContainEqual(expect.objectContaining({ kind: 'question', data: expect.objectContaining({ questionId: 'question-waterfall:one', toolCallId: 'question-call', status: 'answered', resolution: 'native-resolved' }) }));
});

it('a native timed settlement from another UI closes the foreground waterfall question by its actual call identity', () => {
  const replay = DshAdapter.replay('local', 'native-root');
  replay.feed(input({ type: 'ready', clientId: 'client-one' }));
  replay.feed(input({ type: 'waterfall', event: 'user-questions/request', eventId: 'question-waterfall', agentId: 'native-root', request: { questions, wait: { callId: 'question-call' } } }));
  const resolved = replay.feed(input({ type: 'projection', seq: 2, changes: [{ key: 'userQuestions', val: { active: [], settled: [{ callId: 'question-call', answers: [{ id: 'one', selected: ['Continue'] }] }] } }] }));
  expect(resolved).toContainEqual(expect.objectContaining({ kind: 'question', data: expect.objectContaining({ questionId: 'question-waterfall:one', status: 'answered', resolution: 'native-resolved' }) }));
});

it('a delayed old-client reply cannot retire a question reoffered to the current client', async () => {
  const replay = pendingQuestion();
  const client = (replay.adapter as unknown as { client: DshHostClient }).client;
  let release!: () => void;
  client.rpc = async <T>() => { await new Promise<void>(resolve => { release = resolve; }); return undefined as T; };
  const sending = replay.adapter.answer('local', 'question-waterfall:one', 'old-client-answer');
  await expect.poll(() => typeof release).toBe('function');
  replay.feed(input({ type: 'ready', clientId: 'client-two' }));
  replay.feed(waterfall());
  release();
  await expect(sending).rejects.toMatchObject({ code: 'uncertain' });
  client.rpc = async <T>() => undefined as T;
  await expect(replay.adapter.answer('local', 'question-waterfall:one', 'current-client-answer')).resolves.toMatchObject({ submitted: true, confirmed: false });
});

it('a forwarding cancellation followed by another UI native answer converges to answered, without calling it a user cancellation', () => {
  const replay = pendingQuestion();
  replay.feed(input({ type: 'cancel', eventId: 'question-waterfall' }));
  const resolved = replay.feed(event('tool/result', 2, { message: { toolCallId: 'question-call', content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'one', selected: ['Continue'] }] }) }], isError: false } }));
  expect(resolved).toContainEqual(expect.objectContaining({ kind: 'question', data: expect.objectContaining({ questionId: 'question-waterfall:one', status: 'answered', resolution: 'native-resolved' }) }));
});

it('replays exact native legacy multi_select, waterfall and tool result identities from the scripted-model native capture', async () => {
  const replay = DshAdapter.replay('local', captured.nativeId);
  for (const index of [3, 410, 413]) replay.feed(captured.frames.find(frame => frame.i === index)! as TraceFrame);
  const request = captured.frames.find(frame => frame.i === 1304)!.frame as { frame: { payload: { args: { eventId: string; outcome: { value: { answers: { id: string; selected: string[]; custom?: string }[] } } } } } };
  const { eventId, outcome } = request.frame.payload.args;
  for (const answer of outcome.value.answers) await replay.adapter.answer('local', `${eventId}:${answer.id}`, answer);
  expect(replay.replies.at(-1)).toMatchObject({ endpoint: '$events/result', args: request.frame.payload.args });
  const resolved = replay.feed(captured.frames.find(frame => frame.i === 1309)! as TraceFrame);
  const questions = resolved.filter(value => value.type === 'item.complete' && value.kind === 'question');
  expect(questions).toHaveLength(2);
  for (const answer of outcome.value.answers) expect(questions).toContainEqual(expect.objectContaining({
    data: expect.objectContaining({ questionId: `${eventId}:${answer.id}`, toolCallId: 'toolu_mock_mwi3jdqk_3', status: 'answered', resolution: 'native-resolved' }),
    nativeSeq: 20,
  }));
});

it('missing or ambiguous call identities and partial answer batches cannot manufacture a successful question result', () => {
  const replay = pendingQuestion();
  const incomplete = replay.feed(event('tool/result', 2, { message: { toolCallId: 'question-call', content: [{ type: 'text', text: '{"answers":[]}' }], isError: false } }));
  expect(incomplete).toContainEqual(expect.objectContaining({ kind: 'question', data: expect.objectContaining({ status: 'skipped', resolution: 'outcome-unknown' }) }));
  const ambiguous = DshAdapter.replay('local', 'native-root');
  for (const [index, callId] of ['first-call', 'second-call'].entries()) ambiguous.feed(event('tool/call', index + 1, { callId, name: 'ask_user_question', arguments: JSON.stringify({ questions }) }));
  ambiguous.feed(waterfall());
  const unresolved = ambiguous.feed(event('tool/result', 3, { message: { toolCallId: 'first-call', content: [{ type: 'text', text: '{"answers":[{"id":"one","selected":["Continue"]}]}' }], isError: false } }));
  expect(unresolved.filter(value => value.type === 'item.complete' && value.kind === 'question')).toHaveLength(0);
});

it('a native result racing the HTTP ACK remains authoritative and does not reopen or duplicate the question', async () => {
  const replay = pendingQuestion(); const client = (replay.adapter as unknown as { client: DshHostClient }).client;
  let release!: () => void;
  client.rpc = async <T>() => { await new Promise<void>(resolve => { release = resolve; }); return undefined as T; };
  const sending = replay.adapter.answer('local', 'question-waterfall:one', { selected: ['Continue'] });
  await expect.poll(() => typeof release).toBe('function');
  expect(replay.feed(event('tool/result', 2, { message: { toolCallId: 'question-call', content: [{ type: 'text', text: '{"answers":[{"id":"one","selected":["Continue"]}]}' }], isError: false } })))
    .toContainEqual(expect.objectContaining({ kind: 'question', data: expect.objectContaining({ status: 'answered', resolution: 'native-resolved' }) }));
  release(); await expect(sending).rejects.toMatchObject({ code: 'uncertain' });
  await expect(replay.adapter.answer('local', 'question-waterfall:one', 'again')).rejects.toThrow('不存在');
});

it('a native tool cancellation preserves the distinction between an ended question and an accepted answer', async () => {
  const replay = pendingQuestion();
  await replay.adapter.answer('local', 'question-waterfall:one', { selected: ['Continue'] });
  const ended = replay.feed(event('tool/result', 2, { message: { toolCallId: 'question-call', content: [{ type: 'text', text: 'Error: ask_user_question was aborted before the user answered' }], isError: true },
    error: { name: 'UserQuestionError', code: 'ASK_ABORTED' } }));
  expect(ended).toContainEqual(expect.objectContaining({ kind: 'question', data: expect.objectContaining({ status: 'skipped', outcome: 'cancel', resolution: 'external' }) }));
});
