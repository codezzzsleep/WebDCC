import { expect, it } from 'vitest';
import { DshAdapter } from '../src/adapter.js';

it.each(['read', 'write'])('the captured native %s failure preserves cause without successful filesystem claims', name => {
  const replay = DshAdapter.replay();
  const feed = (seq: number, type: string, data: Record<string, unknown>) => replay.feed({ i: seq, t: seq, dir: 'in', ch: 'mux:session/follow', frame: {
    value: { type: 'event', event: { seq, time: seq, type, data } },
  } });
  feed(1, 'tool/call', { turn: 1, step: 1, callId: 'operation', name, arguments: JSON.stringify({ file_path: 'guarded.txt', content: 'not written' }) });
  const events = feed(2, 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'operation', isError: true, content: [{ type: 'text', text: 'Error: FS_SANDBOX_DENIED' }] } });
  expect(events).toContainEqual(expect.objectContaining({ type: 'item.complete', itemKey: 'tool-operation', kind: name === 'write' ? 'file.change' : 'file.read',
    data: expect.objectContaining({ status: 'failed', error: 'Error: FS_SANDBOX_DENIED' }),
  }));
  if (name === 'write') expect(events.find(event => event.type === 'item.complete' && event.kind === 'file.change')).toMatchObject({ data: { changes: [], path: 'guarded.txt' } });
});
