/** Opt-in real-provider task acceptance. The observer forwards native bytes
 * unchanged. A durable admission prevents repeating a captured paid prompt. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, appendFileSync, openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium, type Browser } from '@playwright/test';
import { ModelProxy, redactDiagnosticValue } from '../packages/testing/model-proxy/src/index.js';
import { ClaudeAdapter, resolveNativeCli, PINNED_CLI_VERSION, PINNED_SDK_VERSION } from '../packages/adapters/claude/src/adapter.js';
import { openDb } from '../packages/server/src/db.js';
import { Store } from '../packages/server/src/store.js';
import { FileStore } from '../packages/server/src/files.js';
import { ProviderRegistry } from '../packages/server/src/providers.js';
import { DshConnectionStore } from '../packages/server/src/dsh-connection.js';
import { SessionManager } from '../packages/server/src/manager.js';
import { buildApp } from '../packages/server/src/app.js';
import { issueCookie } from '../packages/server/src/auth.js';
import type { Config } from '../packages/server/src/config.js';
import type { ClaudeTask, NativeActionResponse } from '../packages/protocol/src/index.js';
import { sourceFingerprint } from './lib/gate-report.js';

assert(process.argv[2] && ['--live', '--replay'].includes(process.argv[3] ?? ''), 'Usage: verify-claude-tasks.ts <private-config.json> --live|--replay');
const input = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8')) as { out: string; credentialFile: string; upstream: string; model: string; runId: string; recordedModels?: string; workspace?: string };
const replayMode = process.argv[3] === '--replay';
const out = resolve(input.out);
const url = new URL(input.upstream); assert(url.protocol === 'https:' && !url.username && !url.password && !url.search);
await mkdir(out, { recursive: true, mode: 0o700 });
const lock = openSync(join(out, 'admission.lock'), 'wx', 0o600);
writeFileSync(lock, JSON.stringify({ runId: input.runId, pid: process.pid, at: new Date().toISOString() })); closeSync(lock);
const key = (await readFile(resolve(input.credentialFile), 'utf8')).trim(); assert(key);
const token = randomUUID() + randomUUID(); const secrets = [key, token];
const safe = (value: unknown): unknown => redactDiagnosticValue(value, secrets);
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const report: Record<string, unknown> = { version: 1, runId: input.runId, pid: process.pid, startedAt: new Date().toISOString(),
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(),
  sdk: PINNED_SDK_VERSION, cli: PINNED_CLI_VERSION, platform: process.platform, arch: process.arch,
  provider: { upstream: input.upstream, model: input.model, credentialFile: input.credentialFile },
  scope: 'actual official SDK/model, two delegated tasks, native stop and sibling process continuity; private local source UI, no target deployment',
  nativeBehavior: 'official preset, tools and inherited permissions; no native binary/SDK modification', modelMode: replayMode ? 'recorded real responses; no new provider calls' : 'live provider', status: 'admitted', modelRequests: [], checks: {}, pending: [] };
const requests: Record<string, unknown>[] = [];
report['modelRequests'] = requests;
function save(): void {
  const tmp = join(out, 'report.json.writing'); writeFileSync(tmp, JSON.stringify(safe(report), null, 2) + '\n', { mode: 0o600 }); renameSync(tmp, join(out, 'report.json'));
}
save();
const workspace = input.workspace ?? join('/tmp', `webdcc-claude-tasks-${input.runId}`, 'workspace'); const profile = join(out, 'profile'); const data = join(out, 'app-data'); const web = join(out, 'web');
report['workspace'] = workspace;
for (const path of [workspace, profile, data, web]) await mkdir(path, { recursive: true, mode: 0o700 });
for (const name of ['a', 'b']) await writeFile(join(workspace, `${name}.py`), `import os,time,json\nfrom pathlib import Path\np=Path(__file__).parent\n(p/'${name}.pid.json').write_text(json.dumps({'pid':os.getpid()}))\nfor i in range(180):\n with (p/'${name}.ticks').open('a') as f: f.write(str(i)+'\\n'); f.flush()\n time.sleep(1)\nprint('${name.toUpperCase()}_DONE')\n`);
let replayServer: ReturnType<typeof createServer> | undefined;
let target = input.upstream;
if (replayMode) {
  assert(input.recordedModels, 'Replay requires immutable recorded model responses');
  const bytes = await readFile(input.recordedModels); report['sourceModelRecordingSha256'] = hash(bytes);
  const rows = bytes.toString().trim().split('\n').map(line => JSON.parse(line) as { request: { method: string; path: string; body: string }; response: { status: number; headers: Record<string, string>; chunks: { data: string; t: number }[] } });
  const signature = (body: { messages?: { role: string; content: unknown }[]; tools?: unknown }): string => {
    const last = body.messages?.findLast(message => message.role === 'user');
    const parts = Array.isArray(last?.content) ? last.content as { type: string; tool_use_id?: string; text?: string }[] : [];
    const result = parts.find(part => part.type === 'tool_result');
    const text = typeof last?.content === 'string' ? last.content : parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
    return result?.tool_use_id !== undefined ? `result:${result.tool_use_id}` : text.includes('Use the native Agent tool to launch TWO') ? 'main-initial' : text.includes('python3 a.py') && !text.includes('python3 b.py') ? 'agent-a'
      : text.includes('python3 b.py') && !text.includes('python3 a.py') ? 'agent-b' : `text:${hash(text)}`;
  };
  replayServer = createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const raw = Buffer.concat(chunks);
    if (req.method !== 'POST' || !/^\/v1\/messages(?:\?|$)/.test(req.url ?? '')) { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(raw.toString()) as Parameters<typeof signature>[0];
    const match = rows.find(row => row.request.method === 'POST' && /^\/v1\/messages(?:\?|$)/.test(row.request.path)
      && row.response.status >= 200 && row.response.status < 300 && signature(JSON.parse(Buffer.from(row.request.body, 'base64').toString())) === signature(body)
      && hash(JSON.stringify((JSON.parse(Buffer.from(row.request.body, 'base64').toString()) as Parameters<typeof signature>[0]).tools)) === hash(JSON.stringify(body.tools)));
    if (match === undefined) { (report['pending'] as unknown[]).push({ kind: 'untriggered-recorded-model-followup', signature: signature(body), inputSha256: hash(raw) }); save(); return; }
    const original = JSON.parse(Buffer.from(match.request.body, 'base64').toString()) as Parameters<typeof signature>[0];
    assert.equal(hash(JSON.stringify(body.tools)), hash(JSON.stringify(original.tools)), 'Replay native tool schemas changed');
    appendFileSync(join(out, 'replay-associations.jsonl'), JSON.stringify({ currentInputSha256: hash(raw), originalInputSha256: hash(Buffer.from(match.request.body, 'base64')), signature: signature(body) }) + '\n');
    res.writeHead(match.response.status, match.response.headers);
    for (const chunk of match.response.chunks) res.write(Buffer.from(chunk.data, 'base64'));
    res.end();
  })().catch(error => { (report['pending'] as unknown[]).push({ kind: 'replay-mismatch', error: String(error) }); save(); res.writeHead(503); res.end(); }); });
  await new Promise<void>(resolveListen => replayServer!.listen(0, '127.0.0.1', resolveListen));
  const addr = replayServer.address(); assert(addr && typeof addr !== 'string'); target = `http://127.0.0.1:${addr.port}`;
}
const proxy = new ModelProxy({ target, recordFile: join(out, 'model.jsonl'), secrets, maxCaptureBytes: 8 * 1024 * 1024,
  onEvent: event => {
    if (event.phase === 'request') { requests.push({ requestId: event.requestId, at: new Date().toISOString(), state: 'in-flight', request: event.value }); save(); }
    if (event.phase === 'complete') {
      const row = requests.find(row => row['requestId'] === event.requestId); const record = event.value as { outcome?: string; response?: { status: number }; coverage?: unknown };
      if (row) Object.assign(row, { state: record.outcome, httpStatus: record.response?.status, coverage: record.coverage }); save();
    }
  } });
const address = await proxy.listen();
const db = openDb(join(data, 'database.sqlite')); const store = new Store(db); const files = new FileStore(data, store); await files.init();
const providers = new ProviderRegistry(store, data); await providers.init();
const provider = await providers.create({ name: 'Native task validation', baseUrl: address.url, protocols: ['anthropic-messages'], models: [input.model], apiKey: key });
const dsh = new DshConnectionStore(data); await dsh.init();
const adapter = new ClaudeAdapter({ env: { CLAUDE_CONFIG_DIR: profile }, catalogOptions: async () => ({ sessionId: 'catalog-only', cwd: workspace,
  providerId: provider.id, provider: await providers.runtimeConfig(provider.id), model: input.model }),
  traceSink: { record: frame => { appendFileSync(join(out, 'native.jsonl'), JSON.stringify(safe(frame)) + '\n', { mode: 0o600 }); } } });
const manager = new SessionManager(store, { idleDisposeMin: 0, watchdogDataDir: data, resolveProvider: id => providers.runtimeConfig(id) });
manager.registerAdapter(adapter);
const startedIds = new Map<string, string>();
adapter.onEvent((sessionId, event) => {
  const native = 'native' in event ? event.native as { type?: string; subtype?: string; description?: string; task_id?: string } | undefined : undefined;
  if (native?.type === 'system' && native.subtype === 'task_started' && native.task_id !== undefined) {
    if (native.description === 'CLAUDE_TASK_A') startedIds.set('a', native.task_id);
    if (native.description === 'CLAUDE_TASK_B') startedIds.set('b', native.task_id);
  }
  appendFileSync(join(out, 'mapped.jsonl'), JSON.stringify(safe({ sessionId, event })) + '\n', { mode: 0o600 });
});
await build({ entryPoints: ['packages/web/src/main.tsx'], bundle: true, outfile: join(web, 'ui.js'), format: 'esm', platform: 'browser', jsx: 'automatic',
  external: ['/fonts/*'], define: { 'import.meta.env': JSON.stringify({ DEV: false, MODE: 'production' }) } });
await writeFile(join(web, 'index.html'), '<html><head><link rel="stylesheet" href="/ui.css"></head><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>');
const config: Config = { host: '127.0.0.1', port: 0, token, dataDir: data, dshPort: 0, idleDisposeMin: 0, version: 'private-native-task-validation' };
const { app, hub } = await buildApp({ config, store, files, manager, providers, dsh, webDist: web });
manager.setHooks({ onFeed: (id, patch, seq) => hub.broadcastFeed(id, patch, seq), onEvent: event => hub.broadcastEvent(event),
  onDelta: (id, itemKey, field, append, turnId) => hub.broadcastDelta(id, itemKey, field, append, turnId),
  onUpdate: (id, itemKey, value, turnId) => hub.broadcastUpdate(id, itemKey, value, turnId), onStatus: () => undefined });
let browser: Browser | undefined; let sessionId = ''; let approvals = 0;
const pause = (ms: number) => new Promise<void>(resolvePause => setTimeout(resolvePause, ms));
let lastProgress = Date.now();
async function waitFor(label: string, predicate: () => boolean | Promise<boolean>, timeout = 120000): Promise<void> {
  const until = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= until) throw new Error(`Untriggered/timed out: ${label}`);
    if (sessionId) for (const event of store.allEvents(sessionId)) {
      if (event.kind !== 'approval.request') continue;
      const request = event.data as { approvalId: string; options: { id: string }[]; title: string; tool?: string; detail?: string };
      if (store.allEvents(sessionId).some(row => row.kind === 'approval.resolved' && (row.data as { approvalId: string }).approvalId === request.approvalId)) continue;
      const description = `${request.title}\n${request.detail ?? ''}`;
      const inScope = (request.tool === 'Agent' || request.tool === 'Task') && /CLAUDE_TASK_[AB]/.test(description)
        || request.tool === 'Bash' && /python3\s+(?:[^\s]*\/)?[ab]\.py/.test(description)
        || request.tool === 'Read' && description.includes(workspace);
      assert(inScope && request.options.some(option => option.id === 'allow'), `Unexpected native permission scope: ${request.tool}`);
      await manager.approve(sessionId, { approvalId: request.approvalId, optionId: 'allow' }, `approval-${randomUUID()}`);
      approvals++;
    }
    if (Date.now() - lastProgress > 10000) { report['waiting'] = label; save(); process.stdout.write(JSON.stringify({ runId: input.runId, waiting: label, requests: requests.length, approvals }) + '\n'); lastProgress = Date.now(); }
    await pause(100);
  }
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const ticks = (name: string): number => { try { return readFileSync(join(workspace, `${name}.ticks`), 'utf8').trim().split('\n').length; } catch { return 0; } };
const pid = (name: string): number | undefined => { try { return (JSON.parse(readFileSync(join(workspace, `${name}.pid.json`), 'utf8')) as { pid: number }).pid; } catch { return undefined; } };
const task = (name: string): ClaudeTask | undefined => adapter.nativeState(sessionId).tasks.find(row => row.taskId === startedIds.get(name));
async function stop(row: ClaudeTask, commandId: string): Promise<NativeActionResponse> {
  const snapshot = await manager.nativeControls(sessionId);
  const revision = (snapshot.state as { revision: string }).revision;
  return manager.executeNativeControl(sessionId, { commandId, revision, action: { type: 'stop-task', taskId: row.taskId, runId: row.runId ?? null } });
}
try {
  const probe = await adapter.probe(); assert.equal(probe.compatible, true);
  const binary = resolveNativeCli(); assert(binary); report['nativeBinarySha256'] = hash(await readFile(binary));
  report['schemaSha256'] = hash(await readFile('node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts'));
  await app.listen({ host: '127.0.0.1', port: 0 }); const listener = app.server.address(); assert(listener && typeof listener !== 'string');
  const base = `http://127.0.0.1:${listener.port}`;
  const ws = store.createWorkspace('Native task validation', workspace);
  const session = await manager.createSession({ workspaceId: ws.id, agent: 'claude-code', providerId: provider.id, model: input.model, accessMode: 'inherit' });
  sessionId = session.id; report['sessionId'] = sessionId; report['beforeDeclaration'] = adapter.nativeState(sessionId).controls;
  const prompt = 'Use the native Agent tool to launch TWO general-purpose subagents concurrently with run_in_background=true. Set their description fields exactly CLAUDE_TASK_A and CLAUDE_TASK_B. Give A this task: use Bash to run python3 a.py in the foreground with timeout 240000, without changing files, then report A_DONE. Give B the same task for python3 b.py and B_DONE. The scripts are in your current working directory. Do not run the scripts yourself, do not wait for the subagents, and do not stop them. After launching both reply TASKS_STARTED.';
  const commandId = `tasks-${randomUUID()}`; report['userCommand'] = { commandId, prompt, promptSha256: hash(prompt), submittedAt: new Date().toISOString() };
  report['status'] = replayMode ? 'executing-recorded-responses-no-provider' : 'submitting-one-new-paid-task'; save();
  await manager.send(sessionId, { text: prompt }, commandId);
  await waitFor('two actual delegated task processes', () => task('a') !== undefined && task('b') !== undefined && pid('a') !== undefined && pid('b') !== undefined && ticks('a') > 0 && ticks('b') > 0);
  const a = task('a')!; const b = task('b')!; const aPid = pid('a')!; const bPid = pid('b')!;
  assert.notEqual(a.taskId, b.taskId); assert(alive(aPid) && alive(bPid));
  report['tasksBefore'] = adapter.nativeState(sessionId).tasks; report['processesBefore'] = { aPid, bPid, aTicks: ticks('a'), bTicks: ticks('b') }; save();
  const firstStopId = `stop-a-${randomUUID()}`; report['stopACommand'] = { commandId: firstStopId, taskId: a.taskId, runId: a.runId }; save();
  report['stopAReturn'] = await stop(a, firstStopId); save();
  await waitFor('matching native stopped notification for A', () => task('a')?.terminalNotification === 'stopped', 40000);
  await waitFor('A actual tool process exit', () => !alive(aPid), 15000);
  const bBefore = ticks('b'); await pause(2500);
  assert(alive(bPid) && ticks('b') > bBefore, 'B must continue producing actual side effects after A stops');
  assert.equal(task('b')?.status, 'running'); assert.equal(store.nativeActions.get(firstStopId, sessionId)?.state, 'completed');
  report['checks'] = { distinctNativeTasks: true, nativeStoppedA: true, actualAProcessExited: true, actualBProcessAlive: true,
    bContinuedTicks: ticks('b') - bBefore, BStillRunning: true, receiptConfirmedFromNative: true, nativeStopSDKArgument: 'taskId only' };
  report['tasksAfterA'] = adapter.nativeState(sessionId).tasks; report['stopAReceipt'] = store.nativeActions.get(firstStopId, sessionId); save();
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const cookie = issueCookie(token); secrets.push(cookie);
  await page.context().addCookies([{ name: 'wdcc-auth', value: cookie, url: base }]);
  await page.goto(`${base}/s/${sessionId}`); const panel = page.getByTestId('claude-tasks-panel'); await panel.waitFor(); await panel.locator('summary').first().click();
  await waitFor('task UI retains A stopped and B running', async () => await panel.locator(`[data-task-id="${a.taskId}"]`).count() > 0 && await panel.locator(`[data-task-id="${b.taskId}"]`).count() > 0);
  await page.screenshot({ path: join(out, 'native-after-stop-a.png'), fullPage: true });
  await page.reload(); await panel.waitFor(); await panel.locator('summary').first().click();
  assert(await panel.locator(`[data-task-id="${a.taskId}"]`).count() > 0); report['checks'] = { ...(report['checks'] as object), sourceUI: true, realTaskRefresh: true };
  await page.screenshot({ path: join(out, 'native-after-refresh.png'), fullPage: true });
  const secondStopId = `stop-b-${randomUUID()}`; report['stopBCommand'] = { commandId: secondStopId, taskId: b.taskId, runId: b.runId }; save();
  report['stopBReturn'] = await stop(task('b')!, secondStopId);
  await waitFor('native stopped B cleanup', () => task('b')?.terminalNotification === 'stopped', 40000);
  report['status'] = replayMode ? 'actual-sdk-stop-with-recorded-model-responses-passed' : 'live-single-task-stop-passed'; report['approvals'] = approvals; report['finishedAt'] = new Date().toISOString(); save();
} catch (error) {
  report['status'] = 'failed'; report['error'] = error instanceof Error ? error.message : String(error); process.exitCode = 1; save();
} finally {
  await browser?.close(); await manager.disposeAll().catch(() => undefined); await app.close().catch(() => undefined); await proxy.close().catch(error => { report['recordingError'] = String(error); });
  if (replayServer !== undefined) { replayServer.closeAllConnections(); await new Promise<void>(resolveClose => replayServer!.close(() => resolveClose())); }
  await providers.update(provider.id, { apiKey: '' }).catch(() => undefined);
  const envelopes = db.prepare('SELECT * FROM native_event_envelopes WHERE session_id = ? ORDER BY id').all(sessionId)
    .map(value => { const row = value as { payload: string }; return { ...row, payload: safe(JSON.parse(row.payload)) }; });
  writeFileSync(join(out, 'native-envelopes.json'), JSON.stringify(safe(envelopes), null, 2) + '\n', { mode: 0o600 });
  report['nativeEnvelopeCount'] = envelopes.length;
  report['native-envelopes.jsonSha256'] = hash(await readFile(join(out, 'native-envelopes.json')));
  for (const file of ['native.jsonl', 'mapped.jsonl', 'model.jsonl']) { try { report[`${file}Sha256`] = hash(await readFile(join(out, file))); } catch { /* A missing capture remains explicit. */ } }
  report['statusAfterCleanup'] = report['status']; save(); db.close();
  process.stdout.write(JSON.stringify(safe({ status: report['status'], error: report['error'], out, modelRequests: requests.length, checks: report['checks'] })) + '\n');
}
