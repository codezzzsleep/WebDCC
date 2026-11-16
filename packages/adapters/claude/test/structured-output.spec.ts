import { afterEach, expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterEvent, TraceFrame } from '@webdcc/protocol';

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocked.query }));
import { ClaudeAdapter } from '../src/adapter.js';

const frame = (i: number, value: unknown): TraceFrame => ({ i, t: i, dir: 'in', ch: 'sdk', frame: value });
const result = (uuid: string, extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success',
  uuid, session_id: 'native-output', result: 'ordinary answer', is_error: false, result_index: 0, ...extra });
const outputs = (events: AdapterEvent[]) => events.filter((event): event is Extract<AdapterEvent, { type: 'item.complete' }> =>
  event.type === 'item.complete' && String(event.kind) === 'structured.output');

function harness() {
  const queries: { q: Query; options: Options; push: (value: unknown) => void }[] = [];
  mocked.query.mockImplementation(({ options }: { options: Options }) => {
    let ended = false; let wake: (() => void) | undefined;
    const messages: SDKMessage[] = [];
    const q = {
      async *[Symbol.asyncIterator]() {
        while (!ended || messages.length > 0) {
          const message = messages.shift();
          if (message !== undefined) yield message;
          else await new Promise<void>(resolve => { wake = resolve; });
        }
      },
      close: vi.fn(() => { ended = true; wake?.(); }),
      initializationResult: vi.fn(async () => ({ claude_code_version: '2.1.322' })),
      supportedModels: vi.fn(async () => []), supportedCommands: vi.fn(async () => []),
      supportedAgents: vi.fn(async () => []), accountInfo: vi.fn(async () => ({})), mcpServerStatus: vi.fn(async () => []),
    } as unknown as Query;
    queries.push({ q, options, push(value) { messages.push(value as SDKMessage); wake?.(); } });
    return q;
  });
  const events: AdapterEvent[] = [];
  const adapter = new ClaudeAdapter(); adapter.onEvent((_id, event) => events.push(event));
  return { adapter, queries, events };
}

afterEach(() => mocked.query.mockReset());

it.each([{ ok: true }, ['first', { second: 2 }], null, false, 0, 'native string'].map(value => ({ value })))('retains the exact structured value $value with its own native result identity', ({ value }) => {
  const replay = ClaudeAdapter.replay('web-output');
  const events = replay.feed(frame(1, result('result-one', { structured_output: value })));
  expect(outputs(events)).toHaveLength(1);
  expect(outputs(events)[0]).toMatchObject({ kind: 'structured.output', data: {
    agent: 'claude-code', status: 'completed', nativeSessionId: 'native-output', nativeResultId: 'result-one', resultIndex: 0, value,
  } });
  expect(events).toContainEqual(expect.objectContaining({ kind: 'assistant.message', data: { text: 'ordinary answer', nativePhase: 'final_result' } }));
});

it('keeps two structured results distinct and preserves the last value after an ordinary result', () => {
  const replay = ClaudeAdapter.replay('web-output');
  const first = outputs(replay.feed(frame(1, result('result-one', { structured_output: { first: 1 } }))));
  const second = outputs(replay.feed(frame(2, result('result-two', { result_index: 1, structured_output: { second: 2 } }))));
  replay.feed(frame(3, result('result-three', { result_index: 2, result: '{"looks":"structured"}' })));
  expect(first[0]?.itemKey).toBeDefined();
  expect(second[0]?.itemKey).toBeDefined();
  expect(first[0]?.itemKey).not.toBe(second[0]?.itemKey);
  expect(replay.adapter.nativeState('web-output').structuredOutput).toEqual({ second: 2 });
});

it('does not parse ordinary text into a structured success', () => {
  const replay = ClaudeAdapter.replay('web-output');
  expect(outputs(replay.feed(frame(1, result('plain-json', { result: '{"ok":true}' }))))).toEqual([]);
  expect(outputs(replay.feed(frame(2, result('plain-invalid-json', { result: '{broken' }))))).toEqual([]);
});

it('preserves native schema retry failure, errors and terminal reason without a fabricated value', () => {
  const replay = ClaudeAdapter.replay('web-output');
  const events = replay.feed(frame(1, result('schema-failed', { subtype: 'error_max_structured_output_retries', is_error: true,
    terminal_reason: 'structured_output_retry_exhausted', errors: ['native parse failure', 'schema validation failed'], result: '{broken' })));
  expect(outputs(events)[0]).toMatchObject({ data: { status: 'failed', nativeSubtype: 'error_max_structured_output_retries',
    terminalReason: 'structured_output_retry_exhausted', errors: ['native parse failure', 'schema validation failed'], rawText: '{broken' } });
  expect(outputs(events)[0]?.data).not.toHaveProperty('value');
  expect(events).toContainEqual(expect.objectContaining({ type: 'turn.end', status: 'failed' }));
});

it('preserves a partial native structured value on an interrupted result', () => {
  const replay = ClaudeAdapter.replay('web-output');
  const events = replay.feed(frame(1, result('output-interrupted', { subtype: 'error_during_execution', is_error: true,
    terminal_reason: 'aborted_tools', errors: ['cancelled during tools'], structured_output: { partial: true } })));
  expect(outputs(events)[0]).toMatchObject({ data: { status: 'interrupted', value: { partial: true }, terminalReason: 'aborted_tools' } });
  expect(events).toContainEqual(expect.objectContaining({ type: 'turn.end', status: 'interrupted' }));
});

it('production uses the replay semantics and isolates the results of a replacement query', async () => {
  const h = harness();
  try {
    await h.adapter.create({ sessionId: 's', cwd: '/tmp', providerId: null });
    h.queries[0]!.push(result('old-result', { structured_output: { old: true } }));
    await vi.waitFor(() => expect(h.adapter.nativeState('s').structuredOutput).toEqual({ old: true }));
    const oldEvents = outputs(h.events);
    const replay = ClaudeAdapter.replay('s');
    const replayEvents = outputs(replay.feed(frame(1, result('old-result', { structured_output: { old: true } }))));
    const { queryId: replayQuery, ...semantics } = replayEvents[0]!.data as Record<string, unknown>;
    expect(replayQuery).toBe('replay:s');
    expect(oldEvents[0]?.data).toMatchObject(semantics);
    expect((oldEvents[0]?.data as Record<string, unknown>)['queryId']).toEqual(expect.any(String));
    await h.adapter.setModel('s', 'next-model');
    h.queries[0]!.push(result('late-old-result', { structured_output: { late: true } }));
    h.queries[1]!.push(result('new-result', { structured_output: { current: true } }));
    await vi.waitFor(() => expect(h.adapter.nativeState('s').structuredOutput).toEqual({ current: true }));
    expect(outputs(h.events)).toHaveLength(2);
    expect((outputs(h.events)[1]?.data as Record<string, unknown>)['queryId']).not.toBe((oldEvents[0]?.data as Record<string, unknown>)['queryId']);
    expect(outputs(h.events).map(event => event.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ nativeResultId: 'old-result', value: { old: true } }),
      expect.objectContaining({ nativeResultId: 'new-result', value: { current: true } }),
    ]));
  } finally { await h.adapter.dispose('s'); }
});

it('passes the exact explicit schema to the next query and keeps an absent result unconfirmed', async () => {
  const h = harness();
  const schema = { type: 'object', properties: { exact: { type: 'string' } }, required: ['exact'], additionalProperties: false };
  try {
    await h.adapter.create({ sessionId: 's', cwd: '/tmp', providerId: null });
    await expect(h.adapter.executeNativeControl('s', { type: 'output', schema: { type: 'bad-type' } })).rejects.toMatchObject({ code: 'native-control-rejected' });
    expect(h.queries).toHaveLength(1);
    await h.adapter.executeNativeControl('s', { type: 'output', schema });
    expect(h.queries[1]!.options.outputFormat).toEqual({ type: 'json_schema', schema });
    h.queries[1]!.push(result('missing-attachment', { result: 'This is still ordinary text.' }));
    await vi.waitFor(() => expect(outputs(h.events)).toHaveLength(1));
    expect(outputs(h.events)[0]).toMatchObject({ data: { status: 'unknown', source: 'result', rawText: 'This is still ordinary text.' } });
    expect(outputs(h.events)[0]!.data).not.toHaveProperty('value');
  } finally { await h.adapter.dispose('s'); }
});
