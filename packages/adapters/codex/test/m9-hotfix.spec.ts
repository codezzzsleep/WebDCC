import { describe, expect, it } from 'vitest';
import { mapItemData } from '../src/adapter.js';

describe('M9 Codex 热修', () => {
  it('按官方 MessagePhase 映射最终回答，并保留原生 phase', () => {
    expect(mapItemData({ type: 'agentMessage', id: 'final', text: 'done', phase: 'final_answer' })).toEqual({
      text: 'done',
      phase: 'final',
      nativePhase: 'final_answer',
    });
    expect(mapItemData({ type: 'agentMessage', id: 'partial', text: 'partial', phase: 'partial_answer' })).toMatchObject({
      phase: 'final',
      nativePhase: 'partial_answer',
    });
    expect(mapItemData({ type: 'agentMessage', id: 'progress', text: 'working', phase: 'commentary' })).toEqual({
      text: 'working',
      phase: 'interim',
      nativePhase: 'commentary',
    });
  });

  it('加密思考没有文本时仍保留可关闭的数据', () => {
    expect(mapItemData({ type: 'reasoning', id: 'r1', summary: [] })).toEqual({ text: '' });
  });
});
