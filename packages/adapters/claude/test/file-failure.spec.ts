import { expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/adapter.js';

it.each(['Read', 'Write'])('official SDK %s errors retain the failed operation and native result', name => {
  const replay = ClaudeAdapter.replay();
  const push = (i: number, frame: unknown) => replay.feed({ i, t: i, dir: 'in', ch: 'sdk', frame });
  push(1, { type: 'assistant', uuid: 'assistant', session_id: 'native', parent_tool_use_id: null,
    message: { id: 'message', content: [{ type: 'tool_use', id: 'operation', name, input: { file_path: 'missing.txt', content: 'not written' } }] } });
  const native = { type: 'user', uuid: 'result', session_id: 'native', parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: 'operation', is_error: true, content: 'File does not exist' }] } };
  const events = push(2, native);
  expect(events).toContainEqual(expect.objectContaining({ type: 'item.complete', itemKey: 'tool-operation', kind: name === 'Write' ? 'file.change' : 'file.read',
    data: expect.objectContaining({ status: 'failed', error: 'File does not exist' }), native,
  }));
  if (name === 'Write') expect(events.find(event => event.type === 'item.complete' && event.kind === 'file.change')).toMatchObject({ data: { changes: [], path: 'missing.txt' } });
});
