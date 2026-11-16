/** Actual official Codex with a local model fixture. This verifies native
 * plan parsing/notifications and production UI, not live Provider behavior. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import type { EventData, StoredEvent } from '../packages/protocol/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from '../browser-tests/helpers.js';
import { isolatedEnv } from '../packages/server/src/test-isolation.js';
import { startResponsesMock } from '../packages/testing/mock-models/src/responses-server.js';
import { sourceFingerprint } from './lib/gate-report.js';

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];
};
const binaryOption = option('--binary'); const reportOption = option('--report');
if (!binaryOption || !reportOption) throw new Error('Provide --binary and a private --report path.');
const binary = resolve(binaryOption); const report = resolve(reportOption);
const runId = randomUUID(); const clientCommandId = 'native-plan-' + runId;
const prompt = '制定一份两步工作计划。';
const fixtureText = '<proposed_plan>\n# 原生计划 😀\n\n1. 核对输入来源。\n2. 保留并验证原始结果。\n</proposed_plan>';
const evidence: Record<string, unknown> = { runId, kind: 'official-native-with-controlled-model-fixture',
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(),
  binary, binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
  clientCommandId, prompt, fixtureText, paidModelRequests: 0, phase: 'registered-before-native-start', passed: false,
  startedAt: new Date().toISOString() };
await mkdir(dirname(report), { recursive: true });
await writeFile(report, JSON.stringify(evidence, null, 2) + '\n');
const isolated = isolatedEnv({ PATH: process.env['PATH'] }, 'wdcc-native-plan');
evidence['isolatedRoot'] = isolated.dirs.root;
const workspacePath = join(isolated.dirs.root, 'workspace'); await mkdir(workspacePath);
let fixtureRequests = 0;
const mock = await startResponsesMock({ plan: [{ text: fixtureText, chunkDelayMs: 20 }], chunkSize: 3,
  recordPath: report + '.model.jsonl', beforeReply: () => { fixtureRequests++; }, log: () => undefined });
const overrides = ['model_provider=wdcc_plan_fixture', 'model="mock-responses-1"',
  'model_providers.wdcc_plan_fixture.name="WebDCC plan fixture"',
  'model_providers.wdcc_plan_fixture.base_url="' + mock.url + '/v1"',
  'model_providers.wdcc_plan_fixture.wire_api="responses"',
  'model_providers.wdcc_plan_fixture.env_key="WDCC_PLAN_FIXTURE_KEY"'];
const adapter = new CodexAdapter({ command: binary, configOverrides: overrides,
  env: { ...isolated.env, WDCC_PLAN_FIXTURE_KEY: 'isolated-fixture-value' } });
let ctx: Awaited<ReturnType<typeof createSourceTestApp>> | undefined; let browser: Browser | undefined;
let sessionId: string | undefined;
const cleanupErrors: string[] = []; const browserErrors: string[] = [];
async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 25)); }
}
try {
  const probe = await adapter.probe(); assert.equal(probe.compatible, true);
  evidence['nativeVersion'] = probe.version;
  evidence['configurationFingerprint'] = createHash('sha256').update(JSON.stringify({ overrides, accessMode: 'read-only', collaborationMode: 'plan' })).digest('hex');
  ctx = await createSourceTestApp(); ctx.manager.registerAdapter(adapter);
  const workspace = ctx.store.createWorkspace('Native plan verification', workspacePath);
  const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex', accessMode: 'read-only' });
  sessionId = session.id;
  Object.assign(evidence, { sessionId, nativeId: session.nativeId, phase: 'native-created-before-input' });
  await writeFile(report, JSON.stringify(evidence, null, 2) + '\n');
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const address = ctx.app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
  await page.goto(base + '/s/' + session.id);
  await ctx.manager.send(session.id, { text: prompt, contentParts: { version: 1, collaborationMode: 'plan', parts: [{ type: 'text', text: prompt }] } }, clientCommandId);
  await until(() => ctx!.store.allEvents(session.id).some(event => event.kind === 'turn.completed'), 'NOT_TRIGGERED: native plan turn never completed');
  const stored = ctx.store.allEvents(session.id).filter(event => event.kind === 'plan' && (event.data as EventData['plan']).text !== undefined);
  assert.equal(stored.length, 1, 'NOT_TRIGGERED: expected one native completed plan');
  const final = stored[0]!; const original = final.native as { type?: string; id?: string; text?: string };
  assert.equal(original.type, 'plan'); assert.equal(final.itemKey, original.id);
  assert.equal((final.data as EventData['plan']).text, original.text);
  assert.equal((final.data as EventData['plan']).incomplete, false);
  assert.ok(original.text?.includes('原生计划 😀')); assert.ok(final.turnId);
  const nativeFrames = ctx.store.nativeEvents.list(session.id, 0, 1000).map(summary => ctx!.store.nativeEvents.get(summary.id)!);
  const deltas = nativeFrames.filter(frame => frame.source === 'transport' && (frame.payload as { method?: string }).method === 'item/plan/delta');
  assert.ok(deltas.length > 0, 'NOT_TRIGGERED: official CLI did not emit plan deltas');
  assert.ok(deltas.every(frame => frame.nativeTurnId !== null), 'native delta turn identity missing');
  await page.locator('.turn-summary').first().click();
  const text = page.getByTestId('native-plan-text');
  await text.waitFor({ timeout: 10_000 }); assert.equal(await text.count(), 1);
  assert.equal(await text.getAttribute('data-raw-text'), original.text);
  await page.screenshot({ path: report + '.before-refresh.png', fullPage: true });
  await page.reload(); await page.locator('.turn-summary').first().click();
  await text.waitFor({ timeout: 10_000 }); assert.equal(await text.getAttribute('data-raw-text'), original.text);
  await page.screenshot({ path: report + '.after-refresh.png', fullPage: true });
  assert.deepEqual(browserErrors, []);
  Object.assign(evidence, { nativeDeltaCount: deltas.length, nativeFrames, storedPlan: final,
    browserRefreshPreservedText: true, browserSinglePlan: true, browserErrors, passed: true, phase: 'verified' });
} catch (error) {
  evidence['error'] = error instanceof Error ? error.message : String(error); evidence['phase'] = 'failed'; process.exitCode = 1;
  if (ctx && sessionId) {
    evidence['storedEvents'] = ctx.store.allEvents(sessionId) as StoredEvent[];
    evidence['nativeFrames'] = ctx.store.nativeEvents.list(sessionId, 0, 1000).map(summary => ctx!.store.nativeEvents.get(summary.id)!);
  }
} finally {
  for (const close of [() => browser?.close(), () => ctx?.close(), () => mock.close(), () => rm(isolated.dirs.root, { recursive: true, force: true })]) {
    try { await close(); } catch (error) { cleanupErrors.push(String(error)); }
  }
  Object.assign(evidence, { fixtureRequests, browserErrors, cleanupErrors, endedAt: new Date().toISOString(), finalSourceFingerprint: sourceFingerprint() });
  if (cleanupErrors.length > 0) { evidence['passed'] = false; process.exitCode = 1; }
  await writeFile(report, JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ passed: evidence['passed'], error: evidence['error'], fixtureRequests, cleanupErrors, report }) + '\n');
}
