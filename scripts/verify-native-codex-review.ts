/** Official native Review, source controls and real Git targets with a local
 * model fixture. Native instructions, tools and permissions are unchanged. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import type { EventData, NativeEnvelopeDetail, StoredEvent } from '../packages/protocol/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from '../browser-tests/helpers.js';
import { isolatedEnv } from '../packages/server/src/test-isolation.js';
import { startResponsesMock } from '../packages/testing/mock-models/src/responses-server.js';
import { sourceFingerprint } from './lib/gate-report.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];
}
const binaryOption = option('--binary'); const reportOption = option('--report');
if (!binaryOption || !reportOption) throw new Error('Provide --binary and a private --report path.');
const binary = resolve(binaryOption); const report = resolve(reportOption); const runId = randomUUID();
const evidence: Record<string, unknown> = { runId, kind: 'official-native-review-with-controlled-local-model', passed: false,
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(),
  binary, binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'), paidModelRequests: 0,
  actions: [], phase: 'registered-before-native-start', startedAt: new Date().toISOString() };
await mkdir(dirname(report), { recursive: true }); await writeFile(report, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const isolated = isolatedEnv({ PATH: process.env['PATH'] }, 'wdcc-native-review');
const workspacePath = join(isolated.dirs.root, 'workspace'); await mkdir(workspacePath);
const git = (...args: string[]) => execFileSync('git', args, { cwd: workspacePath, encoding: 'utf8' }).trim();
git('init', '-b', 'main'); git('config', 'user.email', 'native-fixture@example.invalid'); git('config', 'user.name', 'Native fixture');
await writeFile(join(workspacePath, 'README.md'), '# Base\n'); git('add', 'README.md'); git('commit', '-m', 'Native review baseline');
git('branch', 'review-baseline'); await writeFile(join(workspacePath, 'README.md'), '# Commit target\n');
git('add', 'README.md'); git('commit', '-m', 'Native commit review'); const sha = git('rev-parse', 'HEAD');
await writeFile(join(workspacePath, 'README.md'), '# Uncommitted target\n');
const fixture = { findings: [{ title: '[P2] Controlled native finding', body: 'Original native formatted Review body.', confidence_score: 0.95,
  code_location: { absolute_file_path: join(workspacePath, 'README.md'), line_range: { start: 1, end: 1 } }, priority: 2 }],
  overall_correctness: 'patch is incorrect', overall_explanation: 'Controlled fixture output.', overall_confidence_score: 0.95 };
let fixtureRequests = 0; let holdNext = false; let held = false; let releaseHeld!: () => void;
const heldReply = new Promise<void>(resolve => { releaseHeld = resolve; });
const mock = await startResponsesMock({ plan: [{ text: JSON.stringify(fixture), chunkDelayMs: 10 }], chunkSize: 20,
  recordPath: report + '.model.jsonl', log: () => undefined,
  beforeReply: async () => { fixtureRequests++; if (holdNext) { held = true; await heldReply; } } });
const overrides = ['model_provider=wdcc_review_fixture', 'model="mock-responses-1"',
  'model_providers.wdcc_review_fixture.name="WebDCC Review fixture"',
  'model_providers.wdcc_review_fixture.base_url="' + mock.url + '/v1"',
  'model_providers.wdcc_review_fixture.wire_api="responses"', 'model_providers.wdcc_review_fixture.env_key="WDCC_REVIEW_FIXTURE_KEY"'];
const adapter = new CodexAdapter({ command: binary, configOverrides: overrides,
  env: { ...isolated.env, WDCC_REVIEW_FIXTURE_KEY: 'isolated-fixture-value' } });
let ctx: Awaited<ReturnType<typeof createSourceTestApp>> | undefined; let browser: Browser | undefined; let sessionId: string | undefined;
const actions = evidence['actions'] as Record<string, unknown>[]; const cleanupErrors: string[] = []; const browserErrors: string[] = [];
async function until(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 30)); }
}
const marker = (event: StoredEvent) => (event.native as { type?: string; review?: string } | undefined)?.type === 'exitedReviewMode';
try {
  const probe = await adapter.probe(); assert.equal(probe.compatible, true); evidence['nativeVersion'] = probe.version;
  Object.assign(evidence, { isolatedRoot: isolated.dirs.root, workspacePath, gitHead: sha, gitStatus: git('status', '--porcelain'),
    configurationFingerprint: createHash('sha256').update(JSON.stringify({ overrides, accessMode: 'read-only', targets: ['uncommittedChanges', 'baseBranch', 'commit'] })).digest('hex') });
  ctx = await createSourceTestApp(); ctx.manager.registerAdapter(adapter);
  const workspace = ctx.store.createWorkspace('Native Review proof', workspacePath);
  const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex', accessMode: 'read-only' }); sessionId = session.id;
  Object.assign(evidence, { sessionId, nativeId: session.nativeId, nativeProcess: ctx.store.nativeOwners.managedProcess(session.id), phase: 'native-created-before-input' });
  await writeFile(report, JSON.stringify(evidence, null, 2) + '\n');
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const address = ctx.app.server.address(); assert.ok(address && typeof address !== 'string'); const base = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); page.on('pageerror', error => browserErrors.push(error.message));
  await page.route('**/api/sessions/*/native/actions', async route => {
    const body = route.request().postDataJSON() as { commandId: string; action: unknown };
    const action = actions.at(-1); assert.ok(action, 'Native action was not registered');
    Object.assign(action, { commandId: body.commandId, submittedAction: body.action });
    await writeFile(report, JSON.stringify(evidence, null, 2) + '\n');
    await route.continue();
  });
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]); await page.goto(base + '/s/' + session.id);
  await page.getByRole('button', { name: '原生控制', exact: true }).click();
  const panel = page.getByRole('region', { name: '原生控制', exact: true });
  const targets = [{ type: 'uncommittedChanges' }, { type: 'baseBranch', branch: 'review-baseline' }, { type: 'commit', sha, title: null }] as const;
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!; const action = { identity: runId + ':' + target.type, target, phase: 'registered-before-click' };
    actions.push(action); await writeFile(report, JSON.stringify(evidence, null, 2) + '\n');
    await panel.getByRole('button', { name: '刷新原生状态', exact: true }).click();
    await panel.getByLabel('原生操作').selectOption('review'); await panel.getByLabel('Review 目标').selectOption(target.type);
    if (target.type === 'baseBranch') await panel.getByLabel('基线分支', { exact: true }).fill(target.branch);
    if (target.type === 'commit') await panel.getByLabel('Commit SHA', { exact: true }).fill(target.sha);
    await panel.getByRole('button', { name: '提交启动原生 Review' }).click();
    await until(() => ctx!.store.allEvents(session.id).filter(marker).length >= index + 1, 'NOT_TRIGGERED: original native Review marker missing');
    const original = ctx.store.allEvents(session.id).filter(marker)[index]!;
    await until(() => ctx!.store.allEvents(session.id).some(event => event.turnId === original.turnId && event.kind === 'turn.completed'), 'Native Review turn never completed');
    const native = original.native as { review: string }; assert.ok(native.review.includes('Controlled native finding'), 'NOT_TRIGGERED: native formatted fixture finding missing');
    const shown = page.getByTestId('codex-review-result').nth(index); await shown.waitFor({ timeout: 10_000 }); assert.equal(await shown.getAttribute('data-raw-text'), native.review);
    const state = (await ctx.manager.nativeControls(session.id, true)).state as { thread: { cwd: string } };
    assert.equal(state.thread.cwd, workspacePath);
    Object.assign(action, { phase: 'verified', turnId: original.turnId, itemKey: original.itemKey, nativeResult: original.native });
    await writeFile(report, JSON.stringify(evidence, null, 2) + '\n');
  }
  await until(async () => await page.getByTestId('assistant-message').count() === 0, 'Native final Review copy was duplicated');
  await page.screenshot({ path: report + '.results.png', fullPage: true }); await page.reload();
  for (let index = 0; index < 3; index++) { const shown = page.getByTestId('codex-review-result').nth(index); await shown.waitFor({ timeout: 10_000 }); assert.equal(await shown.getAttribute('data-raw-text'), (ctx.store.allEvents(session.id).filter(marker)[index]!.native as { review: string }).review); }
  await page.getByRole('button', { name: '原生控制', exact: true }).click();
  await panel.getByRole('button', { name: '刷新原生状态', exact: true }).click();
  await panel.getByLabel('原生操作').selectOption('review');
  holdNext = true; actions.push({ identity: runId + ':stop', target: targets[0], phase: 'registered-before-click', expected: 'interrupted' });
  await writeFile(report, JSON.stringify(evidence, null, 2) + '\n');
  await panel.getByRole('button', { name: '提交启动原生 Review' }).click(); await until(() => held, 'NOT_TRIGGERED: stop fixture request not active');
  const active = await adapter.nativeState(session.id) as { activeTurnId: string; review: { rootTurnId: string; executionTurnId: string } };
  assert.ok(active.activeTurnId); assert.ok(active.review.rootTurnId); assert.equal(active.activeTurnId, active.review.executionTurnId);
  assert.notEqual(active.review.rootTurnId, active.activeTurnId);
  evidence['activeNativeReview'] = active.review;
  evidence['stoppedNativeTurnId'] = active.activeTurnId; await page.reload();
  await page.getByTestId('stop-button').click();
  await until(() => ctx!.store.allEvents(session.id).some(event => event.kind === 'turn.completed' && (event.data as EventData['turn.completed']).status === 'interrupted'), 'NOT_TRIGGERED: actual native stop was not confirmed');
  releaseHeld(); await until(() => ctx!.manager.getRuntime(session.id)?.status === 'idle', 'Native Review stop did not settle');
  Object.assign(actions.at(-1)!, { phase: 'native-interrupted', nativeTurnId: active.activeTurnId });
  const records: NativeEnvelopeDetail[] = []; let cursor = 0;
  for (;;) { const batch = ctx.store.nativeEvents.list(session.id, cursor, 100); records.push(...batch.map(record => ctx!.store.nativeEvents.get(record.id)!)); if (batch.length < 100) break; cursor = batch.at(-1)!.id; }
  const reviewRequests = records.filter(record => record.source === 'transport' && (record.payload as { method?: string }).method === 'review/start');
  assert.equal(reviewRequests.length, 4); assert.deepEqual(reviewRequests.slice(0, 3).map(record => (record.payload as { params: { target: unknown } }).params.target), targets);
  const stopRequests = records.filter(record => record.source === 'transport' && (record.payload as { method?: string }).method === 'turn/interrupt');
  assert.ok(stopRequests.some(record => (record.payload as { params: { turnId?: string } }).params.turnId === active.activeTurnId));
  const starts = records.filter(record => record.source === 'transport' && (record.payload as { method?: string }).method === 'turn/started');
  for (let index = 0; index < 3; index++) {
    const request = reviewRequests[index]!.payload as { id: string | number };
    const accepted = records.find(record => { const value = record.payload as { id?: string | number; result?: unknown }; return record.direction === 'in' && value.id === request.id && value.result !== undefined; });
    assert.ok(accepted, 'Original native Review acceptance response missing');
    const root = (accepted.payload as { result: { turn: { id: string }; reviewThreadId: string } }).result;
    assert.equal(root.reviewThreadId, session.nativeId);
    const execution = starts.find(record => (record.payload as { params: { turn: { rootTurnId: string } } }).params.turn.rootTurnId === root.turn.id);
    assert.ok(execution, 'Original native Review execution relation missing');
    Object.assign(actions[index]!, { nativeRootTurnId: root.turn.id, nativeExecutionTurnId: (execution.payload as { params: { turn: { id: string } } }).params.turn.id });
  }
  assert.deepEqual(browserErrors, []);
  Object.assign(evidence, { phase: 'verified', passed: true, nativeFrames: records, originalMarkers: ctx.store.allEvents(session.id).filter(marker),
    reviewRequestCount: reviewRequests.length, exactTargetsPreserved: true, refreshPreservedResults: true, identicalFinalCopiesSuppressed: true, stopConfirmed: true });
} catch (error) {
  evidence['error'] = error instanceof Error ? error.message : String(error); evidence['phase'] = 'failed'; process.exitCode = 1;
  if (ctx && sessionId) { evidence['storedEvents'] = ctx.store.allEvents(sessionId); evidence['nativeFrames'] = ctx.store.nativeEvents.list(sessionId, 0, 1000).map(record => ctx!.store.nativeEvents.get(record.id)!); }
} finally {
  releaseHeld();
  for (const close of [() => browser?.close(), () => ctx?.close(), () => mock.close()]) { try { await close(); } catch (error) { cleanupErrors.push(String(error)); } }
  const profileProcesses = async (): Promise<number[]> => {
    const pids: number[] = [];
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      const environment = await readFile('/proc/' + pid + '/environ').catch(() => Buffer.alloc(0));
      if (environment.toString().split('\0').includes('CODEX_HOME=' + isolated.dirs.CODEX_HOME)) pids.push(Number(pid));
    }
    return pids;
  };
  const cleanupSamples = []; const deadline = Date.now() + 5000;
  let processesAfter = await profileProcesses();
  cleanupSamples.push({ at: new Date().toISOString(), pids: processesAfter });
  while (processesAfter.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50)); processesAfter = await profileProcesses();
    cleanupSamples.push({ at: new Date().toISOString(), pids: processesAfter });
  }
  if (processesAfter.length > 0) cleanupErrors.push('Own native profile still has running processes: ' + processesAfter.join(','));
  else await rm(isolated.dirs.root, { recursive: true, force: true }).catch(error => cleanupErrors.push(String(error)));
  const profileDirectoryExists = await access(isolated.dirs.root).then(() => true, () => false);
  if (profileDirectoryExists) cleanupErrors.push('Own profile directory still exists');
  Object.assign(evidence, { fixtureRequests, browserErrors, cleanupErrors, cleanupSamples, processesAfter, profileDirectoryExists, endedAt: new Date().toISOString(), finalSourceFingerprint: sourceFingerprint() });
  if (cleanupErrors.length > 0) { evidence['passed'] = false; evidence['phase'] = 'cleanup-failed'; process.exitCode = 1; }
  await writeFile(report, JSON.stringify(evidence, null, 2) + '\n'); process.stdout.write(JSON.stringify({ passed: evidence['passed'], error: evidence['error'], fixtureRequests, cleanupErrors, report }) + '\n');
}
