import type { AdapterEvent, TraceFrame } from '@webdcc/protocol';
import { expect, it } from 'vitest';
import { CodexAdapter } from '../src/adapter.js';
import type { ThreadItem } from '../src/schema/v2/ThreadItem.js';

function nativeReplay() {
  const replay = CodexAdapter.replay('session', 'thread');
  let sequence = 0;
  return (method: string, params: Record<string, unknown>) => replay.feed({
    i: ++sequence, t: sequence, dir: 'in', ch: 'rpc', frame: { method, params: { threadId: 'thread', ...params } },
  } satisfies TraceFrame);
}

function updateText(events: AdapterEvent[]) {
  const update = events.find(event => event.type === 'item.update');
  return update?.type === 'item.update' ? (update.data as { text: string }).text : undefined;
}

it.each([false, true])('retains native reasoning summary strings on completion (streamed: %s)', (streamed) => {
  const feed = nativeReplay();
  const item: ThreadItem = {
    type: 'reasoning', id: 'reasoning-item', summary: ['先检查输入。', 'Then verify the result.'],
    content: ['Private body is separate from the visible summary.'],
  };
  feed('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
  if (streamed) {
    feed('item/started', { threadId: 'thread', turnId: 'turn', item: { ...item, summary: [], content: [] } });
    feed('item/reasoning/summaryTextDelta', { threadId: 'thread', turnId: 'turn', itemId: item.id, summaryIndex: 0, delta: '先检查' });
    feed('item/reasoning/summaryPartAdded', { threadId: 'thread', turnId: 'turn', itemId: item.id, summaryIndex: 1 });
    feed('item/reasoning/summaryTextDelta', { threadId: 'thread', turnId: 'turn', itemId: item.id, summaryIndex: 1, delta: 'Then verify' });
  }
  const completed = feed('item/completed', { threadId: 'thread', turnId: 'turn', item });
  expect(completed).toEqual([{
    type: 'item.complete', itemKey: item.id, kind: 'reasoning',
    data: { text: '先检查输入。\nThen verify the result.' },
    nativeTurnId: 'turn', native: item,
  }]);
});

it('keeps native summary parts ordered during interleaved streaming, including empty parts', () => {
  const feed = nativeReplay();
  const params = { turnId: 'turn', itemId: 'reasoning-item' };
  feed('turn/started', { turn: { id: 'turn' } });
  feed('item/started', { turnId: 'turn', item: { type: 'reasoning', id: params.itemId, summary: [], content: [] } });
  const delta = (summaryIndex: number, text: string) => updateText(feed('item/reasoning/summaryTextDelta', { ...params, summaryIndex, delta: text }));
  expect(delta(0, 'Alpha')).toBe('Alpha');
  expect(updateText(feed('item/reasoning/summaryPartAdded', { ...params, summaryIndex: 1 }))).toBe('Alpha\n');
  expect(delta(1, 'Beta')).toBe('Alpha\nBeta');
  expect(delta(0, ' done')).toBe('Alpha done\nBeta');
  expect(delta(1, ' done')).toBe('Alpha done\nBeta done');
  expect(updateText(feed('item/reasoning/summaryPartAdded', { ...params, summaryIndex: 2 }))).toBe('Alpha done\nBeta done\n');
});

it('preserves deltas when native part-added and item-start notifications arrive later', () => {
  const feed = nativeReplay();
  const params = { turnId: 'turn', itemId: 'reasoning-item' };
  const first = feed('item/reasoning/summaryTextDelta', { ...params, summaryIndex: 1, delta: 'Beta' });
  expect(first).toEqual([
    { type: 'item.start', itemKey: params.itemId, kind: 'reasoning', data: { text: '' }, nativeTurnId: 'turn' },
    { type: 'item.update', itemKey: params.itemId, nativeTurnId: 'turn', data: { text: 'Beta' } },
  ]);
  expect(updateText(feed('item/reasoning/summaryPartAdded', { ...params, summaryIndex: 1 }))).toBe('Beta');
  expect(feed('item/started', { turnId: 'turn', item: { type: 'reasoning', id: params.itemId, summary: [], content: [] } })[0]).toMatchObject({
    type: 'item.start', data: { text: 'Beta' }, nativeTurnId: 'turn',
  });
  expect(updateText(feed('item/reasoning/summaryTextDelta', { ...params, summaryIndex: 0, delta: 'Alpha' }))).toBe('Alpha\nBeta');
});

it('uses the authoritative completed summary and prevents late deltas from reopening the item', () => {
  const feed = nativeReplay();
  const params = { turnId: 'turn', itemId: 'reasoning-item' };
  feed('item/reasoning/summaryTextDelta', { ...params, summaryIndex: 0, delta: 'Partial' });
  const complete = feed('item/completed', { turnId: 'turn', item: { type: 'reasoning', id: params.itemId,
    summary: ['Final', '', 'Third'], content: ['Private content'] } });
  expect(complete[0]).toMatchObject({ type: 'item.complete', kind: 'reasoning', data: { text: 'Final\n\nThird' } });
  const late = [
    ...feed('item/reasoning/summaryTextDelta', { ...params, summaryIndex: 0, delta: ' stale' }),
    ...feed('item/reasoning/summaryPartAdded', { ...params, summaryIndex: 1 }),
    ...feed('item/started', { turnId: 'turn', item: { type: 'reasoning', id: params.itemId, summary: [], content: [] } }),
  ];
  expect(late.every(event => event.type === 'item.complete' && event.kind === 'internal')).toBe(true);
});

it('isolates equal item ids in different native turns and clears only the completed turn', () => {
  const feed = nativeReplay();
  const delta = (turnId: string, text: string) => feed('item/reasoning/summaryTextDelta', {
    turnId, itemId: 'shared', summaryIndex: 0, delta: text,
  });
  feed('turn/started', { turn: { id: 'a' } });
  expect(updateText(delta('a', 'Alpha'))).toBe('Alpha');
  const second = delta('b', 'Beta');
  expect(second[0]).toMatchObject({ type: 'item.start', nativeTurnId: 'b' });
  expect(updateText(second)).toBe('Beta');
  feed('turn/completed', { turn: { id: 'a', status: 'completed' } });
  expect(updateText(delta('b', ' done'))).toBe('Beta done');
  expect(delta('a', ' stale').every(event => event.type === 'item.complete' && event.kind === 'internal')).toBe(true);
  feed('item/completed', { turnId: 'b', item: { type: 'reasoning', id: 'shared', summary: ['Beta done'], content: [] } });
  expect(updateText(delta('c', 'Gamma'))).toBe('Gamma');
});

it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1'])('records malformed native summary indices without changing visible text (%s)', (summaryIndex) => {
  const feed = nativeReplay();
  const params = { turnId: 'turn', itemId: 'reasoning-item' };
  feed('item/reasoning/summaryTextDelta', { ...params, summaryIndex: 0, delta: 'Valid' });
  for (const method of ['item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded']) {
    expect(feed(method, { ...params, summaryIndex, delta: 'Bad' })[0]).toMatchObject({
      type: 'item.complete', kind: 'unknown', native: { summaryIndex }, nativeTurnId: 'turn',
    });
  }
  expect(updateText(feed('item/reasoning/summaryTextDelta', { ...params, summaryIndex: 0, delta: ' text' }))).toBe('Valid text');
});
