/** Real DSH Web Host + production adapter + Chromium reasoning controls.
 * A temporary Host profile avoids session/selectModel's background default save
 * changing a production profile. No model prompts or credentials are reused. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, expect, type Browser } from '@playwright/test';
import { DshAdapter, DshHostClient, attachToDshCredentials, readDshHostIdentity, startSidecar, requireDshBaseline } from '../packages/adapters/dsh/src/index.js';
import type { TraceFrame } from '../packages/protocol/src/index.js';
import { createSourceTestApp } from '../browser-tests/helpers.js';
import { dshInputCapabilities } from '../packages/adapters/dsh/src/input-capabilities.js';
import { sourceFingerprint as wholeSourceFingerprint } from './lib/gate-report.js';

const reportIndex = process.argv.indexOf('--report');
const reportPath = resolve(reportIndex < 0 ? 'web_review/evidence/native-dsh-reasoning.json' : process.argv[reportIndex + 1]!);
const sourcePaths = ['packages/adapters/dsh/src/adapter.ts', 'packages/adapters/dsh/src/host.ts', 'packages/adapters/dsh/src/contracts.ts', 'packages/web/src/components/Composer.tsx'];
const fingerprint = async () => createHash('sha256').update(Buffer.concat(await Promise.all(sourcePaths.map(path => readFile(path))))).digest('hex');
const sourceFingerprint = await fingerprint();
const wholeFingerprint = wholeSourceFingerprint();
const root = await mkdtemp(join(tmpdir(), 'wdcc-native-dsh-reasoning-'));
const workspacePath = join(root, 'workspace'); await mkdir(workspacePath);
const model = 'deepseek-v4-1-flash-1017'; const provider = 'isolated-coarena-profile';
let sidecar: Awaited<ReturnType<typeof startSidecar>> | undefined; let setup: DshHostClient | undefined; let browser: Browser | undefined;
let ctx: Awaited<ReturnType<typeof createSourceTestApp>> | undefined; let stage = 'native-launch';
const frames: TraceFrame[] = [];
const evidence: Record<string, unknown> = { status: 'running', commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceFingerprint: wholeFingerprint, focusedSourceFingerprint: sourceFingerprint, focusedSourcePaths: sourcePaths,
  nativeBaseline: '0.2.2-rc.1', model, provider, paidModel: false, userModelRequests: 0, isolatedProfile: true,
  scope: 'actual native Web Host with fixture profile declaring off/high/max; production adapter and Chromium, no production profile/deployment or model request', startedAt: new Date().toISOString() };
await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
try {
  sidecar = await startSidecar({ port: 0, cwd: workspacePath, bootTimeoutMs: 30_000, env: {
    PATH: process.env['PATH'], HOME: join(root, 'home'), DSH_HOME: join(root, 'dsh'), XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'), LANG: 'C.UTF-8', WEB_DCC_DSH_REASONING_FIXTURE_KEY: 'isolated-fixture-value',
  } });
  const endpoint = `http://127.0.0.1:${sidecar.port}/`; const credentials = await attachToDshCredentials(endpoint, sidecar.token);
  const host = await readDshHostIdentity(endpoint, credentials.browserCookie); requireDshBaseline(host);
  evidence['nativeVersion'] = host.version; evidence['nativeCommit'] = host.commit; evidence['nativeHostFingerprint'] = host.fingerprint;
  setup = new DshHostClient(endpoint); setup.useCookie(credentials.cookie);
  stage = 'isolated-profile-config';
  const settings = await setup.rpc<{ writable: boolean; namespaces: { ns: string; revision: number }[] }>('settings/describe');
  const namespace = settings.namespaces.find(value => value.ns === 'llm-pi-ai'); assert.ok(namespace && settings.writable);
  await setup.rpc('settings/mutate', { ns: namespace.ns, expectedRevision: namespace.revision, ops: [{ op: 'set', path: ['providers', provider], value: {
    displayName: 'Isolated Coarena-shaped profile', apiKeyEnv: 'WEB_DCC_DSH_REASONING_FIXTURE_KEY', api: 'openai-completions',
    baseURL: 'http://127.0.0.1:1/v1', models: [{ id: model, name: model, contextWindow: 65536, maxTokens: 1024,
      reasoningEfforts: { off: 'none', high: 'high', max: 'max' } }],
  } }] });
  const catalog = await setup.rpc<{ groups: { id: string; models: { id: string; reasoning?: { efforts: { id: string }[] } }[] }[] }>('session/modelCatalog');
  const nativeModel = catalog.groups.find(group => group.id === provider)?.models.find(value => value.id === model);
  assert.deepEqual(nativeModel?.reasoning?.efforts.map(value => value.id), ['off', 'high', 'max']); evidence['nativeCatalog'] = nativeModel;
  await dshInputCapabilities(catalog, <T>(name: string, args?: Record<string, unknown>) => setup!.rpc<T>(name, args));
  stage = 'production-adapter-and-web';
  ctx = await createSourceTestApp();
  const adapter = new DshAdapter({ mode: 'attach', attachUrl: endpoint, attachCookie: credentials.cookie, attachBrowserCookie: credentials.browserCookie,
    traceSink: { record: frame => { if (frame.ch === 'rpc:session/selectModel' || frame.ch === 'rpc:session/projections') frames.push(structuredClone(frame)); } } });
  ctx.manager.registerAdapter(adapter); const workspace = ctx.store.createWorkspace('Native reasoning', workspacePath);
  const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'dsh', model, reasoningEffort: 'off' });
  evidence['adapterModels'] = await adapter.listModels(); assert.ok((evidence['adapterModels'] as unknown[]).length > 0, 'production adapter returned no model options');
  await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`; browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(15_000);
  const browserModels: unknown[] = []; evidence['browserModelResponses'] = browserModels;
  page.on('response', response => { if (new URL(response.url()).pathname === '/api/models') void response.json().then(value => browserModels.push(value)).catch(() => undefined); });
  let preventedPrompts = 0;
  await page.routeWebSocket('**/api/ws', socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const packet = JSON.parse(String(message)) as { op?: string; command?: { op?: string; clientCommandId?: string } };
      if (packet.op === 'command' && packet.command?.op === 'send') {
        preventedPrompts++;
        socket.send(JSON.stringify({ op: 'ack', clientCommandId: packet.command.clientCommandId, result: { ok: false, error: 'verification is limited to native model selection' } }));
      } else server.send(message);
    });
  });
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
  await page.goto(`${base}/s/${session.id}`);
  const chosen: unknown[] = []; evidence['existingChoices'] = chosen;
  for (const effort of ['high', 'max', 'off']) {
    stage = `existing-native-${effort}`;
    await expect(page.getByTestId('reasoning-menu')).toBeEnabled({ timeout: 15_000 }); await page.getByTestId('reasoning-menu').click();
    assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(), ['off', 'high', 'max']);
    await page.getByRole('menuitemradio', { name: effort, exact: true }).click();
    await expect(page.getByTestId('reasoning-menu')).toHaveText(`思考 ${effort}`, { timeout: 15_000 });
    const current = await adapter.nativeState(session.id) as { selected: { reasoningEffort?: string; provider?: string; model?: string } };
    assert.equal(current.selected.reasoningEffort, effort); assert.equal(current.selected.provider, provider); assert.equal(current.selected.model, model);
    assert.equal(ctx.store.getSession(session.id)?.reasoningEffort, effort); chosen.push(current.selected);
    await page.reload(); await expect(page.getByTestId('reasoning-menu')).toHaveText(`思考 ${effort}`, { timeout: 15_000 });
  }
  stage = 'new-native-model-choice';
  await page.goto(`${base}/new?w=${workspace.id}&agent=dsh`);
  await expect(page.getByTestId('reasoning-menu')).toBeEnabled({ timeout: 15_000 }); await page.getByTestId('reasoning-menu').click();
  assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(), ['沿用原生', 'off', 'high', 'max']);
  await page.getByRole('menuitemradio', { name: 'high', exact: true }).click();
  await expect(page.getByTestId('reasoning-menu')).toHaveText('思考 high');
  await page.reload();
  await expect(page.getByTestId('reasoning-menu')).toHaveText('思考 high', { timeout: 15_000 });
  evidence['newSessionChoicePreservedBeforeCreation'] = true;
  // Read the actual create command by temporarily intercepting the subsequent
  // user-message command; creation still runs the production native adapter.
  await page.route('**/api/commands', async route => {
    const { command } = route.request().postDataJSON() as { command: { op?: string } };
    if (command.op === 'send' || command.op === 'message') await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'native reasoning check does not send model prompts' }) });
    else await route.continue();
  });
  await page.getByTestId('new-session-input').fill('Isolated creation only'); await page.getByTestId('new-session-send').click();
  await page.waitForURL('**/s/**');
  await expect.poll(() => ctx!.store.listSessions(true).length).toBe(2);
  const created = ctx.store.listSessions(true).find(value => value.id !== session.id)!;
  assert.equal(created.reasoningEffort, 'high');
  const createdState = await adapter.nativeState(created.id) as { selected: { reasoningEffort?: string } }; assert.equal(createdState.selected.reasoningEffort, 'high');
  stage = 'new-native-default-model-omitted';
  const defaultModel = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'dsh', reasoningEffort: 'high' });
  const defaultState = await adapter.nativeState(defaultModel.id) as { selected: { provider?: string; model?: string; reasoningEffort?: string } };
  assert.equal(defaultState.selected.provider, provider); assert.equal(defaultState.selected.model, model); assert.equal(defaultState.selected.reasoningEffort, 'high');
  assert.equal(ctx.store.getSession(defaultModel.id)?.reasoningEffort, 'high');
  await page.goto(`${base}/s/${defaultModel.id}`); await expect(page.getByTestId('reasoning-menu')).toHaveText('思考 high', { timeout: 15_000 });
  await page.reload(); await expect(page.getByTestId('reasoning-menu')).toHaveText('思考 high', { timeout: 15_000 });
  evidence['newSessionOmittedModelNativeSelection'] = defaultState.selected;
  stage = 'external-native-same-model-other-provider';
  const externalProvider = 'isolated-secondary-profile';
  const currentSettings = await setup.rpc<{ namespaces: { ns: string; revision: number }[] }>('settings/describe');
  const currentNamespace = currentSettings.namespaces.find(value => value.ns === 'llm-pi-ai'); assert.ok(currentNamespace);
  await setup.rpc('settings/mutate', { ns: currentNamespace.ns, expectedRevision: currentNamespace.revision, ops: [{ op: 'set', path: ['providers', externalProvider], value: {
    displayName: 'Isolated same-model alternate route', apiKeyEnv: 'WEB_DCC_DSH_REASONING_FIXTURE_KEY', api: 'openai-completions',
    baseURL: 'http://127.0.0.1:1/v1', models: [{ id: model, name: model, contextWindow: 65536, maxTokens: 1024, reasoningEfforts: { low: 'low' } }],
  } }] });
  await adapter.nativeState(defaultModel.id);
  const externalSelection = await setup.rpc<{ selected: { provider: string; model: string; reasoningEffort: string } }>('session/selectModel', { request: {
    sessionId: defaultModel.nativeId, provider: externalProvider, model, reasoningEffort: 'low',
  } });
  const externalPublicModel = `dsh:${Buffer.from(JSON.stringify([externalProvider, model])).toString('base64url')}`;
  await expect.poll(() => ctx!.store.getSession(defaultModel.id)?.model, { timeout: 15_000 }).toBe(externalPublicModel);
  assert.equal(ctx.store.getSession(defaultModel.id)?.reasoningEffort, 'low');
  await expect(page.getByTestId('model-menu')).toHaveAttribute('data-model', externalPublicModel, { timeout: 15_000 });
  await expect(page.getByTestId('reasoning-menu')).toHaveText('思考 low', { timeout: 15_000 });
  await page.reload(); await expect(page.getByTestId('model-menu')).toHaveAttribute('data-model', externalPublicModel, { timeout: 15_000 });
  await expect(page.getByTestId('reasoning-menu')).toHaveText('思考 low', { timeout: 15_000 });
  await page.getByTestId('reasoning-menu').click(); await page.getByRole('menuitemradio').first().waitFor();
  assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(), ['low']);
  await page.getByTestId('reasoning-menu').click();
  evidence['externalNativeModelSelection'] = externalSelection.selected;
  evidence['externalNativeProviderModelAndEffortSyncedToDbAndBrowser'] = true;
  evidence['existingChoices'] = chosen; evidence['newSessionChoiceConfirmed'] = true;
  evidence['browserRefreshPreservedActualLevel'] = true; evidence['newSessionNativeSelection'] = createdState.selected;
  evidence['newSessionFollowingPromptPreventedByTestBoundary'] = preventedPrompts;
  await page.screenshot({ path: `${reportPath}.png`, fullPage: true }); evidence['browserScreenshot'] = `${reportPath}.png`;
  evidence['nativeSelectionFrames'] = frames; evidence['status'] = 'passed';
} catch (error) {
  evidence['status'] = 'failed'; evidence['stage'] = stage; evidence['error'] = error instanceof Error ? error.message : String(error);
  evidence['nativeSelectionFrames'] = frames; process.exitCode = 1;
} finally {
  await browser?.close(); await ctx?.close(); await setup?.close(); await sidecar?.stop(); await rm(root, { recursive: true, force: true });
  evidence['endedAt'] = new Date().toISOString(); evidence['finalSourceFingerprint'] = wholeSourceFingerprint(); evidence['finalFocusedSourceFingerprint'] = await fingerprint();
  evidence['sourceChangedDuringRun'] = evidence['finalSourceFingerprint'] !== wholeFingerprint;
  if (evidence['sourceChangedDuringRun']) { evidence['status'] = 'failed'; evidence['error'] = 'source changed during native verification'; process.exitCode = 1; }
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: evidence['status'], stage: evidence['stage'], error: evidence['error'], report: reportPath })}\n`);
}
