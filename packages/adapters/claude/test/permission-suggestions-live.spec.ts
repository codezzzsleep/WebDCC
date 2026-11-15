import { expect, it, vi } from 'vitest';
import type { Options, PermissionUpdate, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterEvent, EventData, TraceFrame } from '@webdcc/protocol';
const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mock.query }));
import { ClaudeAdapter } from '../src/adapter.js';

it('the production SDK callback records native suggestions and returns the same complete set as replay', async () => {
  let closed = false; let wake: (() => void) | undefined; let options!: Options;
  const messages: SDKMessage[] = [];
  const q = { async *[Symbol.asyncIterator]() {
    while (!closed) {
      const message = messages.shift();
      if (message !== undefined) yield message;
      else await new Promise<void>(resolve => { wake = resolve; });
    }
  }, close() { closed = true; wake?.(); }, initializationResult: async () => ({}) };
  mock.query.mockImplementation((args: { options: Options }) => { options = args.options; return q as unknown as Query; });
  const frames: TraceFrame[] = []; const events: AdapterEvent[] = [];
  const adapter = new ClaudeAdapter({ traceSink: { record: frame => { frames.push(structuredClone(frame)); } } });
  adapter.onEvent((_id, event) => events.push(event));
  try {
    await adapter.create({ sessionId: 'local', cwd: '.', providerId: null });
    const updates: PermissionUpdate[] = [{ type: 'addRules', destination: 'session', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'pwd' }] }];
    const input = { command: 'pwd' };
    const pending = options.canUseTool!('Bash', input, { signal: new AbortController().signal, toolUseID: 'tool', requestId: 'request', suggestions: updates, defaultToNo: true });
    const event = events.find(event => event.type === 'item.complete' && event.kind === 'approval.request');
    if (event?.type !== 'item.complete') throw new Error('No approval');
    const approval = event.data as EventData['approval.request'];
    await adapter.respond('local', { approvalId: approval.approvalId, optionId: 'allow-native-suggestions' });
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: input, updatedPermissions: updates });
    const frame = frames.find(frame => frame.ch === 'canUseTool' && frame.dir === 'in')!;
    expect(frame.frame).toMatchObject({ suggestions: updates, defaultToNo: true });
    const replay = ClaudeAdapter.replay('local');
    const replayEvent = replay.feed(frame).find(event => event.type === 'item.complete' && event.kind === 'approval.request');
    expect(replayEvent?.type === 'item.complete' && replayEvent.data).toEqual(approval);
    await replay.adapter.respond('local', { approvalId: approval.approvalId, optionId: 'allow-native-suggestions' });
    await expect.poll(() => replay.decisions[0]).toEqual({ behavior: 'allow', updatedInput: input, updatedPermissions: updates });
    expect(frames.find(frame => frame.ch === 'canUseTool-result')?.frame).toMatchObject({ result: { updatedPermissions: updates } });
  } finally { await adapter.dispose('local'); mock.query.mockReset(); }
});
