import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CodexAdapter } from '../src/adapter.js';

it('NP-04 Codex observes full paginated turns in a real RPC child without resume/start, and rejects looping cursors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-codex-observe-'));
  const command = join(directory, 'codex-fixture'); const record = join(directory, 'requests.jsonl');
  await writeFile(command, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.167.0\\n'); process.exit(0); }
const thread = { id: 'thread', sessionId: 'thread', cliVersion: '0.167.0', createdAt: 1, updatedAt: 1, cwd: ${JSON.stringify(directory)}, ephemeral: false, modelProvider: 'fixture', preview: '', projectId: null, source: 'appServer', status: { type: 'notLoaded' }, turns: [] };
createInterface({ input: process.stdin }).on('line', line => {
 const frame = JSON.parse(line); appendFileSync(process.env.WDCC_OBSERVE_RECORD, line + '\\n');
 if (frame.id === undefined) return;
 let result;
 if (frame.method === 'initialize') result = { userAgent: 'fixture', codexHome: ${JSON.stringify(directory)}, platformFamily: 'unix', platformOs: 'linux' };
 else if (frame.method === 'thread/read') result = { thread };
 else if (frame.method === 'thread/turns/list') result = { data: [{ id: frame.params.cursor ? 'turn-b' : 'turn-a', status: 'completed', itemsView: 'full', startedAt: 1, completedAt: 2, items: [{ type: 'userMessage', id: 'user', clientId: 'command', content: [{ type: 'text', text: '  原文  ', text_elements: [] }] }] }], nextCursor: process.env.WDCC_OBSERVE_LOOP || !frame.params.cursor ? 'second' : null, backwardsCursor: null };
 else { process.stdout.write(JSON.stringify({ id: frame.id, error: { code: -32601, message: 'mutation forbidden' } }) + '\\n'); return; }
 process.stdout.write(JSON.stringify({ id: frame.id, result }) + '\\n');
});
`);
  await chmod(command, 0o700);
  try {
    const adapter = new CodexAdapter({ command, env: { ...process.env, WDCC_OBSERVE_RECORD: record } });
    const result = await adapter.observe({ sessionId: 's', nativeId: 'thread', cwd: directory, providerId: null });
    expect(result).toMatchObject({ authority: 'history-only', state: 'unknown', releasePolicy: 'managed-process' });
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]).toMatchObject({ itemsComplete: true, clientCommandIds: ['command'], items: [{ kind: 'user.message', data: { text: '  原文  ', clientCommandId: 'command' } }] });
    const { readFile } = await import('node:fs/promises');
    const methods = (await readFile(record, 'utf8')).trim().split('\n').map(line => (JSON.parse(line) as { method: string }).method);
    expect(methods).toEqual(['initialize', 'initialized', 'thread/read', 'thread/turns/list', 'thread/turns/list']);
    const looping = new CodexAdapter({ command, env: { ...process.env, WDCC_OBSERVE_RECORD: record, WDCC_OBSERVE_LOOP: '1' } });
    await expect(looping.observe({ sessionId: 's', nativeId: 'thread', cwd: directory, providerId: null })).rejects.toThrow('游标循环');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
