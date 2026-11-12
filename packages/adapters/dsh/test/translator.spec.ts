import { describe, expect, it } from 'vitest';
import { DshTranslator } from '../src/translator.js';

describe('DSH translator', () => {
  it('把 subagent/catalog 映射成可见的子 Agent 工具步骤', () => {
    const events = new DshTranslator().feed({
      i: 1,
      t: 0,
      dir: 'in',
      ch: 'mux:session/follow',
      frame: {
        value: {
          type: 'event',
          event: {
            type: 'subagent/catalog',
            seq: 1,
            data: { childId: 'child-1', name: 'reviewer', mode: 'continuable', label: '只读审查' },
          },
        },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'item.complete',
      kind: 'tool.call',
      itemKey: 'subagent-child-1',
      data: { name: 'subagent', label: '只读审查', status: 'running', input: { childId: 'child-1', name: 'reviewer' } },
    });
  });
});
