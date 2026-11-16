import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../src/events.js';
import { failedFileOperation } from '../src/file-operation.js';
import { reduceTurn } from '../src/turn.js';

function event(seq: number, kind: StoredEvent['kind'], data: unknown, itemKey = `${kind}-${seq}`, native?: unknown): StoredEvent {
  return { sessionId: 's', turnId: 't', seq, kind, itemKey, data: data as never, native, at: new Date(seq).toISOString() };
}

describe('native file-operation outcomes', () => {
  it('failed changes remain inspectable but never become applied edits or diff summaries', () => {
    const failed = event(3, 'file.change', { status: 'failed', changes: [{ path: 'guarded.txt', kind: 'add', added: 1, removed: 0, diffFileId: 'invalid-success-diff' }] });
    const view = reduceTurn([event(1, 'user.message', { text: 'write' }), event(2, 'turn.started', {}), failed, event(4, 'turn.completed', { status: 'completed' })]);
    expect(view.changes).toEqual([]); expect(view.summary.edits).toBe(0);
    expect(view.steps).toContainEqual(failed);
  });

  it('an older SDK message with multiple results attributes failure to the exact tool ID', () => {
    const native = { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'good', content: 'fixture' },
      { type: 'tool_result', tool_use_id: 'missing', content: 'File does not exist', is_error: true },
    ] } };
    const good = event(1, 'file.read', { path: 'fixture.txt' }, 'tool-good', native);
    const missing = event(2, 'file.read', { path: 'missing.txt' }, 'tool-missing', native);
    expect(failedFileOperation(good)).toBe(false); expect(failedFileOperation(missing)).toBe(true);
    expect(reduceTurn([good, missing]).summary.reads).toBe(1);
  });

  it('a successful completed change retains its real summary', () => {
    const view = reduceTurn([event(1, 'file.change', { status: 'completed', changes: [{ path: 'result.txt', kind: 'add', added: 1, removed: 0 }] })]);
    expect(view.changes).toHaveLength(1); expect(view.summary.edits).toBe(1);
  });
});
