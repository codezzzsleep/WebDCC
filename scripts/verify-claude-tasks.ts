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
import { chromium, type Browser, type Page } from '@playwright/test';
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
import type { ClaudeTask, NativeActionRequest, NativeActionResponse } from '../packages/protocol/src/index.js';
import { sourceFingerprint } from './lib/gate-report.js';
import { captureProcess, processState } from '../packages/server/src/process-identity.js';

assert(process.argv[2] && ['--live', '--replay'].includes(process.argv[3] ?? ''), 'Usage: verify-claude-tasks.ts <private-config.json> --live|--replay');
const input = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8')) as { out: string; credentialFile: string; upstream: string; model: string; runId: string;
  recordedModels?: string; workspace?: string; useUIStop?: boolean; verifyForegroundInterrupt?: boolean };
const replayMode = process.argv[3] === '--replay';
assert(/^[0-9a-f-]{36}$/i.test(input.runId), 'A fresh UUID identifies each admitted validation run');
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
  scope: 'actual official SDK and tools, two delegated tasks, native stop and sibling process continuity; model mode recorded separately; private local source UI, no target deployment',
  nativeBehavior: 'official preset, tools and inherited permissions; no native binary/SDK modification', modelMode: replayMode ? 'recorded real responses; no new provider calls' : 'live provider', status: 'admitted', modelRequests: [], checks: {}, pending: [] };
const requests: Record<string, unknown>[] = [];
report['modelRequests'] = requests;
function save(): void {
  const tmp = join(out, 'report.json.writing'); writeFileSync(tmp, JSON.stringify(safe(report), null, 2) + '\n', { mode: 0o600 }); renameSync(tmp, join(out, 'report.json'));
}
function checked(values: Record<string, unknown>): void { report['checks'] = { ...(report['checks'] as object), ...values }; save(); }
save();
const workspace = input.workspace ?? join('/tmp', `webdcc-claude-tasks-${input.runId}`, 'workspace'); const profile = join(out, 'profile'); const data = join(out, 'app-data'); const web = join(out, 'web');
report['workspace'] = workspace;
for (const path of [workspace, profile, data, web]) await mkdir(path, { recursive: true, mode: 0o700 });
for (const name of ['a', 'b']) await writeFile(join(workspace, `${name}.py`), `import os,time,json\nfrom pathlib import Path\np=Path(__file__).parent\n(p/'${name}.ticks').write_text('')\n(p/'${name}.pid.json').write_text(json.dumps({'pid':os.getpid(),'runId':${JSON.stringify(input.runId)}}))\nfor i in range(180):\n with (p/'${name}.ticks').open('a') as f: f.write(str(i)+'\\n'); f.flush()\n time.sleep(1)\nprint('${name.toUpperCase()}_DONE')\n`);
report['taskScriptHashes'] = Object.fromEntries(await Promise.all(['a', 'b'].map(async name => [name, hash(await readFile(join(workspace, `${name}.py`)))]))); save();
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
let browser: Browser | undefined; let page: Page | undefined; let sessionId = ''; let approvals = 0;
let socketGeneration = 0; let throughSeq: number | undefined;
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
const ticks = (name: string): number => { try { const value = readFileSync(join(workspace, `${name}.ticks`), 'utf8').trim(); return value === '' ? 0 : value.split('\n').length; } catch { return 0; } };
const pid = (name: string): number | undefined => { try {
  const value = JSON.parse(readFileSync(join(workspace, `${name}.pid.json`), 'utf8')) as { pid: number; runId: string };
  return value.runId === input.runId && Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : undefined;
} catch { return undefined; } };
const task = (name: string): ClaudeTask | undefined => adapter.nativeState(sessionId).tasks.find(row => row.taskId === startedIds.get(name));
async function stop(row: ClaudeTask, commandId: string): Promise<NativeActionResponse> {
  const snapshot = await manager.nativeControls(sessionId);
  const revision = (snapshot.state as { revision: string }).revision;
  return manager.executeNativeControl(sessionId, { commandId, revision, action: { type: 'stop-task', taskId: row.taskId, runId: row.runId ?? null } });
}
async function openUI(base: string): Promise<Page> {
  if (page !== undefined) return page;
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const cookie = issueCookie(token); secrets.push(cookie);
  await page.context().addCookies([{ name: 'wdcc-auth', value: cookie, url: base }]);
  page.on('websocket', socket => {
    const generation = ++socketGeneration; throughSeq = undefined;
    socket.on('framereceived', frame => {
      if (generation !== socketGeneration) return;
      const value = JSON.parse(String(frame.payload)) as { op?: string; sessionId?: string; throughSeq?: number };
      if (value.op === 'snapshot' && value.sessionId === sessionId) throughSeq = value.throughSeq;
    });
  });
  page.on('request', request => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== `/api/sessions/${sessionId}/native/actions`) return;
    const command = request.postDataJSON() as NativeActionRequest;
    const commands = (report['uiCommands'] ??= []) as unknown[];
    commands.push({ at: new Date().toISOString(), command }); save();
  });
  await page.goto(`${base}/s/${sessionId}`); return page;
}
async function taskPanel(activePage: Page) {
  const panel = activePage.getByTestId('claude-tasks-panel'); await panel.waitFor();
  if (await panel.locator('details').first().getAttribute('open') === null) await panel.locator('summary').first().click();
  return panel;
}
async function stopFromUI(row: ClaudeTask, base: string): Promise<{ command: NativeActionRequest; response: NativeActionResponse }> {
  const activePage = await openUI(base); const panel = await taskPanel(activePage);
  const button = panel.locator(`[data-task-id="${row.taskId}"] > details > .claude-task-stop`).getByRole('button', { name: '停止此任务', exact: true });
  await waitFor('verified current native task stop button', async () => await button.count() === 1 && await button.isEnabled(), 40000);
  const received = activePage.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/sessions/${sessionId}/native/actions`, { timeout: 40000 });
  await button.click(); const http = await received;
  assert.equal(http.status(), 200);
  const command = http.request().postDataJSON() as NativeActionRequest;
  assert.deepEqual(command.action, { type: 'stop-task', taskId: row.taskId, runId: row.runId ?? null });
  return { command, response: await http.json() as NativeActionResponse };
}
try {
  const probe = await adapter.probe(); assert.equal(probe.compatible, true);
  const binary = resolveNativeCli(); assert(binary); report['nativeBinarySha256'] = hash(await readFile(binary));
  report['schemaSha256'] = hash(await readFile('node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts'));
  report['sdkModuleSha256'] = hash(await readFile('node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'));
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
  const aProcess = captureProcess(aPid); const bProcess = captureProcess(bPid); assert(aProcess && bProcess);
  assert.notEqual(a.taskId, b.taskId); assert(alive(aPid) && alive(bPid));
  assert.equal(processState(aProcess), 'running'); assert.equal(processState(bProcess), 'running');
  report['tasksBefore'] = structuredClone(adapter.nativeState(sessionId).tasks);
  report['nativeOwner'] = store.nativeOwners.get(sessionId);
  report['processesBefore'] = { a: aProcess, b: bProcess, aTicks: ticks('a'), bTicks: ticks('b') }; checked({ distinctNativeTasks: true, currentRunProcessesStarted: true });
  let firstStopId: string;
  if (input.useUIStop) {
    assert.equal(adapter.nativeState(sessionId).controls.perTaskStopAffordance, true, 'Source UI stop requires the accepted exact native declaration');
    const result = await stopFromUI(a, base); firstStopId = result.command.commandId;
    report['stopACommand'] = { commandId: firstStopId, taskId: a.taskId, runId: a.runId, source: 'actual source task button' };
    report['stopAReturn'] = result.response;
  } else {
    firstStopId = `stop-a-${randomUUID()}`; report['stopACommand'] = { commandId: firstStopId, taskId: a.taskId, runId: a.runId, source: 'public server control' }; save();
    report['stopAReturn'] = await stop(a, firstStopId);
  }
  save();
  await waitFor('matching native stopped notification for A', () => task('a')?.terminalNotification === 'stopped', 40000);
  checked({ nativeStoppedA: true });
  await waitFor('A actual tool process exit', () => processState(aProcess) === 'exited', 15000);
  checked({ actualAProcessExited: true });
  const bBefore = ticks('b'); await pause(2500);
  report['processesAfterA'] = { a: processState(aProcess), b: processState(bProcess), bTicksBefore: bBefore, bTicksAfter: ticks('b') }; save();
  assert(processState(bProcess) === 'running' && ticks('b') > bBefore, 'B must continue producing actual side effects after A stops');
  checked({ actualBProcessAlive: true, bContinuedTicks: ticks('b') - bBefore });
  assert.equal(task('b')?.status, 'running'); assert.equal(store.nativeActions.get(firstStopId, sessionId)?.state, 'completed');
  assert.equal(typeof store.nativeActions.get(firstStopId, sessionId)?.callReturnedAt, 'string');
  checked({ BStillRunning: true, receiptConfirmedFromNative: true, nativeStopSDKArgument: 'taskId only' });
  if (input.useUIStop) checked({ actualNativeStopFromSourceButton: true });
  report['tasksAfterA'] = structuredClone(adapter.nativeState(sessionId).tasks); report['stopAReceipt'] = store.nativeActions.get(firstStopId, sessionId); save();
  const activePage = await openUI(base); const panel = await taskPanel(activePage);
  await waitFor('task UI retains A stopped and B running', async () => await panel.locator(`[data-task-id="${a.taskId}"]`).count() > 0 && await panel.locator(`[data-task-id="${b.taskId}"]`).count() > 0);
  assert.equal(await panel.locator(`[data-task-id="${a.taskId}"] > details > summary .claude-task-status`).textContent(), '已停止');
  assert.equal(await panel.locator(`[data-task-id="${b.taskId}"] > details > summary .claude-task-status`).textContent(), '运行中');
  await activePage.screenshot({ path: join(out, 'native-after-stop-a.png'), fullPage: true });
  await activePage.reload(); await taskPanel(activePage);
  assert(await panel.locator(`[data-task-id="${a.taskId}"]`).count() > 0);
  assert.equal(await panel.locator(`[data-task-id="${b.taskId}"] > details > summary .claude-task-status`).textContent(), '运行中');
  checked({ sourceUI: true, realTaskRefresh: true });
  if (input.useUIStop) {
    const receipt = panel.locator(`[data-task-id="${a.taskId}"]`).getByTestId('claude-task-stop-receipt');
    await waitFor('real source stop receipt after refresh', async () => (await receipt.textContent())?.includes('原生停止已确认') === true, 20000);
    assert((await receipt.textContent())?.includes('调用已返回')); checked({ realStopReceiptRefresh: true });
    if (input.verifyForegroundInterrupt) {
      const before = ticks('b'); report['foregroundInterrupt'] = { at: new Date().toISOString(), source: 'public SessionManager.interrupt', bTicksBefore: before }; save();
      await manager.interrupt(sessionId); await pause(2500);
      assert.equal(processState(bProcess), 'running'); assert(ticks('b') > before); assert.equal(task('b')?.status, 'running');
      checked({ openInputInterruptSparesActualBackgroundPeer: true });
    }
    const generation = socketGeneration; const checkpoint = store.lastSeq(sessionId);
    for (const client of app.websocketServer.clients) client.terminate();
    await waitFor('actual source websocket reconnect snapshot', () => socketGeneration > generation && throughSeq !== undefined && throughSeq >= checkpoint, 30000);
    assert.equal(await panel.locator(`[data-task-id="${b.taskId}"] > details > summary .claude-task-status`).textContent(), '运行中');
    checked({ realTaskWebsocketReconnect: true });
    const other = await manager.createSession({ workspaceId: ws.id, agent: 'claude-code', providerId: provider.id, model: input.model, accessMode: 'inherit', title: 'Empty native switch session' });
    report['switchSessionId'] = other.id; save();
    await activePage.locator(`a[href="/s/${other.id}"]`).click();
    await waitFor('empty other actual session UI', async () => activePage.url().endsWith(`/s/${other.id}`) && await activePage.getByTestId('claude-tasks-panel').count() === 0, 30000);
    await activePage.locator(`a[href="/s/${sessionId}"]`).click(); await taskPanel(activePage);
    await waitFor('real receipt on return to original session', async () => (await receipt.textContent())?.includes('原生停止已确认') === true, 20000);
    assert.equal(await panel.locator(`[data-task-id="${b.taskId}"] > details > summary .claude-task-status`).textContent(), '运行中');
    checked({ realTaskSessionSwitch: true, realStopReceiptSessionSwitch: true });
  }
  await activePage.screenshot({ path: join(out, 'native-after-refresh.png'), fullPage: true });
  let secondStopId: string;
  if (input.useUIStop) {
    const result = await stopFromUI(task('b')!, base); secondStopId = result.command.commandId;
    report['stopBCommand'] = { commandId: secondStopId, taskId: b.taskId, runId: b.runId, source: 'actual source task button' };
    report['stopBReturn'] = result.response;
  } else {
    secondStopId = `stop-b-${randomUUID()}`; report['stopBCommand'] = { commandId: secondStopId, taskId: b.taskId, runId: b.runId, source: 'public server control' }; save();
    report['stopBReturn'] = await stop(task('b')!, secondStopId);
  }
  save();
  await waitFor('native stopped B cleanup', () => task('b')?.terminalNotification === 'stopped', 40000);
  report['stopBReceipt'] = store.nativeActions.get(secondStopId, sessionId); checked({ nativeStoppedBCleanup: true });
  report['status'] = replayMode ? 'actual-sdk-stop-with-recorded-model-responses-passed' : 'live-single-task-stop-passed'; report['approvals'] = approvals; report['finishedAt'] = new Date().toISOString(); save();
} catch (error) {
  report['status'] = 'failed'; report['error'] = error instanceof Error ? error.message : String(error); process.exitCode = 1; save();
} finally {
  const sideEffects = join(out, 'side-effects'); await mkdir(sideEffects, { recursive: true, mode: 0o700 });
  const sideEffectHashes: Record<string, string> = {};
  for (const name of ['a.py', 'b.py', 'a.pid.json', 'b.pid.json', 'a.ticks', 'b.ticks']) {
    try { const bytes = await readFile(join(workspace, name)); await writeFile(join(sideEffects, name), bytes, { flag: 'wx', mode: 0o600 }); sideEffectHashes[name] = hash(bytes); }
    catch (error) { (report['pending'] as unknown[]).push({ kind: 'side-effect-capture-missing', file: name, error: String(error) }); }
  }
  report['sideEffectHashes'] = sideEffectHashes; save();
  const cleanupErrors: { step: string; error: string }[] = [];
  const cleanup = async (step: string, run: () => Promise<unknown>): Promise<void> => {
    try { await run(); } catch (error) { cleanupErrors.push({ step, error: String(error) }); report['cleanupErrors'] = cleanupErrors; save(); }
  };
  await cleanup('browser', async () => browser?.close());
  await cleanup('owned-native-sessions', async () => manager.disposeAll());
  await cleanup('private-source-server', async () => app.close());
  await cleanup('model-observer', async () => proxy.close());
  report['cleanupErrors'] = cleanupErrors;
  if (replayServer !== undefined) { replayServer.closeAllConnections(); await new Promise<void>(resolveClose => replayServer!.close(() => resolveClose())); }
  await providers.update(provider.id, { apiKey: '' }).catch(() => undefined);
  const envelopes = db.prepare('SELECT * FROM native_event_envelopes WHERE session_id = ? ORDER BY id').all(sessionId)
    .map(value => { const row = value as { payload: string }; return { ...row, payload: safe(JSON.parse(row.payload)) }; });
  writeFileSync(join(out, 'native-envelopes.json'), JSON.stringify(safe(envelopes), null, 2) + '\n', { mode: 0o600 });
  report['nativeEnvelopeCount'] = envelopes.length;
  report['native-envelopes.jsonSha256'] = hash(await readFile(join(out, 'native-envelopes.json')));
  const stops = envelopes.flatMap(envelope => {
    const frame = (envelope.payload as { frame?: { type?: string; request_id?: string; request?: { subtype?: string; task_id?: string } } }).frame;
    return frame?.type === 'control_request' && frame.request?.subtype === 'stop_task'
      ? [{ requestId: frame.request_id, request: frame.request, taskIdOnly: Object.keys(frame.request).sort().join(',') === 'subtype,task_id' }] : [];
  });
  const initializes = envelopes.flatMap(envelope => {
    const frame = (envelope.payload as { frame?: { type?: string; request?: { subtype?: string; perTaskStopAffordance?: boolean } } }).frame;
    return frame?.type === 'control_request' && frame.request?.subtype === 'initialize' ? [frame.request.perTaskStopAffordance] : [];
  });
  report['nativeInitializeDeclarations'] = initializes;
  if (input.useUIStop && !initializes.includes(true)) { report['status'] = 'failed'; report['error'] = 'Verified declaration was not delivered in actual native initialize'; process.exitCode = 1; }
  report['nativeStopControls'] = stops;
  const controlsVerified = stops.length >= 2 && stops.every(stop => stop.taskIdOnly)
    && stops.some(stop => stop.request.task_id === (report['stopACommand'] as { taskId?: string } | undefined)?.taskId)
    && stops.some(stop => stop.request.task_id === (report['stopBCommand'] as { taskId?: string } | undefined)?.taskId);
  checked({ nativeControlTaskIdOnly: controlsVerified });
  if (String(report['status']).endsWith('-passed') && !controlsVerified) {
    report['status'] = 'failed'; report['error'] = 'Actual stop control targets/arguments were not captured'; process.exitCode = 1;
  }
  for (const file of ['native.jsonl', 'mapped.jsonl', 'model.jsonl']) { try { report[`${file}Sha256`] = hash(await readFile(join(out, file))); } catch { /* A missing capture remains explicit. */ } }
  report['statusAfterCleanup'] = report['status']; save(); db.close();
  report['newProviderRequests'] = replayMode ? 0 : requests.length; save();
  process.stdout.write(JSON.stringify(safe({ status: report['status'], error: report['error'], out, recordedHTTPRequests: requests.length,
    newProviderRequests: report['newProviderRequests'], checks: report['checks'] })) + '\n');
}
