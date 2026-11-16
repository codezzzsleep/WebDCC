import { expect, it } from 'vitest';
import type { AdapterEvent, EventData } from '@webdcc/protocol';
import { DshAdapter } from '../src/adapter.js';
import { dshGoalFixture } from './goal-fixture.js';

function goal(events: AdapterEvent[]) {
  return events.find(event => event.type === 'item.complete' && event.kind === 'goal') as Extract<AdapterEvent, { type: 'item.complete' }> | undefined;
}
function frame(event: unknown, seq: number) {
  return { i: seq + 1, t: seq, dir: 'in' as const, ch: 'mux:session/follow', frame: { type: 'item', value: { type: 'event', event } } };
}
function projection(value: unknown, seq: number, key = 'goal') {
  return { i: seq + 1, t: seq, dir: 'in' as const, ch: 'mux:session/observeProjections', frame: { type: 'item', value: {
    type: 'projection', seq, changes: [{ key, val: value }],
  } } };
}

it.each([['create', 'active', 1, 0], ['pause', 'paused', 3, 2], ['block', 'blocked', 5, 2], ['complete', 'completed', 6, 2]] as const)(
  'maps native %s without changing its identity, revision or round units', (operation, status, revision, roundsStarted) => {
    const replay = DshAdapter.replay('s', 'native');
    for (const native of dshGoalFixture().events) {
      const event = goal(replay.feed(frame(native, native.seq)));
      if (native.type !== 'goal/change' || !('operation' in native.data) || native.data.operation !== operation || !('goal' in native.data)) continue;
      expect(event).toMatchObject({ scope: 'session', nativeSeq: native.seq, data: { objective: native.data.goal.objective, status,
        goalId: 'native-goal', nativeRevision: revision, nativeStatus: native.data.goal.phase, roundsStarted, maxGoalRounds: 10 } });
      expect(event?.native).toEqual(native);
      expect((event?.data as EventData['goal'] | undefined)?.tokenBudget).toBeUndefined();
      return;
    }
    throw new Error(`missing fixture operation ${operation}`);
  });

it('the next-revision clear tombstone retains its exact identity', () => {
  const replay = DshAdapter.replay('s', 'native');
  const events = dshGoalFixture().events.flatMap(native => replay.feed(frame(native, native.seq)));
  const event = events.findLast(event => event.type === 'item.complete' && event.kind === 'goal');
  expect(event?.data).toMatchObject({ status: 'cleared', goalId: 'native-goal', nativeRevision: 7, objective: '' });
});

it('authoritative projections restore a paused goal and its rounds, then suppress older history', () => {
  const replay = DshAdapter.replay('s', 'native');
  const fixture = dshGoalFixture();
  expect(goal(replay.feed(projection(fixture.pausedProjection, 20)))?.data).toMatchObject({
    goalId: 'native-goal', status: 'paused', nativeRevision: 3, roundsStarted: 2,
  });
  for (const native of fixture.events.slice(0, 9)) expect(goal(replay.feed(frame(native, native.seq)))).toBeUndefined();
  expect(goal(replay.feed(projection(null, 21)))?.data).toMatchObject({ objective: '', status: 'cleared' });
});

it('missing or malformed goal projection is retained without claiming a successful clear or active goal', () => {
  const replay = DshAdapter.replay('s', 'native');
  for (const val of [undefined, { goal: { objective: 'invalid missing identity', phase: 'active' } }]) {
    const events = replay.feed(projection(val, 1));
    expect(goal(events)).toBeUndefined();
    expect(events.some(event => event.type === 'item.complete' && event.kind === 'unknown')).toBe(true);
  }
});

it('invalid native phase explanations and timestamps stay unknown with their original projection', () => {
  const fixture = dshGoalFixture();
  const valid = fixture.pausedProjection;
  const invalid = [
    { ...valid, goal: { ...valid.goal, phase: 'blocked' } },
    { ...valid, goal: { ...fixture.block.goal, blockedReason: { code: 'Invalid Code', message: 'explanation' } } },
    { ...valid, goal: { ...valid.goal, blockedReason: fixture.block.goal.blockedReason } },
    { ...valid, createdAt: -1 },
    { ...valid, goal: { ...valid.goal, objective: ' unnormalized objective ' } },
  ];
  for (const val of invalid) {
    const native = projection(val, 1);
    const events = DshAdapter.replay('s', 'native').feed(native);
    expect(goal(events)).toBeUndefined();
    expect(events.find(event => event.type === 'item.complete' && event.kind === 'unknown')?.native).toEqual(native.frame.value);
  }
});

it('an unrelated partial projection does not attest an old goal value through its newer sequence', () => {
  const replay = DshAdapter.replay('s', 'native');
  const fixture = dshGoalFixture();
  replay.feed(projection(fixture.activeProjection, 6));
  replay.feed(projection({ currentValue: 'read-only' }, 20, 'permissions'));
  const pause = fixture.events.find(event => event.type === 'goal/change' && 'operation' in event.data && event.data.operation === 'pause')!;
  expect(goal(replay.feed(frame(pause, pause.seq)))?.data).toMatchObject({ status: 'paused', nativeRevision: 3 });
});
