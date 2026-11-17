// Controlled protocol peer for the unmodified SDK, never an official CLI/model.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import process from 'node:process';
const [logPath, runId, mode] = process.argv.slice(2);
const requestId = `dialog-${runId}`;
const write = frame => {
  appendFileSync(logPath, JSON.stringify({ direction: 'cli-to-sdk', frame }) + '\n');
  process.stdout.write(JSON.stringify(frame) + '\n');
};
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line); appendFileSync(logPath, JSON.stringify({ direction: 'sdk-to-cli', frame }) + '\n');
  if (frame.type === 'control_request') {
    write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
      response: { claude_code_version: '2.1.322', commands: [], models: [], agents: [], account: {}, mcp_servers: [] } } });
    if (frame.request.subtype === 'initialize') write({ type: 'control_request', request_id: requestId,
      request: { subtype: 'request_user_dialog', dialog_kind: mode === 'unknown' ? 'fixture-undeclared-dialog' : 'fixture-declared-dialog',
        payload: { fixture: true }, tool_use_id: `tool-${runId}` } });
  }
});
