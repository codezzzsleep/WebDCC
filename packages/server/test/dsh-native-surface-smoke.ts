/** Explicit real native/browser smoke. The main-origin harness uses WebDCC's
 * signed-cookie verifier; production app integration and remote deployment are
 * separate acceptance predicates, never implied by this local run. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { attachDshBrowser, readDshHostIdentity, startSidecar } from '@webdcc/adapter-dsh';
import { cookieNameFor, issueCookie, isAuthenticated } from '../src/auth.js';
import { createDshNativeSurface, type DshNativeSurface } from '../src/dsh-native-surface.js';

const root = await mkdtemp(join(tmpdir(), 'wdcc-dsh-surface-real-'));
const reportFile = resolve('.artifacts/dsh-native-surface-smoke.json');
const sourceFile = new URL('../src/dsh-native-surface.ts', import.meta.url);
const sourceFingerprint = createHash('sha256').update(await readFile(sourceFile)).digest('hex');
const scenarioFingerprint = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
let sidecar: Awaited<ReturnType<typeof startSidecar>> | undefined;
let surface: DshNativeSurface | undefined;
let browser: Browser | undefined;
let main: ReturnType<typeof createServer> | undefined;
let report: Record<string, unknown> = {};
let stage = 'native-launch';
async function port() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const value = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return value; }
try {
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  sidecar = await startSidecar({ port: 0, command: process.env['WDCC_DSH_TEST_COMMAND'] ?? 'dsh', cwd: workspace, bootTimeoutMs: 30_000,
    env: { PATH: process.env['PATH'], HOME: root, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), DSH_HOME: join(root, 'dsh'), WDCC_DATA_DIR: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), LANG: 'C.UTF-8' } });
  const nativeUrl = `http://127.0.0.1:${sidecar.port}/`;
  const browserCookie = await attachDshBrowser(nativeUrl, sidecar.token);
  const host = await readDshHostIdentity(nativeUrl, browserCookie);
  const mainPort = await port(); const nativePort = await port(); const mainOrigin = `http://127.0.0.1:${mainPort}`; const nativeOrigin = `http://127.0.0.1:${nativePort}`;
  let connection = { url: nativeUrl, browserCookie, connectedAt: new Date().toISOString() };
  surface = await createDshNativeSurface({ publicOrigin: nativeOrigin, applicationOrigins: [mainOrigin], connection: () => connection });
  await surface.start({ host: '127.0.0.1', port: nativePort });
  const mainToken = randomBytes(32).toString('base64url'); const mainAuthority = new URL(mainOrigin).host;
  const nativeSurface = surface;
  main = createServer(async (request, response) => {
    if (!isAuthenticated(mainToken, request.headers.cookie, mainAuthority)) { response.writeHead(401); response.end(); return; }
    if (request.method === 'POST' && request.url === '/ticket' && request.headers.origin === mainOrigin) {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(await nativeSurface.issueTicket())); return;
    }
    response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>WebDCC native probe</title><body>Authenticated main origin</body>');
  });
  main.listen(mainPort, '127.0.0.1'); await once(main, 'listening');
  stage = 'browser-launch';
  browser = await chromium.launch({ headless: true, env: { PATH: process.env['PATH'], HOME: root }, executablePath: process.env['WDCC_TEST_CHROMIUM'] ?? '/root/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell' });
  const context = await browser.newContext();
  await context.addCookies([{ name: cookieNameFor(mainAuthority), value: issueCookie(mainToken), url: mainOrigin, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const origins = new Set<string>(); const websocketOrigins = new Set<string>(); const streamEndpoints = new Set<string>(); const failures: { path: string; queryKeys: string[]; error: string | null }[] = []; const assetStatuses: { path: string; status: number; contentType?: string }[] = []; let failedRequests = 0; let nativeBundleRequests = 0; let nativeFrames = 0;
  page.on('request', request => { const url = new URL(request.url()); if (url.protocol.startsWith('http')) origins.add(url.origin); if (url.origin === nativeOrigin && url.pathname.startsWith('/plugins/')) nativeBundleRequests++; });
  page.on('requestfailed', request => { failedRequests++; const url = new URL(request.url()); failures.push({ path: url.pathname, queryKeys: [...url.searchParams.keys()], error: request.failure()?.errorText ?? null }); });
  page.on('response', response => { const url = new URL(response.url()); if (url.origin === nativeOrigin && url.pathname.startsWith('/plugins/')) assetStatuses.push({ path: url.pathname, status: response.status(), contentType: response.headers()['content-type'] }); });
  page.on('websocket', socket => {
    const url = new URL(socket.url()); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'; websocketOrigins.add(url.origin);
    socket.on('framesent', frame => { try { const value = JSON.parse(String(frame.payload)) as { type?: string; endpoint?: string }; if (value.type === 'open' && value.endpoint !== undefined) streamEndpoints.add(value.endpoint); } catch { /* binary is not logged */ } });
    socket.on('framereceived', () => { nativeFrames++; });
  });
  stage = 'main-authentication'; await page.goto(mainOrigin);
  stage = 'native-ticket-post';
  await page.evaluate(async () => {
    const ticket = await (await fetch('/ticket', { method: 'POST' })).json() as { actionUrl: string; ticket: string };
    const form = document.createElement('form'); form.method = 'POST'; form.action = ticket.actionUrl;
    const input = document.createElement('input'); input.type = 'hidden'; input.name = 'ticket'; input.value = ticket.ticket;
    form.append(input); document.body.append(form); form.submit();
  });
  await page.waitForURL(nativeOrigin + '/');
  stage = 'native-bundle-and-API';
  await page.waitForFunction(() => document.body.innerText.trim().length > 40, { timeout: 20_000 });
  const nativeStarted = Date.now();
  while (nativeFrames === 0 && Date.now() - nativeStarted < 20_000) await new Promise(resolve => setTimeout(resolve, 50));
  const settings = await page.evaluate(async () => {
    const id = crypto.randomUUID();
    const response = await fetch('api/settings/describe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: id, method: 'settings/describe', payload: { args: {} } }) });
    const body = await response.json() as { rpcId: string; result: { ok: boolean; value?: { namespaces: unknown[] } } };
    return { status: response.status, valid: body.rpcId === id && body.result.ok === true, namespaces: body.result.value?.namespaces.length ?? 0 };
  });
  const nativeText = (await page.locator('body').innerText()).slice(0, 400);
  await page.screenshot({ path: resolve('.artifacts/dsh-native-surface-browser.png') });
  stage = 'surface-revocation';
  connection = { ...connection, connectedAt: new Date(Date.now() + 1).toISOString() };
  const revoked = await page.evaluate(async () => (await fetch('api/settings/describe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'after-revocation', method: 'settings/describe', payload: { args: {} } }) })).status);
  report = { status: settings.valid && nativeBundleRequests > 0 && nativeFrames > 0 && websocketOrigins.has(nativeOrigin) && !origins.has(new URL(nativeUrl).origin) && revoked === 401 ? 'passed' : 'failed', hostVersion: host.version, nativeCommit: host.commit,
    manifestFingerprint: host.fingerprint, isolatedOrigin: true, nativeIndexUrlHasNoTicket: !page.url().includes('ticket') && !page.url().includes('token'),
    settingsApi: settings, nativeBundleRequests, nativeWSOnIsolatedOrigin: websocketOrigins.has(nativeOrigin), nativeFrames, streamEndpoints: [...streamEndpoints], surfaceWritable: false,
    browserContactedNativeLoopback: origins.has(new URL(nativeUrl).origin), mainOriginAuthenticated: true, revocationStatus: revoked, failedRequests, failures, assetStatuses, nativeText,
    modelPrompts: 0, remoteBrowserReachability: 'not-verified', mainHarness: 'actual WebDCC cookie verifier; app/UI integration remains separate',
    remainingNativeAcceptance: ['remote deployment', 'settings/schedule/plugins/Forge deep user workflows', 'hosted owner/fencing integration'] };
  if (report['status'] !== 'passed') process.exitCode = 1;
} catch (error) { report = { status: 'failed', stage, category: error instanceof Error ? error.name : 'unknown', modelPrompts: 0, remoteBrowserReachability: 'not-verified' }; process.exitCode = 1; }
finally {
  await browser?.close(); await surface?.close(); if (main !== undefined) { main.closeIdleConnections(); await new Promise<void>(resolve => main!.close(() => resolve())); } await sidecar?.stop(); await rm(root, { recursive: true, force: true });
  const changed = sourceFingerprint !== createHash('sha256').update(await readFile(sourceFile)).digest('hex');
  report = { ...report, testedAt: new Date().toISOString(), commit, sourceFingerprint, scenarioFingerprint, sourceChangedDuringRun: changed,
    cleanup: { browserClosed: true, surfaceClosed: true, mainHarnessClosed: true, sidecarStopped: true, temporaryHomeRemoved: true } };
  if (changed) { report['status'] = 'failed'; report['category'] = 'source-changed-during-run'; process.exitCode = 1; }
  await mkdir(dirname(reportFile), { recursive: true }); await writeFile(reportFile, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, reportFile }));
}
