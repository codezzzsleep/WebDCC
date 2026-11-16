/** Official CLI + unchanged native prompts/tools + controlled local model. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import type { NativeEnvelopeDetail } from '../packages/protocol/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from '../browser-tests/helpers.js';
import { isolatedEnv } from '../packages/server/src/test-isolation.js';
import { startResponsesMock } from '../packages/testing/mock-models/src/responses-server.js';
import { sourceFingerprint } from './lib/gate-report.js';

const option = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const binaryOption = option('--binary'); const reportOption = option('--report');
if (!binaryOption || !reportOption) throw new Error('Provide --binary and a new private --report.');
const binary = resolve(binaryOption); const report = resolve(reportOption); const runId = randomUUID();
const expectedSummary = 'Native visible summary 😀'; const expectedContent = ['\t原生正文 😀\n', '', 'Third original body\n'];
const evidence: Record<string, unknown> = { runId, kind: 'official-native-reasoning-body-controlled-model', passed: false,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(),
  binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'), expectedSummary, expectedContent,
  newPaidRequests: 0, phase: 'registered-before-native-start' };
await mkdir(dirname(report), { recursive: true }); await writeFile(report, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const isolated = isolatedEnv({ PATH: process.env['PATH'] }, 'wdcc-native-body'); const workspacePath = join(isolated.dirs.root, 'workspace'); await mkdir(workspacePath);
let requests = 0;
const mock = await startResponsesMock({ plan: [{ thinking: expectedSummary, reasoningContent: expectedContent, text: 'Native body finished.', chunkDelayMs: 10 }],
  chunkSize: 4, beforeReply: async () => { requests++; }, recordPath: report + '.model.jsonl', log: () => undefined });
const overrides = ['model_provider=wdcc_body_fixture', 'model="mock-responses-1"', 'model_providers.wdcc_body_fixture.name="Reasoning fixture"',
  'model_providers.wdcc_body_fixture.base_url="' + mock.url + '/v1"', 'model_providers.wdcc_body_fixture.wire_api="responses"', 'model_providers.wdcc_body_fixture.env_key="WDCC_BODY_FIXTURE_KEY"'];
const adapter = new CodexAdapter({ command: binary, configOverrides: overrides, env: { ...isolated.env, WDCC_BODY_FIXTURE_KEY: 'isolated-fixture-value' } });
let ctx: Awaited<ReturnType<typeof createSourceTestApp>> | undefined; let browser: Browser | undefined; let sessionId: string | undefined;
const cleanupErrors: string[] = [];
async function until(predicate: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 30_000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 30)); }
}
try {
  const probe = await adapter.probe(); assert.equal(probe.compatible, true); evidence['nativeVersion'] = probe.version;
  ctx = await createSourceTestApp(); ctx.manager.registerAdapter(adapter);
  const workspace = ctx.store.createWorkspace('Official native reasoning body', workspacePath);
  const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex', accessMode: 'read-only' }); sessionId = session.id;
  const commandId = runId + ':body'; Object.assign(evidence, { sessionId, nativeId: session.nativeId, commandId, workspacePath, isolatedRoot: isolated.dirs.root,
    configurationFingerprint: createHash('sha256').update(JSON.stringify({ overrides, accessMode: 'read-only' })).digest('hex'), phase: 'native-created-before-input' });
  await writeFile(report, JSON.stringify(evidence, null, 2) + '\n');
  await ctx.manager.send(session.id, { text: 'Reply with the configured fixture response.' }, commandId);
  await until(() => ctx!.store.allEvents(session.id).some(event => event.kind === 'turn.completed'), 'NOT_TRIGGERED: native turn did not complete');
  const frames: NativeEnvelopeDetail[] = []; let cursor = 0;
  for (;;) { const page = ctx.store.nativeEvents.list(session.id, cursor, 100); frames.push(...page.map(row => ctx!.store.nativeEvents.get(row.id)!)); if (page.length < 100) break; cursor = page.at(-1)!.id; }
  const deltas = frames.filter(frame => frame.source === 'transport' && (frame.payload as { method?: string }).method === 'item/reasoning/textDelta');
  assert.ok(deltas.length > 0, 'NOT_TRIGGERED: actual native textDelta missing');
  const native = frames.find(frame => { const value = frame.payload as { method?: string; params?: { item?: { type: string } } }; return frame.source === 'transport' && value.method === 'item/completed' && value.params?.item?.type === 'reasoning'; });
  assert.ok(native, 'NOT_TRIGGERED: native completed reasoning missing');
  const params = (native.payload as { params: { turnId: string; item: { id: string; summary: string[]; content: string[] } } }).params;
  assert.deepEqual(params.item.summary, [expectedSummary]); assert.deepEqual(params.item.content, expectedContent);
  assert.ok(deltas.every(frame => (frame.payload as { params: { turnId: string; itemId: string } }).params.turnId === params.turnId
    && (frame.payload as { params: { itemId: string } }).params.itemId === params.item.id));
  const stored = ctx.store.allEvents(session.id).find(event => event.kind === 'reasoning' && event.itemKey === params.item.id);
  assert.ok(stored); assert.equal((stored.data as { text: string }).text, expectedSummary);
  assert.deepEqual((stored.data as { nativeContent: unknown }).nativeContent, expectedContent.map((text, index) => ({ index, text })));
  await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address(); assert.ok(address && typeof address !== 'string'); const base = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]); await page.goto(base + '/s/' + session.id);
  const verify = async () => {
    await page.locator('.turn-title').first().click(); await page.getByRole('button', { name: '思考', exact: true }).click();
    await page.getByTestId('native-reasoning-content').locator('summary').click();
    const body = await page.getByTestId('native-reasoning-part').evaluateAll(elements => elements.map(element => element.getAttribute('data-raw-text')));
    assert.deepEqual(body, params.item.content); assert.ok((await page.locator('.turn').textContent())?.includes(expectedSummary));
  };
  await verify(); await page.reload(); await verify();
  assert.equal(requests, 1); Object.assign(evidence, { passed: true, phase: 'verified', nativeDeltaCount: deltas.length,
    capturedEnvelopes: frames.length, transportRpcCount: frames.filter(frame => frame.source === 'transport' && frame.channel === 'rpc').length,
    nativeFrames: frames, originalNativeReasoning: params, storedReasoning: stored, refreshPreserved: true });
} catch (error) {
  evidence['error'] = String(error); evidence['phase'] = 'failed'; process.exitCode = 1;
  if (ctx && sessionId) { evidence['storedEvents'] = ctx.store.allEvents(sessionId); evidence['nativeFrames'] = ctx.store.nativeEvents.list(sessionId, 0, 1000).map(row => ctx!.store.nativeEvents.get(row.id)!); }
} finally {
  for (const close of [() => browser?.close(), () => ctx?.close(), () => mock.close()]) { try { await close(); } catch (error) { cleanupErrors.push(String(error)); } }
  const profileProcesses = async () => { const found: number[] = []; for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue; const env = await readFile('/proc/' + pid + '/environ').catch(() => Buffer.alloc(0));
    if (env.toString().split('\0').includes('CODEX_HOME=' + isolated.dirs.CODEX_HOME)) found.push(Number(pid));
  } return found; };
  const deadline = Date.now() + 5000; let processes = await profileProcesses();
  while (processes.length > 0 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); processes = await profileProcesses(); }
  if (processes.length > 0) cleanupErrors.push('Own native processes remain: ' + processes.join(','));
  else await rm(isolated.dirs.root, { recursive: true, force: true });
  if (cleanupErrors.length) { evidence['passed'] = false; process.exitCode = 1; }
  Object.assign(evidence, { requests, cleanupErrors, processesAfter: processes, finalSourceFingerprint: sourceFingerprint(), endedAt: new Date().toISOString() });
  await writeFile(report, JSON.stringify(evidence, null, 2) + '\n'); process.stdout.write(JSON.stringify({ passed: evidence['passed'], error: evidence['error'], requests, cleanupErrors, report }) + '\n');
}
