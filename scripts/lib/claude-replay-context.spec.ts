import { expect, it } from 'vitest';
import { claudeReplayContexts, type CapturedRow } from './claude-replay-context.js';
import { ClaudeAdapter } from '../../packages/adapters/claude/src/adapter.js';
const start = (seq: number, id = 'real-query', generation = 1): CapturedRow => ({ runId: 'capture', seq, source: 'mapped', value: { type: 'item.complete', kind: 'internal', data: { nativeType: 'claude-query-runtime', claudeQueryGeneration: generation, claudeTaskRuntime: { id, state: 'started' } } } });
const message = { type: 'assistant', session_id: 'native', parent_tool_use_id: null, uuid: 'delivery', message: { id: 'original-message', content: [{ type: 'text', text: 'original' }], stop_reason: 'end_turn' } };
const native = (seq: number): CapturedRow => ({ runId: 'capture', seq, source: 'native', value: { i: seq, t: seq, dir: 'in', ch: 'sdk', frame: message } });
it('reuses the recorded lifecycle identity without taking it from expected output', () => {
  const contexts = claudeReplayContexts([start(1), native(2), { runId: 'capture', seq: 3, source: 'mapped', value: { data: { claudeBlock: { queryId: 'forged-expected' } } } }]);
  expect(contexts[0]?.queryId).toBe('real-query');
  const events = ClaudeAdapter.replay('web', contexts[0]).feed({ i: 2, t: 2, dir: 'in', ch: 'sdk', frame: message });
  expect(events).toContainEqual(expect.objectContaining({ kind: 'assistant.message', data: expect.objectContaining({ claudeBlock: expect.objectContaining({ queryId: 'real-query', nativeMessageId: 'original-message' }) }) }));
});
it('missing, late, other-run and repeated lifecycle evidence stays rejected', () => {
  for (const rows of [[native(2)], [native(1), start(2)], [{ ...start(1), runId: 'wrong' }, native(2)], [start(1), start(2), native(3)]]) expect(() => claudeReplayContexts(rows)).toThrow();
});
it('ordered query replacements retain their actual IDs and boundaries', () => {
  expect(claudeReplayContexts([start(1), native(2), start(3, 'next-query', 2), native(4)]).map(c => [c.queryId, c.generation, c.throughSequence])).toEqual([['real-query', 1, 2], ['next-query', 2, Number.MAX_SAFE_INTEGER - 1]]);
});

it('old captures require an independent native generation witness and cannot invent one from output item IDs', () => {
  const old = start(1); delete (old.value as { data: Record<string, unknown> }).data['claudeQueryGeneration'];
  expect(() => claudeReplayContexts([old, native(2)])).toThrow('Missing or conflicting');
  const witness: CapturedRow = { runId: 'capture', seq: 3, source: 'native', value: { i: 3, t: 3, dir: 'in', ch: 'canUseTool', frame: { queryGeneration: 7 } } };
  expect(claudeReplayContexts([old, native(2), witness])[0]?.generation).toBe(7);
});
