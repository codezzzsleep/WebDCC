// A controlled transport peer for the actual SDK. Never an official CLI/model.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
const [logPath, runId] = process.argv.slice(2);
const write = frame => { appendFileSync(logPath, JSON.stringify({ direction: 'peer-to-sdk', frame }) + '\n'); process.stdout.write(JSON.stringify(frame) + '\n'); };
const message = (name, block, parent, aborted) => ({ type: 'assistant', uuid: randomUUID(), session_id: runId, parent_tool_use_id: parent,
  ...(aborted ? { aborted: true } : {}), message: { id: `msg-${runId}-${name}`, role: 'assistant', model: 'controlled-peer', content: [block],
    stop_reason: aborted ? null : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line); appendFileSync(logPath, JSON.stringify({ direction: 'sdk-to-peer', frame }) + '\n');
  if (frame.type !== 'control_request') return;
  write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
    response: { claude_code_version: '2.1.322', commands: [], models: [], agents: [], account: {}, mcp_servers: [] } } });
  if (frame.request.subtype !== 'initialize') return;
  write({ type: 'system', subtype: 'init', uuid: randomUUID(), session_id: runId, model: 'controlled-peer', tools: [], slash_commands: [], permissionMode: 'default' });
  write({ type: 'system', subtype: 'task_started', uuid: randomUUID(), session_id: runId, task_id: 'child', run_id: '001',
    tool_use_id: 'spawn', description: 'Controlled child', task_type: 'local_agent', is_backgrounded: true });
  write(message('main', { type: 'text', text: 'ACTUAL SDK PARTIAL' }, null, true));
  write(message('thinking', { type: 'thinking', thinking: 'ACTUAL SDK PARTIAL THOUGHT', signature: 'controlled-signature' }, 'spawn', true));
  write(message('tool', { type: 'tool_use', id: 'partial-tool', name: 'Read', input: { file_path: '/not-executed' } }, 'spawn', true));
  write(message('normal', { type: 'text', text: 'ACTUAL SDK COMPLETE' }, null, false));
});
