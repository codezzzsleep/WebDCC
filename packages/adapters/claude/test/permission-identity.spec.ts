import { afterEach, expect, it, vi } from 'vitest';
import type { CanUseTool, Options, Query } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterEvent, EventData, TraceFrame } from '@webdcc/protocol';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }));
import { ClaudeAdapter } from '../src/adapter.js';

afterEach(() => mocks.query.mockReset());

async function session() {
  let close: (() => void) | undefined;
  const finished = new Promise<void>(resolve => { close = resolve; });
  let options!: Options;
  mocks.query.mockImplementation((args: { options: Options }) => {
    options = args.options;
    return { [Symbol.asyncIterator]() { return { async next() { await finished; return { done: true as const, value: undefined }; } }; }, close: () => close?.() } as unknown as Query;
  });
  const events: AdapterEvent[] = [], frames: TraceFrame[] = [];
  const adapter = new ClaudeAdapter({ traceSink: { record: frame => { frames.push(frame); } } });
  adapter.onEvent((_id, event) => events.push(event));
  await adapter.create({ sessionId: 'local', cwd: '.', providerId: null });
  const controllers: AbortController[] = [];
  const ask = (requestId: string, command: string, toolUseID = 'shared-tool') => {
    const controller = new AbortController(); controllers.push(controller);
    const callbackOptions: Parameters<CanUseTool>[2] = { requestId, toolUseID, signal: controller.signal };
    return options.canUseTool!('Bash', { command }, callbackOptions);
  };
  const approvals = () => events.flatMap(event => event.type === 'item.complete' && event.kind === 'approval.request' ? [event.data as EventData['approval.request']] : []);
  return { adapter, events, frames, options, ask, approvals, controllers, async cleanup() { controllers.forEach(controller => controller.abort()); await adapter.dispose('local'); } };
}

it('distinct native control requests sharing a tool call retain independent approval callbacks', async () => {
  const ctx = await session();
  const settled: string[] = [];
  try {
    const first = ctx.ask('request:first', 'pwd').then(value => { settled.push('first'); return value; });
    const second = ctx.ask('request:second', 'ls').then(value => { settled.push('second'); return value; });
    const [one, two] = ctx.approvals();
    console.info('controlled baseline', JSON.stringify({ approvalIds: ctx.approvals().map(item => item.approvalId), capturedRequestIds: ctx.frames.filter(frame => frame.ch === 'canUseTool').map(frame => (frame.frame as Record<string, unknown>)['requestId']) }));
    await ctx.adapter.respond('local', { approvalId: two!.approvalId, optionId: 'allow' });
    await expect(second).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    console.info('controlled settlement after second approval', JSON.stringify(settled));
    expect(one!.approvalId).not.toBe(two!.approvalId);
    expect(settled).toEqual(['second']);
    await ctx.adapter.respond('local', { approvalId: one!.approvalId, optionId: 'deny' });
    await expect(first).resolves.toMatchObject({ behavior: 'deny' });
  } finally { await ctx.cleanup(); }
});

it('the SDK request identity survives incoming and returned native evidence', async () => {
  const ctx = await session();
  try {
    const pending = ctx.ask('request:identity', 'pwd');
    await ctx.adapter.respond('local', { approvalId: ctx.approvals()[0]!.approvalId, optionId: 'allow' });
    await pending;
    const frames = ctx.frames.filter(frame => frame.ch === 'canUseTool' || frame.ch === 'canUseTool-result');
    expect(frames).toHaveLength(2);
    expect(frames.map(frame => frame.frame)).toEqual([
      { toolName: 'Bash', input: { command: 'pwd' }, toolUseID: 'shared-tool', requestId: 'request:identity', queryGeneration: 1 },
      { toolName: 'Bash', toolUseID: 'shared-tool', requestId: 'request:identity', queryGeneration: 1, result: { behavior: 'allow', updatedInput: { command: 'pwd' } } },
    ]);
  } finally { await ctx.cleanup(); }
});

it('aborting one native control does not remove another request for the same tool', async () => {
  const ctx = await session();
  try {
    const first = ctx.ask('aborted', 'pwd'), second = ctx.ask('retained', 'ls');
    const [, retained] = ctx.approvals();
    ctx.controllers[0]!.abort();
    await expect(first).resolves.toMatchObject({ behavior: 'deny' });
    await ctx.adapter.respond('local', { approvalId: retained!.approvalId, optionId: 'allow' });
    await expect(second).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  } finally { await ctx.cleanup(); }
});

it.each(['pwd', 'changed-content'])('duplicate native requestId is denied without overwriting the original prompt (%s)', async command => {
  const ctx = await session();
  try {
    const first = ctx.ask('duplicate', 'pwd');
    await expect(ctx.ask('duplicate', command)).resolves.toMatchObject({ behavior: 'deny' });
    expect(ctx.approvals()).toHaveLength(1);
    await ctx.adapter.respond('local', { approvalId: ctx.approvals()[0]!.approvalId, optionId: 'allow' });
    await expect(first).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'pwd' } });
    await expect(ctx.ask('duplicate', command)).resolves.toMatchObject({ behavior: 'deny' });
    expect(ctx.approvals()).toHaveLength(1);
  } finally { await ctx.cleanup(); }
});

it('legacy replay identities remain compatible and cannot collide with escaped control identities', async () => {
  const replay = ClaudeAdapter.replay('local');
  const requests = [
    { toolName: 'Bash', input: { command: 'legacy' }, toolUseID: 'request:one' },
    { toolName: 'Bash', input: { command: 'current' }, toolUseID: 'shared-tool', requestId: 'request:one', queryGeneration: 4 },
  ];
  const events = requests.flatMap((frame, index) => replay.feed({ i: index + 1, t: 0, dir: 'in', ch: 'canUseTool', frame }));
  const ids = events.flatMap(event => event.type === 'item.complete' && event.kind === 'approval.request' ? [(event.data as EventData['approval.request']).approvalId] : []);
  expect(ids).toEqual(['local:request:one', 'local:claude-control:4:request%3Aone']);
  await replay.adapter.respond('local', { approvalId: ids[1]!, optionId: 'allow' });
  await expect.poll(() => replay.decisions).toEqual([{ behavior: 'allow', updatedInput: { command: 'current' } }]);
  await replay.adapter.respond('local', { approvalId: ids[0]!, optionId: 'deny' });
  await expect.poll(() => replay.decisions).toHaveLength(2);
});

it('an older legacy callback cleanup cannot delete a new waiter reusing its historical tool identity', async () => {
  const replay = ClaudeAdapter.replay('local');
  const ask = (command: string) => replay.feed({ i: 1, t: 0, dir: 'in', ch: 'canUseTool', frame: { toolName: 'Bash', input: { command }, toolUseID: 'legacy-tool' } });
  ask('first');
  const submitted = replay.adapter.respond('local', { approvalId: 'local:legacy-tool', optionId: 'allow' });
  ask('second');
  await submitted;
  await expect.poll(() => replay.decisions).toHaveLength(1);
  await replay.adapter.respond('local', { approvalId: 'local:legacy-tool', optionId: 'deny' });
  await expect.poll(() => replay.decisions).toMatchObject([{ behavior: 'allow', updatedInput: { command: 'first' } }, { behavior: 'deny' }]);
});

it('recorded query generations distinguish repeated native request ids after a query replacement', async () => {
  const replay = ClaudeAdapter.replay('local');
  const ids: string[] = [];
  for (const queryGeneration of [1, 2]) {
    const events = replay.feed({ i: queryGeneration, t: 0, dir: 'in', ch: 'canUseTool', frame: { toolName: 'Bash', input: { command: 'pwd' }, toolUseID: 'tool', requestId: 'reused-native-id', queryGeneration } });
    for (const event of events) if (event.type === 'item.complete' && event.kind === 'approval.request') ids.push((event.data as EventData['approval.request']).approvalId);
  }
  expect(ids).toEqual(['local:claude-control:1:reused-native-id', 'local:claude-control:2:reused-native-id']);
  await replay.adapter.respond('local', { approvalId: ids[0]!, optionId: 'deny' });
  await replay.adapter.respond('local', { approvalId: ids[1]!, optionId: 'allow' });
  await expect.poll(() => replay.decisions).toHaveLength(2);
});

it.each([42, '', null])('invalid supplied native requestId is denied rather than coerced into a tool identity (%j)', async requestId => {
  const ctx = await session();
  try {
    await expect(ctx.options.canUseTool!('Bash', { command: 'pwd' }, { signal: new AbortController().signal, toolUseID: 'tool', requestId } as unknown as Parameters<CanUseTool>[2])).resolves.toMatchObject({ behavior: 'deny' });
    expect(ctx.approvals()).toEqual([]);
  } finally { await ctx.cleanup(); }
});

it('an already aborted native request does not create a new actionable approval', async () => {
  const ctx = await session();
  try {
    const controller = new AbortController(); controller.abort();
    await expect(ctx.options.canUseTool!('Bash', { command: 'pwd' }, { signal: controller.signal, requestId: 'aborted', toolUseID: 'tool' })).resolves.toMatchObject({ behavior: 'deny' });
    expect(ctx.approvals()).toEqual([]);
  } finally { await ctx.cleanup(); }
});

it('question control identity retains tool correlation and waits for native tool result confirmation', async () => {
  const replay = ClaudeAdapter.replay('local');
  const observed: AdapterEvent[] = [];
  replay.adapter.onEvent((_id, event) => observed.push(event));
  const input = { questions: [{ question: 'Exact original?', options: [] }] };
  const question = replay.feed({ i: 1, t: 0, dir: 'in', ch: 'canUseTool', frame: { toolName: 'AskUserQuestion', input, toolUseID: 'original-tool', requestId: 'control:question' } }).find(event => event.type === 'item.complete' && event.kind === 'question');
  if (question?.type !== 'item.complete') throw new Error('No question');
  const data = question.data as EventData['question'];
  expect(data).toMatchObject({ groupId: 'claude-control:1:control%3Aquestion', toolCallId: 'original-tool' });
  await expect(replay.adapter.answer('local', data.questionId, { custom: '  original answer  ' })).resolves.toMatchObject({ submitted: true, confirmed: false });
  await expect.poll(() => replay.decisions).toEqual([{ behavior: 'allow', updatedInput: { ...input, answers: { 'Exact original?': '  original answer  ' } } }]);
  const resolutions = () => observed.filter(event => event.type === 'item.complete' && event.kind === 'question' && (event.data as EventData['question']).status !== undefined);
  expect(resolutions()).toEqual([]);
  const result = (toolUseID: string) => replay.feed({ i: 2, t: 1, dir: 'in', ch: 'sdk', frame: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseID, content: 'native result' }] } } });
  result('unrelated'); expect(resolutions()).toEqual([]);
  result('original-tool'); expect(resolutions()).toMatchObject([{ data: { questionId: data.questionId, status: 'answered', resolution: 'native-acknowledged' } }]);
});

it('ambiguous question tool results keep separate control groups and never claim successful answers', async () => {
  const replay = ClaudeAdapter.replay('local');
  const observed: AdapterEvent[] = [];
  replay.adapter.onEvent((_id, event) => observed.push(event));
  for (const requestId of ['first', 'second']) {
    const items = replay.feed({ i: 1, t: 0, dir: 'in', ch: 'canUseTool', frame: { toolName: 'AskUserQuestion', input: { questions: [{ question: requestId, options: [] }] }, toolUseID: 'same-tool', requestId } });
    const event = items.find(event => event.type === 'item.complete' && event.kind === 'question');
    if (event?.type !== 'item.complete') throw new Error('No question');
    await replay.adapter.answer('local', (event.data as EventData['question']).questionId, { custom: requestId });
  }
  await expect.poll(() => replay.decisions).toHaveLength(2);
  const events = replay.feed({ i: 3, t: 1, dir: 'in', ch: 'sdk', frame: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'same-tool', content: 'ambiguous native result' }] } } });
  const resolved = events.flatMap(event => event.type === 'item.complete' && event.kind === 'question' ? [event.data as EventData['question']] : []);
  expect(resolved).toHaveLength(2);
  expect(resolved.map(data => data.questionId)).toEqual(['claude-control:1:first:0', 'claude-control:1:second:0']);
  expect(resolved).toMatchObject([{ status: 'skipped', resolution: 'outcome-unknown' }, { status: 'skipped', resolution: 'outcome-unknown' }]);
});
