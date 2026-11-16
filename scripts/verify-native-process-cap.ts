/** Actual official command/exec, unchanged default cap, no model input. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import type { TraceFrame } from '../packages/protocol/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { isolatedEnv } from '../packages/server/src/test-isolation.js';
import { createSourceTestApp } from '../browser-tests/helpers.js';
import { sourceFingerprint } from './lib/gate-report.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const binaryOption = option('--binary');
const reportOption = option('--report');
if (!binaryOption || !reportOption) throw new Error('Provide --binary and a new private --report.');
const binary = resolve(binaryOption);
const report = resolve(reportOption);
const runId = randomUUID();
const frames: TraceFrame[] = [];
const states: { type: string; process: Record<string, unknown> }[] = [];
const errors: string[] = [];
const evidence: Record<string, unknown> = {
  runId, kind: 'official-native-process-default-cap-source-ui', passed: false,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(),
  binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
  newPaidRequests: 0, phase: 'registered-before-native-start',
};
await mkdir(dirname(report), { recursive: true });
await writeFile(report, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const save = (): void => writeFileSync(report, JSON.stringify(evidence, null, 2) + '\n');
const isolated = isolatedEnv({ PATH: process.env['PATH'] }, 'wdcc-native-cap');
const workspacePath = join(isolated.dirs.root, 'workspace');
await mkdir(workspacePath);
Object.assign(evidence, { isolatedRoot: isolated.dirs.root, workspacePath });
const adapter = new CodexAdapter({ command: binary, env: isolated.env, traceSink: { record: frame => {
  frames.push(frame);
  const value = frame.frame as { id?: string | number; method?: string; params?: { processId?: string } };
  if (frame.dir === 'out' && value.method === 'command/exec') {
    Object.assign(evidence, { nativeRequestId: value.id, processId: value.params?.processId, phase: 'registered-before-native-command-write' });
    save();
  }
} } });
let ctx: Awaited<ReturnType<typeof createSourceTestApp>> | undefined;
let browser: Browser | undefined;
let sessionId: string | undefined;
const cleanupErrors: string[] = [];
async function until(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
function deltas() {
  return frames.flatMap(frame => {
    const value = frame.frame as { method?: string; params?: { processId: string; stream: string; deltaBase64: string; capReached: boolean } };
    return frame.dir === 'in' && value.method === 'command/exec/outputDelta' && value.params?.processId === evidence['processId'] ? [value.params] : [];
  });
}
function stdout(): Buffer {
  return Buffer.concat(deltas().filter(delta => delta.stream === 'stdout').map(delta => Buffer.from(delta.deltaBase64, 'base64')));
}
try {
  const probe = await adapter.probe();
  assert.equal(probe.compatible, true);
  assert.equal(probe.version, '0.169.0');
  evidence['nativeVersion'] = probe.version;
  ctx = await createSourceTestApp();
  ctx.manager.registerAdapter(adapter);
  const workspace = ctx.store.createWorkspace('Official native output cap', workspacePath);
  const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex', accessMode: 'read-only' });
  sessionId = session.id;
  const identity = ctx.manager.getRuntime(session.id)!.identity;
  Object.assign(evidence, { sessionId, nativeId: session.nativeId, identity, phase: 'native-created-before-process-input' });
  save();
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const address = ctx.app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    if (!socket.url().includes('/api/native-process/')) return;
    socket.on('framereceived', event => {
      const frame = JSON.parse(String(event.payload)) as { type: string; process?: Record<string, unknown> };
      if ((frame.type === 'state' || frame.type === 'snapshot') && frame.process) states.push({ type: frame.type, process: frame.process });
    });
  });
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
  await page.route('**/api/native-process', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { commandId: string };
      Object.assign(evidence, { commandId: body.commandId, phase: 'web-command-registered-before-http-forward' });
      save();
    }
    await route.continue();
  });
  await page.goto(base + '/s/' + session.id);
  const open = async () => {
    await page.getByRole('button', { name: '原生控制', exact: true }).click();
    const panel = page.getByRole('region', { name: '原生控制', exact: true });
    await panel.locator('summary').filter({ hasText: /^原生进程终端$/ }).click();
    return panel.getByRole('region', { name: '原生进程终端', exact: true });
  };
  const surface = await open();
  // Wait for the real browser stream before producing the cap notification.
  // No native prompt, permission, cap, tool or timeout override is used.
  const program = 'import os,sys\nprint("READY_PID:"+str(os.getpid()),flush=True)\nsys.stdin.readline()\nsys.stdout.write("NATIVE_CAP_"+"x"*(2*1024*1024))\nsys.stdout.flush()\nsys.stdin.readline()';
  const command = ['python3', '-u', '-c', program];
  await surface.getByLabel('命令 argv 数组').fill(JSON.stringify(command));
  await surface.getByLabel('临时保留输出供下载（关闭时删除）').check();
  await surface.getByRole('button', { name: '启动原生命令', exact: true }).click();
  await until(() => typeof evidence['processId'] === 'string' && stdout().includes(Buffer.from('READY_PID:')), 'NOT_TRIGGERED: native process did not become ready');
  const id = evidence['processId'] as string;
  const get = async (): Promise<Record<string, unknown>> => {
    const response = await page.request.get(base + '/api/native-process/' + id);
    assert.ok(response.ok());
    return await response.json() as Record<string, unknown>;
  };
  const before = await get();
  assert.equal(before['nativeId'], session.nativeId);
  assert.equal(before['generation'], identity.generation);
  assert.equal(before['cwd'], workspacePath);
  assert.deepEqual(before['command'], command);
  assert.equal(before['outputTruncated'], false);
  evidence['commandPid'] = Number(stdout().toString('utf8').match(/READY_PID:(\d+)/)![1]);
  const terminal = surface.getByRole('region', { name: '原生交互终端', exact: true });
  await until(async () => (await terminal.getByRole('status').textContent())?.includes('已连接') === true, 'Native process browser stream not connected');
  assert.ok(states.some(frame => frame.type === 'snapshot' && frame.process['id'] === id && frame.process['outputTruncated'] === false));
  await terminal.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('CAP_TRIGGER');
  await page.keyboard.press('Enter');
  await until(() => deltas().some(delta => delta.capReached), 'NOT_TRIGGERED: actual native default output cap missing');
  await until(() => states.some(frame => frame.type === 'state' && frame.process['id'] === id && frame.process['state'] === 'running' && frame.process['outputTruncated'] === true), 'Native cap was not broadcast to the connected browser');
  await until(async () => (await terminal.getByRole('alert').textContent())?.includes('日志已截断') === true, 'Native cap warning missing');
  const capped = await get();
  assert.equal(capped['state'], 'running');
  assert.equal(capped['exitCode'], null);
  assert.equal(capped['outputTruncated'], true);
  const log = await page.request.get(base + '/api/native-process/' + id + '/log');
  assert.equal(log.headers()['x-webdcc-output-truncated'], 'true');
  const bytes = await log.body();
  assert.deepEqual(bytes, stdout());
  await page.screenshot({ path: report + '.running.png' });
  await page.reload();
  const restored = await open();
  const restoredTerminal = restored.getByRole('region', { name: '原生交互终端', exact: true });
  await until(async () => (await restoredTerminal.getByRole('alert').textContent())?.includes('日志已截断') === true, 'Refreshed native cap state missing');
  assert.equal(frames.filter(frame => frame.dir === 'out' && (frame.frame as { method?: string }).method === 'command/exec').length, 1);
  await restoredTerminal.getByRole('button', { name: '停止进程', exact: true }).click();
  await until(async () => (await get())['state'] === 'exited', 'Native process exit was not confirmed');
  const exited = await get();
  const result = frames.find(frame => {
    const value = frame.frame as { id?: unknown; method?: unknown; result?: unknown };
    return frame.dir === 'in' && value.method === undefined && value.id === evidence['nativeRequestId'] && value.result !== undefined;
  })?.frame as { result?: { exitCode: number } } | undefined;
  assert.ok(result?.result);
  assert.equal(exited['exitCode'], result.result.exitCode);
  assert.equal(exited['outputTruncated'], true);
  assert.equal(exited['confirmed'], true);
  assert.equal(frames.some(frame => frame.dir === 'out' && (frame.frame as { method?: string }).method === 'turn/start'), false);
  assert.deepEqual(errors, []);
  Object.assign(evidence, { passed: true, before, capped, exited, nativeResult: result.result,
    nativeCapCount: deltas().filter(delta => delta.capReached).length, retainedBytes: bytes.length,
    retainedLogSha256: createHash('sha256').update(bytes).digest('hex'), nativeStdoutSha256: createHash('sha256').update(stdout()).digest('hex'),
    refreshPreserved: true, nativeStarts: 1, newModelRequests: 0, browserErrors: errors });
  await restoredTerminal.getByRole('button', { name: '关闭并清除日志', exact: true }).click();
  await until(async () => !(await page.request.get(base + '/api/native-process/' + id)).ok(), 'Native process/log record did not close');
} catch (error) {
  evidence['error'] = String(error);
  evidence['phase'] = 'failed';
  process.exitCode = 1;
} finally {
  evidence['transportFrames'] = frames;
  evidence['browserStates'] = states;
  if (ctx && sessionId) evidence['storedEvents'] = ctx.store.allEvents(sessionId);
  if (ctx && typeof evidence['processId'] === 'string') {
    try {
      const path = '/api/native-process/' + evidence['processId'];
      const response = await ctx.app.inject({ method: 'GET', url: path, headers: { cookie: ctx.cookie } });
      if (response.statusCode === 200) {
        const view = response.json() as { generation: number; state: string };
        if (view.state !== 'exited') {
          const stopped = await ctx.app.inject({ method: 'POST', url: path + '/stop', headers: { cookie: ctx.cookie },
            payload: { generation: view.generation, commandId: runId + ':cleanup-stop' } });
          assert.equal(stopped.statusCode, 200, 'Own native process cleanup stop failed');
        }
        const closed = await ctx.app.inject({ method: 'DELETE', url: path + '?generation=' + view.generation + '&commandId=' + runId + ':cleanup-close', headers: { cookie: ctx.cookie } });
        assert.equal(closed.statusCode, 200, 'Own native process/log cleanup failed');
      }
    } catch (error) { cleanupErrors.push(String(error)); }
  }
  for (const close of [() => browser?.close(), () => ctx?.close()]) {
    try { await close(); } catch (error) { cleanupErrors.push(String(error)); }
  }
  const processes = async () => {
    const ids: number[] = [];
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      const env = await readFile('/proc/' + pid + '/environ').catch(() => Buffer.alloc(0));
      if (env.toString().split('\0').includes('CODEX_HOME=' + isolated.dirs.CODEX_HOME)) ids.push(Number(pid));
    }
    return ids;
  };
  const deadline = Date.now() + 5000;
  let alive = await processes();
  while (alive.length > 0 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); alive = await processes(); }
  if (alive.length) cleanupErrors.push('Own native profile processes remain: ' + alive.join(','));
  else await rm(isolated.dirs.root, { recursive: true, force: true });
  const fingerprint = sourceFingerprint();
  if (fingerprint !== evidence['sourceFingerprint']) cleanupErrors.push('Source changed during native verification');
  if (cleanupErrors.length) { evidence['passed'] = false; process.exitCode = 1; }
  Object.assign(evidence, { cleanupErrors, processesAfter: alive, finalSourceFingerprint: fingerprint, endedAt: new Date().toISOString() });
  save();
  process.stdout.write(JSON.stringify({ passed: evidence['passed'], error: evidence['error'], cleanupErrors, report }) + '\n');
}
