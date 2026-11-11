import { describe, expect, it } from 'vitest';
import { isValidEventData } from '../src/validate.js';
import { toolKind as dshToolKind } from '../../adapters/dsh/src/adapter.js';

describe('事件数据校验（F2）', () => {
  it('plan 必须是 {items:[{text,status}]}', () => {
    expect(isValidEventData('plan', { items: [{ text: 'a', status: 'pending' }] })).toBe(true);
    expect(isValidEventData('plan', { name: 'todo_write', input: {}, status: 'running' })).toBe(false);
    expect(isValidEventData('plan', { items: [{ nope: 1 }] })).toBe(false);
  });

  it('常见 kind 的必填字段', () => {
    expect(isValidEventData('command', { command: 'ls', status: 'running' })).toBe(true);
    expect(isValidEventData('command', { command: 'ls' })).toBe(false);
    expect(isValidEventData('assistant.message', { text: 'hi' })).toBe(true);
    expect(isValidEventData('assistant.message', {})).toBe(false);
    expect(isValidEventData('approval.request', { approvalId: 'a', title: 't', options: [] })).toBe(true);
    expect(isValidEventData('approval.request', { approvalId: 'a' })).toBe(false);
    expect(isValidEventData('question', { questionId: 'q', prompt: 'p' })).toBe(true);
    expect(isValidEventData('turn.completed', { status: 'completed', durationMs: 1 })).toBe(true);
  });

  it('DSH 的 todo_write 工具调用按 tool.call 处理，不再冒充 plan', () => {
    expect(dshToolKind('todo_write')).toBe('tool.call');
  });
});
