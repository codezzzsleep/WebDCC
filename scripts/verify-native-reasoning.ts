/** Actual pinned Codex transports nonempty scripted reasoning summaries.
 * The direct RPC reference is independent of the WebDCC projection. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAdapter, PINNED_VERSION } from '../packages/adapters/codex/src/adapter.js';
import { JsonRpcStdio, type Frame } from '../packages/adapters/codex/src/rpc.js';
import { createSourceTestApp } from '../browser-tests/helpers.js';
import { isolatedEnv } from '../packages/server/src/test-isolation.js';
import { startResponsesMock } from '../packages/testing/mock-models/src/responses-server.js';
import { sourceFingerprint } from './lib/gate-report.js';
import { chromium, type Browser } from '@playwright/test';

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];
};
const binaryArgument = option('--binary');
if (!binaryArgument) throw new Error('需要 --binary 指定隔离的 Codex 0.167.0');
const binary = resolve(binaryArgument);
const report = resolve(option('--report') ?? 'web_review/evidence/native-reasoning-current.json');
const isolated = isolatedEnv({ PATH: process.env['PATH'] }, 'wdcc-native-reasoning');
const workspacePath = join(isolated.dirs.root, 'workspace'); await mkdir(workspacePath);
const expected = '先核对文件来源。\nThen verify the original bytes and result.';
const answer = 'Native reasoning verified.';
const mock = await startResponsesMock({ plan: [{ thinking: expected, text: answer, chunkDelayMs: 15 }], chunkSize: 4, log: () => undefined });
const overrides = ['model_provider=wdcc_mock', 'model="mock-responses-1"', 'model_reasoning_summary="concise"',
  'model_providers.wdcc_mock.name="WDCC mock"', `model_providers.wdcc_mock.base_url="${mock.url}/v1"`,
  'model_providers.wdcc_mock.wire_api="responses"', 'model_providers.wdcc_mock.env_key="WDCC_MOCK_KEY"'];
const env = { ...isolated.env, WDCC_MOCK_KEY: 'isolated-fixture-value' };
const ctx = await createSourceTestApp(); let rpc: JsonRpcStdio | undefined; let browser: Browser | undefined;
const hash = createHash('sha256'); for await (const chunk of createReadStream(binary)) hash.update(chunk);
const evidence: Record<string, unknown> = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(),
  kind: 'pinned-native-reasoning-with-direct-rpc-and-web-reference', baseline: PINNED_VERSION,
  nativeBinarySha256: hash.digest('hex'), schemaFingerprint: ctx.store.nativeEvents.schemaHash,
  environment: { os: platform(), arch: arch(), node: process.version }, paidModel: false, passed: false,
  configurationFingerprint: createHash('sha256').update(JSON.stringify({ overrides, expected })).digest('hex'),
  startedAt: new Date().toISOString(),
};
async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 30)); }
}
try {
  const adapter = new CodexAdapter({ command: binary, configOverrides: overrides, env });
  assert.equal((await adapter.probe()).version, PINNED_VERSION);
  const direct: Frame[] = [];
  rpc = JsonRpcStdio.start({ command: binary, args: ['app-server', ...overrides.flatMap(value => ['-c', value])], env, cwd: workspacePath });
  rpc.onNotification(frame => direct.push(frame));
  await rpc.request('initialize', { clientInfo: { name: 'reasoning-reference', version: '1' }, capabilities: null }); rpc.notify('initialized');
  const created = await rpc.request('thread/start', { cwd: workspacePath }) as { thread: { id: string } };
  await rpc.request('turn/start', { threadId: created.thread.id, input: [{ type: 'text', text: 'Return the scripted summary.', text_elements: [] }] });
  await until(() => direct.some(frame => frame['method'] === 'turn/completed'), 'NOT_TRIGGERED: direct native turn did not complete');
  const reference = direct.filter(frame => frame['method'] === 'item/completed').map(frame => (frame['params'] as { item: { type: string; summary?: string[] } }).item).find(item => item.type === 'reasoning');
  assert.deepEqual(reference?.summary, [expected], 'NOT_TRIGGERED: native reasoning summary was empty or changed');
  assert.ok(direct.some(frame => frame['method'] === 'item/reasoning/summaryTextDelta'), 'NOT_TRIGGERED: native summary never streamed');
  await rpc.kill(); rpc = undefined;

  ctx.manager.registerAdapter(adapter);
  const workspace = ctx.store.createWorkspace('Native reasoning', workspacePath);
  const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const address = ctx.app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
  await page.goto(`${base}/s/${session.id}`);
  await ctx.manager.send(session.id, { text: 'Return the scripted summary.' }, 'reasoning-input');
  await until(() => ctx.store.allEvents(session.id).some(event => event.kind === 'turn.completed'), 'native Web turn did not complete');
  const stored = ctx.store.allEvents(session.id).find(event => event.kind === 'reasoning');
  assert.ok(stored, 'NOT_TRIGGERED: Web projection has no reasoning');
  assert.equal((stored.data as { text: string }).text, reference.summary!.join('\n'));
  assert.ok(stored.turnId, 'reasoning lost its public turn identity');
  await page.locator('.turn-summary').first().click();
  await page.getByText('思考', { exact: true }).first().waitFor({ timeout: 10_000 });
  const reasoningText = page.getByText(expected, { exact: true });
  if (await reasoningText.count() === 0) await page.getByText('思考', { exact: true }).first().click();
  await reasoningText.waitFor({ timeout: 10_000 });
  assert.equal(await reasoningText.textContent(), expected);
  await page.reload();
  await page.locator('.turn-summary').first().click();
  if (await reasoningText.count() === 0) await page.getByText('思考', { exact: true }).first().click();
  await reasoningText.waitFor({ timeout: 10_000 });
  assert.equal(await reasoningText.textContent(), expected);

  const frames = []; let cursor = 0;
  for (;;) {
    const batch = ctx.store.nativeEvents.list(session.id, cursor, 100);
    frames.push(...batch.map(record => ctx.store.nativeEvents.get(record.id)!));
    if (batch.length < 100) break; cursor = batch.at(-1)!.id;
  }
  const deltas = frames.filter(record => record.source === 'transport' && (record.payload as { method?: string }).method === 'item/reasoning/summaryTextDelta');
  assert.ok(deltas.length > 0, 'native summary input was not captured');
  assert.ok(deltas.every(record => record.nativeTurnId !== null), 'captured summary lost native turn identity');
  evidence['directSummary'] = reference.summary;
  evidence['directDeltaFrames'] = direct.filter(frame => frame['method'] === 'item/reasoning/summaryTextDelta').length;
  evidence['capturedNativeDeltaFrames'] = deltas.length;
  evidence['webReasoning'] = stored;
  evidence['browserRefreshPreservedText'] = true;
  evidence['passed'] = true;
} catch (error) {
  evidence['error'] = error instanceof Error ? error.message : String(error);
  evidence['events'] = ctx.store.listSessions(true).map(session => ({ sessionId: session.id, events: ctx.store.allEvents(session.id) }));
  process.exitCode = 1;
} finally {
  await browser?.close(); await rpc?.kill(); await ctx.close(); await mock.close();
  await rm(isolated.dirs.root, { recursive: true, force: true });
  evidence['endedAt'] = new Date().toISOString(); evidence['finalSourceFingerprint'] = sourceFingerprint();
  await mkdir(resolve(report, '..'), { recursive: true }); await writeFile(report, JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ passed: evidence['passed'], error: evidence['error'], report }) + '\n');
}
