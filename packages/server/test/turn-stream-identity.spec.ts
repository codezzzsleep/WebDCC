import { expect, it } from 'vitest';
import type { AdapterEvent } from '@webdcc/protocol';
import { FakeAdapter } from '@webdcc/fake-adapter';
import { TurnTracker } from '../src/turn-tracker.js';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

async function streamFixture() {
  const ctx = await createTestApp();
  const adapter = new FakeAdapter({ id: 'codex' });
  let receive!: (id: string, event: AdapterEvent) => void;
  adapter.onEvent = callback => { receive = callback; };
  adapter.send = async () => undefined;
  ctx.manager.registerAdapter(adapter);
  const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
  return { ...ctx, sessionId, emit: (event: AdapterEvent) => receive(sessionId, event) };
}

it('does not bind an unknown native identity onto a turn that already has a different native identity', () => {
  const tracker = new TurnTracker();
  tracker.start('s', 'public', 0);
  tracker.observe('s', { type: 'turn.start', nativeTurnId: 'native-current' }, 1);
  const foreign = { type: 'item.delta' as const, nativeTurnId: 'native-foreign', itemKey: 'shared', field: 'text' as const, append: 'wrong' };
  expect(tracker.assignment('s', foreign, 2).turnId).toBeNull();
  expect(tracker.assignment('s', { type: 'turn.end', nativeTurnId: 'native-current', status: 'completed' }, 3).turnId).toBe('public');
});

it('allows initial native item identity to bind before the turn/start notification arrives', () => {
  const tracker = new TurnTracker();
  tracker.start('s', 'public', 0);
  expect(tracker.observe('s', { type: 'item.start', nativeTurnId: 'native', itemKey: 'first', kind: 'reasoning', data: { text: 'first' } }, 1).turnId).toBe('public');
  expect(tracker.observe('s', { type: 'turn.start', nativeTurnId: 'native' }, 2).turnId).toBe('public');
  expect(tracker.activeTurn('s')).toBe('public');
});

it('keeps old native turns terminal after the anonymous late-frame window expires', () => {
  const tracker = new TurnTracker(10);
  tracker.start('s', 'old', 0);
  tracker.observe('s', { type: 'turn.start', nativeTurnId: 'native-old' }, 1);
  tracker.end('s', 'old', 'completed', 2);
  tracker.start('s', 'current', 20);
  tracker.observe('s', { type: 'turn.start', nativeTurnId: 'native-current' }, 21);
  expect(tracker.observe('s', { type: 'item.start', nativeTurnId: 'native-old', itemKey: 'late', kind: 'reasoning', data: { text: 'stale' } }, 100)).toEqual({ turnId: 'old', late: true });
  expect(tracker.state('old')).toBe('completed');
  expect(tracker.openItems('old')).toEqual([]);
  expect(tracker.observe('s', { type: 'item.complete', nativeTurnId: 'native-old', itemKey: 'late', kind: 'reasoning', data: { text: 'final' } }, 101)).toEqual({ turnId: 'old', late: true });
  expect(tracker.state('old')).toBe('completed');
  expect(tracker.activeTurn('s')).toBe('current');
});

it('allocates a new public turn for an autonomous native start inside the previous completion settle window', async () => {
  const ctx = await streamFixture();
  try {
    const first = await ctx.manager.send(ctx.sessionId, { text: 'First' });
    ctx.emit({ type: 'turn.start', nativeTurnId: 'a' });
    ctx.emit({ type: 'item.complete', nativeTurnId: 'a', itemKey: 'answer-a', kind: 'assistant.message', data: { text: 'A' } });
    ctx.emit({ type: 'turn.end', nativeTurnId: 'a', status: 'completed' });
    ctx.emit({ type: 'turn.start', nativeTurnId: 'b' });
    const starts = ctx.store.allEvents(ctx.sessionId).filter(event => event.kind === 'turn.started');
    expect(starts).toHaveLength(2);
    expect(starts[0]?.turnId).toBe(first.turnId);
    const nextTurn = starts[1]!.turnId;
    expect(nextTurn).not.toBe(first.turnId);
    expect(nextTurn).not.toBeNull();
    expect(ctx.store.allEvents(ctx.sessionId).filter(event => event.kind === 'turn.completed').map(event => event.turnId)).toEqual([first.turnId]);
    ctx.emit({ type: 'item.start', nativeTurnId: 'b', itemKey: 'shared', kind: 'reasoning', data: { text: 'B' } });
    const delta = { type: 'item.delta' as const, nativeTurnId: 'b', itemKey: 'shared', field: 'text' as const, append: ' live' };
    ctx.emit(delta);
    expect(ctx.manager.hotItems(ctx.sessionId)).toMatchObject([{ turnId: nextTurn, itemKey: 'shared', data: { text: 'B live' } }]);
  } finally { await ctx.close(); }
});

it('late completion and late turn/end belong to the old turn without clearing or ending the current turn', async () => {
  const ctx = await streamFixture();
  try {
    const first = await ctx.manager.send(ctx.sessionId, { text: 'First' });
    ctx.emit({ type: 'turn.start', nativeTurnId: 'a' });
    ctx.emit({ type: 'turn.end', nativeTurnId: 'a', status: 'interrupted' });
    const second = await ctx.manager.send(ctx.sessionId, { text: 'Second' });
    ctx.emit({ type: 'turn.start', nativeTurnId: 'b' });
    ctx.emit({ type: 'item.start', nativeTurnId: 'b', itemKey: 'shared', kind: 'reasoning', data: { text: 'B' } });
    ctx.emit({ type: 'item.complete', nativeTurnId: 'a', itemKey: 'shared', kind: 'reasoning', data: { text: 'A final' } });
    expect(ctx.manager.hotItems(ctx.sessionId)).toMatchObject([{ turnId: second.turnId, data: { text: 'B' } }]);
    expect(ctx.store.allEvents(ctx.sessionId).find(event => event.kind === 'reasoning')).toMatchObject({ turnId: first.turnId, late: true, data: { text: 'A final' } });
    ctx.emit({ type: 'turn.end', nativeTurnId: 'a', status: 'interrupted' });
    expect(ctx.store.getSession(ctx.sessionId)?.status).toBe('running');
    expect(ctx.store.allEvents(ctx.sessionId).some(event => event.kind === 'turn.completed' && event.turnId === second.turnId)).toBe(false);
    expect(ctx.manager.hotItems(ctx.sessionId)).toMatchObject([{ turnId: second.turnId, data: { text: 'B' } }]);
    const update = { type: 'item.update' as const, nativeTurnId: 'a', itemKey: 'shared', data: { text: 'stale partial' } };
    ctx.emit(update);
    ctx.emit({ type: 'item.start', nativeTurnId: 'a', itemKey: 'another-stale', kind: 'reasoning', data: { text: 'stale' } });
    expect(ctx.manager.hotItems(ctx.sessionId)).toMatchObject([{ turnId: second.turnId, itemKey: 'shared', data: { text: 'B' } }]);
    expect(ctx.manager.hotItems(ctx.sessionId)).toHaveLength(1);
  } finally { await ctx.close(); }
});

it.each(['assistant.message', 'reasoning'] as const)('duplicate old %s completion retains its raw observation and never deletes a current equal item key', async kind => {
  const ctx = await streamFixture();
  try {
    const first = await ctx.manager.send(ctx.sessionId, { text: 'First' });
    ctx.emit({ type: 'turn.start', nativeTurnId: 'a' });
    const completed: AdapterEvent = { type: 'item.complete', nativeTurnId: 'a', itemKey: 'shared', kind, data: { text: 'A' }, native: kind === 'reasoning' ? { id: 'shared', type: 'reasoning', summary: ['A'] } : { id: 'shared', type: 'agentMessage', text: 'A' } };
    ctx.emit(completed);
    ctx.emit({ type: 'turn.end', nativeTurnId: 'a', status: 'interrupted' });
    const second = await ctx.manager.send(ctx.sessionId, { text: 'Second' });
    ctx.emit({ type: 'turn.start', nativeTurnId: 'b' });
    ctx.emit({ type: 'item.start', nativeTurnId: 'b', itemKey: 'shared', kind: 'reasoning', data: { text: 'B' } });
    ctx.emit(completed);
    expect(ctx.store.allEvents(ctx.sessionId).filter(event => event.kind === kind && event.turnId === first.turnId)).toHaveLength(1);
    expect(ctx.store.nativeEvents.list(ctx.sessionId).some(event => event.disposition === 'duplicate-projection')).toBe(true);
    expect(ctx.manager.hotItems(ctx.sessionId)).toMatchObject([{ turnId: second.turnId, itemKey: 'shared', data: { text: 'B' } }]);
  } finally { await ctx.close(); }
});

it('unknown native frame identity is inspectable but cannot bind or mutate the current public turn', async () => {
  const ctx = await streamFixture();
  try {
    const first = await ctx.manager.send(ctx.sessionId, { text: 'First' });
    ctx.emit({ type: 'turn.start', nativeTurnId: 'a' });
    ctx.emit({ type: 'item.start', nativeTurnId: 'a', itemKey: 'shared', kind: 'reasoning', data: { text: 'A' } });
    const foreign = { type: 'item.update' as const, nativeTurnId: 'unknown', itemKey: 'shared', data: { text: 'foreign' } };
    ctx.emit(foreign);
    ctx.emit({ type: 'item.start', nativeTurnId: 'unknown', itemKey: 'foreign', kind: 'reasoning', data: { text: 'foreign' } });
    ctx.emit({ type: 'item.complete', nativeTurnId: 'unknown', itemKey: 'foreign', kind: 'reasoning', data: { text: 'foreign' } });
    expect(ctx.manager.hotItems(ctx.sessionId)).toMatchObject([{ itemKey: 'shared', turnId: first.turnId, data: { text: 'A' } }]);
    expect(ctx.manager.hotItems(ctx.sessionId)).toHaveLength(1);
    expect(ctx.store.allEvents(ctx.sessionId).some(event => event.turnId === first.turnId && event.kind === 'reasoning')).toBe(false);
    const raw = ctx.store.nativeEvents.list(ctx.sessionId).map(event => ctx.store.nativeEvents.get(event.id));
    expect(raw.some(event => (event?.payload as { nativeTurnId?: string })?.nativeTurnId === 'unknown')).toBe(true);
  } finally { await ctx.close(); }
});
