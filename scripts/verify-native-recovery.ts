/** Isolated pinned binary + scripted model evidence. This is not a paid model
 * acceptance run. The direct RPC reference and restored Web projection differ
 * in implementation; read-only reconciliation must make zero model calls. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { arch, platform } from 'node:os';
import { JsonRpcStdio } from '../packages/adapters/codex/src/rpc.js';
import { CodexAdapter, PINNED_VERSION } from '../packages/adapters/codex/src/adapter.js';
import { openDb } from '../packages/server/src/db.js';
import { Store } from '../packages/server/src/store.js';
import { SessionManager } from '../packages/server/src/manager.js';
import { isolatedEnv } from '../packages/server/src/test-isolation.js';
import { startResponsesMock } from '../packages/testing/mock-models/src/responses-server.js';
import { sourceFingerprint } from './lib/gate-report.js';

const binaryIndex = process.argv.indexOf('--binary');
if (binaryIndex < 0 || !process.argv[binaryIndex + 1]) throw new Error('需要 --binary 指定独立安装的 Codex 0.167.0');
const command = resolve(process.argv[binaryIndex + 1]!);
const reportIndex = process.argv.indexOf('--report');
const report = resolve(reportIndex < 0 ? 'evidence/native-recovery.json' : process.argv[reportIndex + 1]!);
const isolated = isolatedEnv({ PATH: process.env['PATH'] }, 'wdcc-native-recovery');
const workspacePath = join(isolated.dirs.root, 'workspace'); await mkdir(workspacePath);
const recordPath = join(isolated.dirs.root, 'model.jsonl');
const expected = '原生恢复确认：一次执行。';
const mock = await startResponsesMock({ plan: [{ text: expected }], recordPath, log: () => undefined });
const overrides = ['model_provider=wdcc_mock', 'model="mock-responses-1"', 'model_providers.wdcc_mock.name="WDCC mock"',
  `model_providers.wdcc_mock.base_url="${mock.url}/v1"`, 'model_providers.wdcc_mock.wire_api="responses"', 'model_providers.wdcc_mock.env_key="WDCC_MOCK_KEY"'];
const env = { ...isolated.env, WDCC_MOCK_KEY: 'mock-key-not-a-secret' };
const file = join(isolated.dirs.data, 'recovery.sqlite');
let db = openDb(file); let manager: SessionManager | undefined; let rpc: JsonRpcStdio | undefined;
const binaryHash = createHash('sha256'); for await (const chunk of createReadStream(command)) binaryHash.update(chunk);
const evidence: Record<string, unknown> = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceFingerprint: sourceFingerprint(), kind: 'pinned-binary-with-scripted-model', baseline: PINNED_VERSION,
  nativeBinarySha256: binaryHash.digest('hex'), environment: { os: platform(), arch: arch(), node: process.version },
  configurationFingerprint: createHash('sha256').update(JSON.stringify({ overrides, expected })).digest('hex'),
  paidModel: false, startedAt: new Date().toISOString(), passed: false };
try {
  let store = new Store(db); const workspace = store.createWorkspace('native recovery', workspacePath);
  const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
  const identity = store.nativeOwners.acquire('direct-reference', session.id, 'codex');
  const adapter = new CodexAdapter({ command, configOverrides: overrides, env });
  assert.equal((await adapter.probe()).version, PINNED_VERSION);
  rpc = JsonRpcStdio.start({ command, args: ['app-server', ...overrides.flatMap(value => ['-c', value])], env, cwd: workspacePath });
  store.nativeOwners.bindProcess(session.id, identity, rpc.child.pid!, isolated.dirs.CODEX_HOME, PINNED_VERSION);
  const notifications: Record<string, unknown>[] = [];
  rpc.onNotification(frame => notifications.push(frame));
  await rpc.request('initialize', { clientInfo: { name: 'native-reference', version: '0.1' }, capabilities: null }); rpc.notify('initialized');
  const created = await rpc.request('thread/start', { cwd: workspacePath }) as { thread: { id: string } };
  store.updateSession(session.id, { nativeId: created.thread.id }); store.nativeOwners.activate(session.id, identity, created.thread.id);
  store.journal.claim({ op: 'send', sessionId: session.id, clientCommandId: 'accepted-native', text: 'Return the scripted response.' });
  store.journal.enqueue('accepted-native', session.id, 'web-turn', { text: 'Return the scripted response.' });
  store.journal.inputState('web-turn', 'native-accepted');
  store.appendEvent({ sessionId: session.id, turnId: 'web-turn', itemKey: 'start', kind: 'turn.started', data: {} });
  store.appendEvent({ sessionId: session.id, turnId: 'web-turn', itemKey: 'user', kind: 'user.message', data: { text: 'Return the scripted response.', clientCommandId: 'accepted-native' } });
  const started = await rpc.request('turn/start', { threadId: created.thread.id, clientUserMessageId: 'accepted-native', input: [{ type: 'text', text: 'Return the scripted response.', text_elements: [] }] }) as { turn: { id: string } };
  store.nativeHistory.bind(session.id, started.turn.id, 'web-turn');
  store.nativeOwners.observe(session.id, identity, started.turn.id);
  const deadline = Date.now() + 30_000;
  while (!notifications.some(frame => frame['method'] === 'turn/completed')) {
    assert.ok(Date.now() < deadline, 'native turn did not complete'); await new Promise(resolve => setTimeout(resolve, 50));
  }
  const terminal = notifications.find(frame => frame['method'] === 'turn/completed')!;
  const direct = notifications.filter(frame => frame['method'] === 'item/completed').map(frame => (frame['params'] as { item: { type: string; text?: string } }).item).find(item => item.type === 'agentMessage');
  assert.equal(direct?.text, expected);
  const exited = once(rpc.child, 'exit'); rpc.child.kill('SIGKILL'); await exited;
  store.nativeOwners.release(session.id, identity, false);
  store.journal.enqueue('later-native', session.id, 'later-web-turn', { text: 'Preserve this queued input.' });
  db.close(); db = openDb(file); store = new Store(db); manager = new SessionManager(store, { idleDisposeMin: 0 }); manager.registerAdapter(adapter);
  assert.equal(store.journal.get('accepted-native')?.state, 'uncertain');
  const modelBefore = await readFile(recordPath, 'utf8');
  const preview = await manager.reconcile(session.id);
  assert.equal(preview.canApply, true, JSON.stringify(preview.reasons));
  const applied = await manager.applyReconciliation(session.id, preview.revision);
  assert.equal(applied.applied, true);
  assert.equal(store.allEvents(session.id).findLast(event => event.kind === 'assistant.message')?.data && (store.allEvents(session.id).findLast(event => event.kind === 'assistant.message')!.data as { text: string }).text, direct?.text);
  assert.equal(store.allEvents(session.id).filter(event => event.kind === 'turn.completed').length, 1);
  assert.equal(store.journal.queue(session.id)[0]?.commandId, 'later-native');
  assert.equal(store.journal.queue(session.id)[0]?.state, 'queued');
  assert.equal(await readFile(recordPath, 'utf8'), modelBefore, 'reconciliation made a model request');
  evidence['nativeTerminal'] = terminal; evidence['observation'] = preview; evidence['webTerminal'] = store.allEvents(session.id).findLast(event => event.kind === 'turn.completed');
  await manager.disposeAll(); manager = undefined; db.close(); db = openDb(file); store = new Store(db);
  assert.equal(store.reconciliations.get(session.id)?.applied, true);
  assert.equal(store.journal.queue(session.id)[0]?.input.text, 'Preserve this queued input.');
  evidence['passed'] = true; evidence['recovery'] = 'SIGKILL native writer, reopen SQLite, read-only native observation, explicitly apply terminal, retain queued input';
} catch (error) { evidence['error'] = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  await manager?.disposeAll(); await rpc?.kill(); db.close(); await mock.close();
  evidence['endedAt'] = new Date().toISOString(); await mkdir(resolve(report, '..'), { recursive: true }); await writeFile(report, `${JSON.stringify(evidence, null, 2)}\n`);
  await rm(isolated.dirs.root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ passed: evidence['passed'], report, error: evidence['error'] })}\n`);
}
