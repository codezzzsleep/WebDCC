import { expect, it } from 'vitest';
import { CodexAdapter, mapItemData } from '../src/adapter.js';

function fixture() {
  const replay = CodexAdapter.replay('session', 'thread'); let index = 0;
  return (method: string, params: Record<string, unknown>) => replay.feed({ i: ++index, t: index, dir: 'in', ch: 'rpc', frame: { method, params: { threadId: 'thread', ...params } } });
}

it('keeps original native content parts separate from the summary including empty parts and whitespace', () => {
  expect(mapItemData({ type: 'reasoning', id: 'r', summary: ['Summary A', 'Summary B'], content: ['\t原生正文 😀\n', '', 'Body B\n'] })).toMatchObject({ text: 'Summary A\nSummary B', nativeContent: [{ index: 0, text: '\t原生正文 😀\n' }, { index: 1, text: '' }, { index: 2, text: 'Body B\n' }] });
});

it('streams indexed native body parts without overwriting the visible summary and uses authoritative completed content', () => {
  const feed = fixture();
  feed('turn/started', { turn: { id: 'turn' } });
  feed('item/started', { turnId: 'turn', item: { type: 'reasoning', id: 'r', summary: ['Visible summary'], content: [] } });
  const part = (contentIndex: number, delta: string) => feed('item/reasoning/textDelta', { turnId: 'turn', itemId: 'r', contentIndex, delta });
  expect(part(2, 'Third 😀')[0]).toMatchObject({ type: 'item.update', itemKey: 'r', nativeTurnId: 'turn', data: { text: 'Visible summary', nativeContent: [{ index: 2, text: 'Third 😀' }] } });
  expect(part(0, ' First\n')[0]).toMatchObject({ data: { nativeContent: [{ index: 0, text: ' First\n' }, { index: 2, text: 'Third 😀' }] } });
  expect(part(2, ' end')[0]).toMatchObject({ data: { nativeContent: [{ index: 0, text: ' First\n' }, { index: 2, text: 'Third 😀 end' }] } });
  const original = { type: 'reasoning', id: 'r', summary: ['Final summary'], content: ['Final body', '', 'Third final'] };
  expect(feed('item/completed', { turnId: 'turn', item: original })[0]).toMatchObject({ type: 'item.complete', native: original, data: { text: 'Final summary', nativeContent: [{ index: 0, text: 'Final body' }, { index: 1, text: '' }, { index: 2, text: 'Third final' }] } });
  expect(part(0, 'late').every(event => event.type === 'item.complete' && event.kind === 'internal')).toBe(true);
});

it('preserves early body deltas when the item start arrives later and isolates reused ids in different turns', () => {
  const feed = fixture();
  const delta = (turnId: string, text: string) => feed('item/reasoning/textDelta', { turnId, itemId: 'same', contentIndex: 0, delta: text });
  const early = delta('a', 'A');
  expect(early).toMatchObject([{ type: 'item.start', nativeTurnId: 'a' }, { type: 'item.update', data: { text: '', nativeContent: [{ index: 0, text: 'A' }] } }]);
  expect(feed('item/started', { turnId: 'a', item: { type: 'reasoning', id: 'same', summary: [], content: [] } })[0]).toMatchObject({ data: { nativeContent: [{ index: 0, text: 'A' }] } });
  expect(delta('b', 'B').at(-1)).toMatchObject({ nativeTurnId: 'b', data: { nativeContent: [{ index: 0, text: 'B' }] } });
  feed('turn/completed', { turn: { id: 'a', status: 'interrupted' } });
  expect(delta('a', 'late').every(event => event.type === 'item.complete' && event.kind === 'internal')).toBe(true);
  expect(delta('b', ' end').at(-1)).toMatchObject({ data: { nativeContent: [{ index: 0, text: 'B end' }] } });
});

it('records unfinished native body before interruption and keeps missing completed body visibly incomplete', () => {
  const feed = fixture();
  feed('turn/started', { turn: { id: 'turn' } });
  feed('item/reasoning/textDelta', { turnId: 'turn', itemId: 'r', contentIndex: 0, delta: 'Partial native body' });
  expect(feed('turn/completed', { turn: { id: 'turn', status: 'interrupted' } })).toMatchObject([
    { type: 'item.complete', itemKey: 'r', kind: 'reasoning', data: { nativeContent: [{ index: 0, text: 'Partial native body' }], incomplete: true } },
    { type: 'turn.end', status: 'interrupted' },
  ]);
  feed('item/reasoning/textDelta', { turnId: 'next', itemId: 'r', contentIndex: 0, delta: 'Another body' });
  expect(feed('item/completed', { turnId: 'next', item: { type: 'reasoning', id: 'r', summary: ['Final summary'], content: [] } })[0]).toMatchObject({ data: { text: 'Final summary', nativeContent: [{ index: 0, text: 'Another body' }], incomplete: true } });
});

it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1'])('keeps malformed body indices as unknown without changing valid content (%s)', contentIndex => {
  const feed = fixture();
  feed('item/reasoning/textDelta', { turnId: 'turn', itemId: 'r', contentIndex: 0, delta: 'Valid' });
  expect(feed('item/reasoning/textDelta', { turnId: 'turn', itemId: 'r', contentIndex, delta: 'Bad' })[0]).toMatchObject({ type: 'item.complete', kind: 'unknown', native: { contentIndex } });
  expect(feed('item/reasoning/textDelta', { turnId: 'turn', itemId: 'r', contentIndex: 0, delta: ' body' }).at(-1)).toMatchObject({ data: { nativeContent: [{ index: 0, text: 'Valid body' }] } });
});
