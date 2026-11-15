/**
 * Continue UI/native recovery checks using an existing real capture.
 * No send/answer/approve operation is issued, and original evidence is immutable.
 * node scripts/recover-deployed-trajectory.mjs <config.json> <captured-report.json>
 */
import assert from 'node:assert/strict';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { URL, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const [configFile, sourceFile] = process.argv.slice(2);
const config = JSON.parse(await readFile(configFile, 'utf8'));
const sourceBytes = await readFile(sourceFile);
const source = JSON.parse(sourceBytes.toString());
assert(source.sessionId && source.nativeId && source.live, 'An actual captured native session is required');
const root = dirname(sourceFile);
const evidenceRoot = config.recoveryOut ?? root;
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const release = await realpath(config.release ?? source.deployment.release);
const expectedCommit = config.expectedCommit ?? source.deployment.commit;
const sha = value => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(await readFile(join(release, 'manifest.json'), 'utf8'));
assert.equal(manifest.commit, expectedCommit, 'Target release commit mismatch');
for (const [path, digest] of Object.entries(manifest.sha256)) {
  assert.equal(sha(await readFile(join(release, path))), digest, 'Target artifact changed: ' + path);
}
const deployment = { release, commit: manifest.commit, sourceFingerprint: manifest.sourceFingerprint };
Object.assign(process.env, {
  HOME: join(root, 'profile'), CODEX_HOME: join(root, 'profile/codex'),
  CLAUDE_CONFIG_DIR: join(root, 'profile/claude'), DSH_HOME: join(root, 'profile/dsh'),
  XDG_CACHE_HOME: join(root, 'profile/cache'), XDG_CONFIG_HOME: join(root, 'profile/xdg'),
  PLAYWRIGHT_BROWSERS_PATH: config.browserCache,
  WDCC_ENABLE_CODEX: source.agent === 'codex' ? '1' : '0',
  WDCC_ENABLE_CLAUDE: source.agent === 'claude-code' ? '1' : '0',
  WDCC_ENABLE_DSH: source.agent === 'dsh' ? '1' : '0',
  WDCC_DSH_MODE: 'spawn', WDCC_DSH_PORT: '0', WDCC_TRACE: '1', WDCC_TEST_HOOKS: '0',
  WDCC_COMMIT: expectedCommit, WDCC_BUILT_AT: manifest.builtAt,
});
for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','OPENAI_API_KEY']) delete process.env[key];
const { start } = await import(pathToFileURL(join(release, 'packages/server/dist/main.js')).href);
const { chromium } = await import(pathToFileURL(config.playwrightModule).href);
const serverConfig = { host: '127.0.0.1', port: 0, token: randomUUID()+randomUUID(),
  dataDir: join(root, 'data'), dshPort: 0, idleDisposeMin: 0, version: 'captured-native-recovery', recordInteractions: true };
const report = { mode: 'target-platform continuation of existing real native session', agent: source.agent,
  sourceReportSha256: sha(sourceBytes), originalStatus: source.status, captureDeployment: source.deployment,
  captureNativeVersions: source.nativeVersions, deployment, configurationFingerprint: sha(await readFile(configFile)),
  sessionId: source.sessionId, nativeId: source.nativeId, additionalUserTurns: 0,
  status: 'running', startedAt: new Date().toISOString(), pid: process.pid, checks: {}, errors: [] };
const out = join(evidenceRoot, 'recovery.json');
const save = () => writeFile(out, JSON.stringify(report, null, 2)+'\n', { mode: 0o600 });
await save();
let server, browser, page, base;
async function boot() {
  server = await start(serverConfig, { webDist: join(release, 'packages/web/dist') });
  base = new URL(server.url).origin;
}
async function stop() {
  const adapter = server?.manager.adapter('dsh');
  await server?.close(); await adapter?.shutdown(); server = undefined;
}
const json = async path => {
  const response = await page.request.get(base + path); assert(response.ok(), path);
  return response.json();
};
let answer = '';
for (const line of Buffer.concat(source.requests.at(-1).response.chunks.map(chunk => Buffer.from(chunk.data, 'base64'))).toString().split('\n')) {
  if (!line.startsWith('data: ')) continue;
  let value; try { value = JSON.parse(line.slice(6)); } catch { continue; }
  if (value.type === 'response.output_text.delta' && typeof value.delta === 'string') answer += value.delta;
  if (value.type === 'content_block_delta' && value.delta?.type === 'text_delta') answer += value.delta.text;
}
assert(answer.includes(source.fixture.expectedText), 'No independently recorded final native model proof');
report.finalNativeText = answer;
async function openSession() {
  const adapter = server.manager.adapter(source.agent);
  assert(adapter, 'Actual target Agent adapter is absent');
  const probe = await adapter.probe();
  assert.equal(probe.installed, true, 'Actual native Agent is unavailable');
  assert.equal(probe.version, source.nativeVersions[source.agent].version, 'Native version differs from capture');
  report.actualNativeProbe = { installed: probe.installed, version: probe.version };
  await page.goto(base + '/?token=' + encodeURIComponent(serverConfig.token));
  const meta = await json('/api/meta');
  assert.equal(meta.commit, expectedCommit, 'Actual server commit mismatch');
  assert.equal(meta.build.sourceFingerprint, manifest.sourceFingerprint, 'Actual server source mismatch');
  report.actualNativeVersions = Object.fromEntries(Object.entries(meta.agents).map(([agent, value]) => [agent, value.version]));
  assert.equal(report.actualNativeVersions[source.agent], probe.version, 'Actual Agent metadata is missing or stale');
  await page.goto(base + '/s/' + source.sessionId);
  await page.getByTestId('composer-input').waitFor();
  await page.getByText(answer, { exact: false }).first().waitFor();
  assert.equal((await json('/api/sessions/' + source.sessionId)).nativeId, source.nativeId);
}
try {
  await boot(); browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(45000); page.on('pageerror', error => report.errors.push(error.message));
  await openSession(); report.checks.initialNativeRestore = true;
  const before = await json('/api/sessions/' + source.sessionId + '/trace');
  await page.reload(); await page.getByText(answer, { exact: false }).first().waitFor();
  report.checks.refresh = true;
  await page.context().setOffline(true); await delay(1200);
  await page.context().setOffline(false); await delay(1000);
  await page.getByText(answer, { exact: false }).first().waitFor();
  report.checks.browserReconnect = true;
  await page.screenshot({ path: join(evidenceRoot, 'cached-recovery.png'), fullPage: true });
  await page.setViewportSize({ width: 420, height: 900 });
  await page.screenshot({ path: join(evidenceRoot, 'cached-recovery-mobile.png'), fullPage: true });
  report.checks.mobile = true;
  await stop(); await boot(); await openSession();
  const after = await json('/api/sessions/' + source.sessionId + '/trace');
  assert.equal(after.modelRequests, before.modelRequests, 'Recovery admitted an unexpected model request');
  assert.equal(await page.getByText(answer, { exact: false }).count(), 1, 'Final answer was duplicated');
  report.checks.serverRestart = true; report.checks.sameNativeId = true;
  report.checks.modelRequestsBefore = before.modelRequests; report.checks.modelRequestsAfter = after.modelRequests;
  report.additionalModelRequests = after.modelRequests - before.modelRequests;
  await page.screenshot({ path: join(evidenceRoot, 'cached-server-restart.png'), fullPage: true });
  const trace = await (await page.request.get(base + '/api/sessions/' + source.sessionId + '/trace?format=jsonl')).text();
  await writeFile(join(evidenceRoot, 'recovery-interaction.jsonl'), trace, { mode: 0o600 });
  report.recoveryTraceSha256 = sha(trace); report.status = 'passed';
  assert.equal(report.errors.length, 0);
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  await browser?.close(); await stop(); report.finishedAt = new Date().toISOString();
  await save(); assert.equal(sha(await readFile(sourceFile)), sha(sourceBytes), 'Original failed/live report changed');
  process.stdout.write(JSON.stringify({ agent: source.agent, status: report.status, checks: report.checks,
    additionalModelRequests: report.additionalModelRequests, error: report.error, report: out })+'\n');
}
