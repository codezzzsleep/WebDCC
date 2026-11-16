/** Controlled lifecycle, checked offline against the upstream 0.2.2-rc.1 strict
 * goal fold. This is a fixture, not a captured Host or provider trajectory. */
export function dshGoalFixture() {
  const snapshot = (operation: string, phase: string, revision: number, roundsStarted: number,
    objective = 'Original native objective') => ({
    kind: 'goal/change', version: 1, operation,
    goal: { id: 'native-goal', revision, objective, phase, maxGoalRounds: 10,
      ...(phase === 'blocked' ? { blockedReason: { code: 'human-action-needed', message: 'Native block explanation' } } : {}) },
    roundsStarted, createdAt: 100, updatedAt: 100 + revision - 1,
  });
  const create = snapshot('create', 'active', 1, 0);
  const edit = snapshot('edit', 'active', 2, 2, 'Edited native objective');
  const pause = snapshot('pause', 'paused', 3, 2, edit.goal.objective);
  const resume = snapshot('resume', 'active', 4, 2, edit.goal.objective);
  const block = snapshot('block', 'blocked', 5, 2, edit.goal.objective);
  const complete = snapshot('complete', 'complete', 6, 2, edit.goal.objective);
  const clear = { kind: 'goal/change', version: 1, operation: 'clear',
    cleared: { id: 'native-goal', revision: 7 }, clearedAt: 106 };
  const round = (number: number) => [
    { type: 'turn/start', data: { turn: number } },
    { type: 'user/message', surfaceOp: 'append', data: {
      id: `goal-round-${number}`, role: 'user', content: [{ type: 'text', text: `Controlled round ${number}` }],
      source: { kind: 'goal', goalId: 'native-goal', revision: 1, round: number },
    } },
    { type: 'turn/end', data: { turn: number, reason: { kind: 'completed' } } },
  ];
  const events = [
    { type: 'goal/change', data: create }, ...round(1), ...round(2),
    ...[edit, pause, resume, block, complete, clear].map(data => ({ type: 'goal/change', data })),
  ].map((event, seq) => ({ ...event, seq, time: 100 + seq }));
  const projection = (change: typeof create) => ({ goal: change.goal, roundsStarted: change.roundsStarted,
    createdAt: change.createdAt, updatedAt: change.updatedAt });
  return { events, create, edit, pause, resume, block, complete, clear,
    activeProjection: { ...projection(create), roundsStarted: 2 }, pausedProjection: projection(pause) };
}
