import { expect, it } from 'vitest';
import { DshSystemMessages } from '../src/system-messages.js';
const message = (content: string[], sections: unknown[], flags = {}) => ({ message: { source: { kind: 'system-prompt', sections, ...flags }, content: content.map(text => ({ type: 'text', text })) } });

it('folds native replacements, withdrawals and retirements while excluding attributed notices', () => {
  const context = new DshSystemMessages('sections');
  context.accept('system/message', message(['base', 'persona'], [{ name: 'base', state: 'active', order: 0, contentIndex: 0 }, { name: 'persona', state: 'active', order: 1, contentIndex: 1 }], { reset: true, complete: true }));
  const update = message(['replacement notice', 'new persona', 'retirement notice'], [{ name: 'persona', state: 'active', order: 2, contentIndex: 1, noticeIndex: [0] }, { name: 'base', state: 'retired', noticeIndex: [2] }]);
  expect(context.accept('system/message', update)).toEqual({ format: 'sections', complete: false, needsRebuild: false, sections: [{ name: 'persona', order: 2, text: 'new persona' }] });
  expect(update.message.content.map(part => part.text)).toEqual(['replacement notice', 'new persona', 'retirement notice']);
  expect(context.accept('system/message', message([''], [{ name: 'persona', state: 'active', order: 2, contentIndex: 0 }])).sections).toEqual([{ name: 'persona', order: 2, text: '' }]);
});

it('keeps compaction and legacy records incomplete until a native reset or authoritative baseline', () => {
  const context = new DshSystemMessages('sections');
  expect(context.accept('compaction/summary', {}).needsRebuild).toBe(true);
  expect(context.accept('system/message', message(['delta'], [{ name: 'delta', state: 'active', order: 0, contentIndex: 0 }])).needsRebuild).toBe(true);
  expect(context.accept('system/message', { message: { source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'legacy' }] } })).toMatchObject({ sections: [], complete: false, needsRebuild: true });
  context.baseline({ sections: [{ name: 'native', order: 1, text: 'restored' }], complete: true, needsRebuild: false });
  expect(context.snapshot()).toMatchObject({ sections: [{ name: 'native', order: 1, text: 'restored' }], complete: true, needsRebuild: false });
  expect(context.accept('system/message', message([], [], { reset: true, complete: true }))).toEqual({ format: 'sections', sections: [], complete: true, needsRebuild: false });
});

it('does not publish guessed or partially folded sections from conflicting indexes', () => {
  const context = new DshSystemMessages('sections');
  expect(context.accept('system/message', message(['one'], [{ name: 'a', state: 'active', order: 0, contentIndex: 0 }, { name: 'b', state: 'active', order: 1, contentIndex: 0 }], { reset: true }))).toMatchObject({ sections: [], complete: false, needsRebuild: true });
});
