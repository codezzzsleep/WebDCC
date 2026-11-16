import { expect, it } from 'vitest';
import { CodexAdapter, mapItemData } from '../src/adapter.js';

it.each([
  ['inProgress', 'running'], ['completed', 'completed'], ['failed', 'failed'], ['declined', 'failed'],
] as const)('preserves native command and patch status %s as %s', (status, expected) => {
  expect(mapItemData({ type: 'commandExecution', id: 'command', command: 'native command', status })).toMatchObject({ status: expected });
  expect(mapItemData({ type: 'fileChange', id: 'patch', changes: [], status })).toMatchObject({ status: expected });
});

it.each(['commandExecution', 'fileChange'])('keeps exact declined %s source and native identity through the production handler', type => {
  const replay = CodexAdapter.replay('s', 'thread');
  const item = type === 'commandExecution'
    ? { type, id: 'command', command: 'native command', cwd: '/workspace', status: 'declined', aggregatedOutput: 'Native rejected this operation', exitCode: null }
    : { type, id: 'patch', status: 'declined', changes: [{ path: 'guarded.txt', kind: { type: 'add' }, diff: 'Proposed content\n' }] };
  const events = replay.feed({ i: 1, t: 1, dir: 'in', ch: 'rpc', frame: {
    method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item },
  } });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'item.complete', itemKey: item.id, nativeTurnId: 'turn',
    kind: type === 'commandExecution' ? 'command' : 'file.change', data: { status: 'failed' }, native: item });
});
