import { expect, it } from 'vitest';
import { isValidEventData, type EventData } from '@webdcc/protocol';
import { CodexAdapter, mapItemData } from '../src/adapter.js';
import type { ThreadItem } from '../src/schema/v2/ThreadItem.js';
import type { WebSearchAction } from '../src/schema/v2/WebSearchAction.js';

const actions: WebSearchAction[] = [{ type: 'search', query: null, queries: ['原生检索 🐈', 'same same'] },
  { type: 'openPage', url: 'https://example.com/native' }, { type: 'findInPage', url: null, pattern: '<b>原文</b>' }, { type: 'other' }];
const item = (action: WebSearchAction): ThreadItem => ({ type: 'webSearch', id: 'search:string:🐈', query: '原生检索\r\n', action });

it.each(actions)('preserves a native WebSearch $type start as running with its original item and turn identity', action => {
  const replay = CodexAdapter.replay('session', 'parent');
  replay.feed({ i: 1, t: 1, dir: 'in', ch: 'rpc', frame: { method: 'turn/started', params: { threadId: 'parent', turn: { id: 'turn:string', status: 'inProgress' } } } });
  const original = item(action); Object.freeze(original);
  const event = replay.feed({ i: 2, t: 2, dir: 'in', ch: 'rpc', frame: { method: 'item/started', params: {
    threadId: 'parent', turnId: 'turn:string', startedAtMs: 1, item: original,
  } } }).find(event => event.type === 'item.start');
  expect(event).toMatchObject({ type: 'item.start', kind: 'tool.call', itemKey: original.id, nativeTurnId: 'turn:string',
    data: { name: 'webSearch', input: original, status: 'running', codexItemPhase: 'started' } });
});

it.each(actions)('preserves a native WebSearch $type completed item as completed without inferring search success', action => {
  const replay = CodexAdapter.replay('session', 'parent');
  const original = item(action);
  const event = replay.feed({ i: 1, t: 1, dir: 'in', ch: 'rpc', frame: { method: 'item/completed', params: {
    threadId: 'parent', turnId: 'turn:string', completedAtMs: 2, item: original,
  } } }).find(event => event.type === 'item.complete');
  expect(event).toMatchObject({ type: 'item.complete', kind: 'tool.call', itemKey: original.id, nativeTurnId: 'turn:string',
    data: { name: 'webSearch', input: original, status: 'completed', codexItemPhase: 'completed' }, native: original });
  if (event?.type === 'item.complete') expect(isValidEventData(event.kind, event.data)).toBe(true);
});

it('keeps searches in different native turns separate and old completion does not create or end the current turn', () => {
  const replay = CodexAdapter.replay('session', 'parent'); let i = 0;
  const feed = (method: string, params: Record<string, unknown>) => replay.feed({ i: ++i, t: i, dir: 'in', ch: 'rpc', frame: { method, params } });
  const original = item(actions[0]!);
  feed('turn/started', { threadId: 'parent', turn: { id: 'old-turn', status: 'inProgress' } });
  feed('item/started', { threadId: 'parent', turnId: 'old-turn', item: original, startedAtMs: 1 });
  feed('turn/started', { threadId: 'parent', turn: { id: 'new-turn', status: 'inProgress' } });
  const started = feed('item/started', { threadId: 'parent', turnId: 'new-turn', item: original, startedAtMs: 2 });
  const completed = feed('item/completed', { threadId: 'parent', turnId: 'old-turn', item: original, completedAtMs: 3 });
  expect(started).toContainEqual(expect.objectContaining({ type: 'item.start', nativeTurnId: 'new-turn', data: expect.objectContaining({ status: 'running' }) }));
  expect(completed).toContainEqual(expect.objectContaining({ type: 'item.complete', nativeTurnId: 'old-turn', data: expect.objectContaining({ status: 'completed' }) }));
  expect(completed.some(event => event.type === 'turn.start' || event.type === 'turn.end')).toBe(false);
});

it.each([undefined, null, -1, Number.NaN, '123'])('does not guess history completion from missing or invalid native completedAtMs %s', completedAtMs => {
  const original = { ...item(actions[0]!), completedAtMs };
  expect(mapItemData(original) as EventData['tool.call']).toMatchObject({ input: original, status: 'unknown' });
});

it.each([0, 123])('uses explicit native item completion timestamp %s for history without changing the input', completedAtMs => {
  const original = { ...item(actions[0]!), completedAtMs };
  expect(mapItemData(original) as EventData['tool.call']).toMatchObject({ input: original, status: 'completed' });
});
