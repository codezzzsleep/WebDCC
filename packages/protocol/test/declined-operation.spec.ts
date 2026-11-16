import { expect, it } from 'vitest';
import { reduceTurn } from '../src/turn.js';
import { failedFileOperation } from '../src/file-operation.js';
import type { StoredEvent } from '../src/events.js';

function event(kind: 'command' | 'file.change', native: unknown): StoredEvent {
  return { sessionId: 's', seq: 1, at: new Date(0).toISOString(), turnId: 'turn', itemKey: 'operation', kind,
    data: kind === 'command' ? { command: 'Native denied command', status: 'completed' }
      : { status: 'completed', changes: [{ path: 'guarded.txt', kind: 'add', added: 1, removed: 0, diffFileId: 'proposed-only' }] }, native };
}

it('does not count a historical native-declined command as executed even when its old projection says completed', () => {
  const command = event('command', { type: 'commandExecution', status: 'declined' });
  const view = reduceTurn([command]);
  expect(view.summary.commands).toBe(0);
  expect(view.steps).toEqual([command]);
});

it('does not expose proposed patch changes or a successful edit for native-declined legacy rows', () => {
  const patch = event('file.change', { type: 'fileChange', status: 'declined' });
  expect(failedFileOperation(patch)).toBe(true);
  const view = reduceTurn([patch]);
  expect(view.summary.edits).toBe(0); expect(view.changes).toEqual([]);
  expect(view.steps).toEqual([patch]);
});

it('keeps real failed/completed command attempts and other Agents original file projections unchanged', () => {
  const nativeCommand = event('command', { type: 'commandExecution', status: 'failed' });
  expect(reduceTurn([nativeCommand]).summary.commands).toBe(1);
  const other = event('file.change', { type: 'tool/result', status: 'declined', data: { message: { isError: false } } });
  expect(failedFileOperation(other)).toBe(false);
  expect(reduceTurn([other]).summary.edits).toBe(1);
});
