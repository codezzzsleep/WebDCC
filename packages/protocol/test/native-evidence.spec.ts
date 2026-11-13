import { describe, expect, it } from 'vitest';
import { nativePredicates, scenarioNativePredicates } from '../src/native-evidence.js';
import type { TraceFrame } from '../src/trace.js';

const frame = (dir: 'in' | 'out', value: unknown, ch = 'rpc'): TraceFrame => ({ i: 1, t: 0, dir, ch, frame: value });

describe('NP-15 native scene predicates', () => {
  it('requires an actual matching native request before counting an approval or question answer', () => {
    const reply = frame('out', { id: 'native-id', result: { decision: 'decline' } });
    expect(nativePredicates('codex', [reply])).toEqual({});
    expect(nativePredicates('codex', [frame('in', { id: 'native-id', method: 'item/commandExecution/requestApproval', params: {} }), reply])).toEqual({ 'approval.request': true, 'approval.declined': true });
    const question = frame('in', { id: 10, method: 'item/tool/requestUserInput', params: {} });
    expect(nativePredicates('codex', [question, frame('out', { id: 11, result: { answers: { x: {} } } })])).not.toHaveProperty('question.answered');
    expect(scenarioNativePredicates('S08')).toEqual(['question.request', 'question.answered']);
    expect(scenarioNativePredicates('S04')).toContain('approval.accepted');
  });
});
