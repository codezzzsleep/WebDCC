import { expect, it } from 'vitest';
import type { AdapterEvent, TraceFrame } from '@webdcc/protocol';
import { CodexAdapter } from '../src/adapter.js';
import { CodexTranslator } from '../src/translator.js';
import type { ThreadItem } from '../src/schema/v2/ThreadItem.js';

function fixture() {
  const replay = CodexAdapter.replay('session', 'thread');
  let sequence = 0;
  const frames: TraceFrame[] = [];
  const feed = (method: string, params: Record<string, unknown>): AdapterEvent[] => {
    const frame: TraceFrame = { i: ++sequence, t: sequence, dir: 'in', ch: 'rpc',
      frame: { method, params: { threadId: 'thread', ...params } } };
    frames.push(frame);
    return replay.feed(frame);
  };
  return { feed, frames };
}

function expectOnlyRaw(events: AdapterEvent[]): void {
  expect(events.every(event => event.type === 'item.complete' && event.kind === 'internal')).toBe(true);
}

it('streams one native Markdown plan and replaces its draft with the authoritative completed text', () => {
  const { feed, frames } = fixture();
  const item: ThreadItem = { type: 'plan', id: 'plan', text: '' };
  const started = feed('item/started', { turnId: 'turn', item });
  expect(started).toEqual([{ type: 'item.start', itemKey: 'plan', kind: 'plan', nativeTurnId: 'turn',
    data: { items: [], text: '', incomplete: true }, native: item }]);
  const first = feed('item/plan/delta', { turnId: 'turn', itemId: 'plan', delta: '  # 临时计划\n' });
  const second = feed('item/plan/delta', { turnId: 'turn', itemId: 'plan', delta: '- draft 😀\n' });
  expect(first).toEqual([{ type: 'item.delta', itemKey: 'plan', nativeTurnId: 'turn', field: 'text', append: '  # 临时计划\n' }]);
  expect(second).toEqual([{ type: 'item.delta', itemKey: 'plan', nativeTurnId: 'turn', field: 'text', append: '- draft 😀\n' }]);
  const final: ThreadItem = { type: 'plan', id: 'plan', text: '\t# Final 原生计划\n\n- [ ] **Different final** 😀\n' };
  const completed = feed('item/completed', { turnId: 'turn', item: final });
  expect(completed).toEqual([{ type: 'item.complete', itemKey: 'plan', kind: 'plan', nativeTurnId: 'turn',
    data: { items: [], text: final.text, incomplete: false }, native: final }]);
  const translator = new CodexTranslator();
  expect(frames.flatMap(frame => translator.feed(frame))).toEqual([...started, ...first, ...second, ...completed]);
});

it('accepts a final native plan without streaming and retains an explicitly empty final text', () => {
  const { feed } = fixture();
  for (const text of ['# Complete\n\nOriginal text\n', '']) {
    const item: ThreadItem = { type: 'plan', id: text === '' ? 'empty' : 'complete', text };
    expect(feed('item/completed', { turnId: 'turn', item })).toEqual([
      { type: 'item.complete', itemKey: item.id, kind: 'plan', nativeTurnId: 'turn',
        data: { items: [], text, incomplete: false }, native: item },
    ]);
  }
});

it('starts on a native delta and does not discard its text when item/started arrives later', () => {
  const { feed } = fixture();
  const delta = feed('item/plan/delta', { turnId: 'turn', itemId: 'plan', delta: 'First\n' });
  expect(delta).toEqual([
    { type: 'item.start', itemKey: 'plan', kind: 'plan', nativeTurnId: 'turn', data: { items: [], text: '', incomplete: true } },
    { type: 'item.delta', itemKey: 'plan', nativeTurnId: 'turn', field: 'text', append: 'First\n' },
  ]);
  expectOnlyRaw(feed('item/started', { turnId: 'turn', item: { type: 'plan', id: 'plan', text: '' } }));
  expect(feed('item/plan/delta', { turnId: 'turn', itemId: 'plan', delta: 'Second\n' })).toHaveLength(1);
});

it('does not reopen or duplicate a completed plan after late deltas, starts or repeated completion', () => {
  const { feed } = fixture();
  const item: ThreadItem = { type: 'plan', id: 'plan', text: 'Final' };
  feed('item/completed', { turnId: 'turn', item });
  expectOnlyRaw(feed('item/plan/delta', { turnId: 'turn', itemId: 'plan', delta: ' stale' }));
  expectOnlyRaw(feed('item/started', { turnId: 'turn', item: { ...item, text: '' } }));
  expectOnlyRaw(feed('item/completed', { turnId: 'turn', item }));
});

it('isolates identical native item IDs across turns and preserves interrupted drafts without marking them complete', () => {
  const { feed } = fixture();
  feed('turn/started', { turn: { id: 'a' } });
  feed('item/plan/delta', { turnId: 'a', itemId: 'same', delta: 'A draft\n' });
  feed('turn/started', { turn: { id: 'b' } });
  feed('item/plan/delta', { turnId: 'b', itemId: 'same', delta: 'B draft\n' });
  const interrupted = feed('turn/completed', { turn: { id: 'a', status: 'interrupted' } });
  expect(interrupted[0]).toMatchObject({ type: 'item.complete', itemKey: 'same', kind: 'plan', nativeTurnId: 'a',
    data: { items: [], text: 'A draft\n', incomplete: true } });
  expect(interrupted.at(-1)).toMatchObject({ type: 'turn.end', nativeTurnId: 'a', status: 'interrupted' });
  expectOnlyRaw(feed('item/plan/delta', { turnId: 'a', itemId: 'same', delta: ' stale' }));
  expect(feed('item/plan/delta', { turnId: 'b', itemId: 'same', delta: ' continues' })).toHaveLength(1);
  const final: ThreadItem = { type: 'plan', id: 'same', text: 'A real final arriving late' };
  expect(feed('item/completed', { turnId: 'a', item: final })[0]).toMatchObject({ nativeTurnId: 'a',
    data: { text: final.text, incomplete: false } });
});

it('keeps foreign native plan events out of the parent plan stream', () => {
  const { feed } = fixture();
  const events = [
    ...feed('item/started', { threadId: 'child', turnId: 'turn', item: { type: 'plan', id: 'plan', text: '' } }),
    ...feed('item/plan/delta', { threadId: 'child', turnId: 'turn', itemId: 'plan', delta: 'Child plan' }),
    ...feed('item/completed', { threadId: 'child', turnId: 'turn', item: { type: 'plan', id: 'plan', text: 'Child final' } }),
  ];
  expect(events.every(event => event.type === 'item.complete' && event.kind === 'internal')).toBe(true);
});
