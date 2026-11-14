/** Explicit isolated native smoke, separate from fixture unit tests.
 * pnpm exec tsx packages/adapters/dsh/test/native-host-smoke.ts
 * No credential loading, model prompt, native configuration reuse or deploy. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { startSidecar, DshHostClient, attachToDshCredentials, waitUntil } from '../src/host.js';
import type WebSocket from 'ws';
import { readDshHostIdentity } from '../src/identity.js';
import { DshAdapter } from '../src/adapter.js';

const root = await mkdtemp(join(tmpdir(), 'wdcc-dsh-native-smoke-'));
let sidecar: Awaited<ReturnType<typeof startSidecar>> | undefined;
let operator: DshHostClient | undefined;
let browser: DshHostClient | undefined;
let adapter: DshAdapter | undefined;
let stage = 'launch';
let report: Record<string, unknown> = {};
const reportFile = resolve(process.env['WDCC_DSH_SMOKE_REPORT'] ?? '.artifacts/dsh-native-smoke.json');
const sourceFiles = ['src/index.ts', 'src/contracts.ts', 'src/translator.ts', 'src/adapter.ts', 'src/host.ts', 'src/history.ts', 'src/identity.ts', 'src/assistant.ts', 'src/native.ts', 'src/workspaces.ts'];
const fingerprint = async () => createHash('sha256').update(Buffer.concat(await Promise.all(sourceFiles.map(file => readFile(new URL(`../${file}`, import.meta.url)))))).digest('hex');
const sourceFingerprint = await fingerprint();
const initialCommit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const scenarioFingerprint = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
try {
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  sidecar = await startSidecar({ port: 0, cwd: workspace, command: process.env['WDCC_DSH_TEST_COMMAND'] ?? 'dsh',
    env: { PATH: process.env['PATH'], HOME: root, DSH_HOME: join(root, 'dsh'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), LANG: 'C.UTF-8' }, bootTimeoutMs: 30_000 });
  const endpoint = `http://127.0.0.1:${sidecar.port}/`;
  stage = 'authentication';
  const { cookie: operatorCookie, browserCookie } = await attachToDshCredentials(endpoint, sidecar.token);
  const host = await readDshHostIdentity(endpoint, browserCookie);
  stage = 'catalogs-and-global-snapshots';
  operator = new DshHostClient(endpoint); operator.useCookie(operatorCookie); await operator.connect();
  browser = new DshHostClient(endpoint); browser.useCookie(browserCookie); await browser.connect();
  const [sessions, presets, models, control, workspaces] = await Promise.all([
    operator.rpc<{ items: unknown[] }>('session/list', { _request: {} }), operator.rpc<{ presets: unknown[] }>('agentPresets/list'),
    operator.rpc<{ groups: unknown[] }>('session/modelCatalog'), operator.snapshot<{ type: string }>('session/control'), operator.snapshot<{ type: string }>('workspace/follow'),
  ]);
  const response = await fetch(endpoint, { redirect: 'manual', headers: { cookie: browserCookie } });
  await operator.close(); await browser.close();
  let closedOperatorRejected = false;
  try { await operator.rpc('session/list', { _request: {} }); } catch (error) { closedOperatorRejected = (error as { statusCode?: number }).statusCode === 401; }
  stage = 'blank-session-create';
  adapter = new DshAdapter({ mode: 'attach', attachUrl: endpoint, attachCookie: operatorCookie, attachBrowserCookie: browserCookie });
  const created = await adapter.create({ sessionId: 'isolated-smoke', cwd: workspace, providerId: null });
  const workflows: string[] = [];
  for (const action of [{ type: 'rename', title: 'isolated native smoke' }, { type: 'pin', pinned: true }, { type: 'pin', pinned: false }, { type: 'preset', agentPreset: 'standard' }, { type: 'archive', archived: true, stopActivity: false }, { type: 'archive', archived: false }]) {
    stage = `blank-session-${action.type}`;
    const state = await adapter.nativeState('isolated-smoke') as { revision: string };
    await adapter.executeNativeControl('isolated-smoke', { ...action, revision: state.revision }); workflows.push(action.type);
  }
  stage = 'blank-session-native-history';
  const history = await adapter.readNativeHistory('isolated-smoke', { limit: 100 }) as { records: unknown[] };
  stage = 'physical-browser-peer-reconnect';
  const runtimeClient = (adapter as unknown as { client: DshHostClient }).client;
  (runtimeClient as unknown as { ws: WebSocket }).ws.terminate();
  await waitUntil(() => !runtimeClient.isConnected, 2000, 'physical socket loss');
  const duringLoss = await runtimeClient.rpc<{ cursor: number }>('session/state', { request: { sessionId: created.nativeId } });
  await waitUntil(() => runtimeClient.isConnected, 8000, 'native browser peer reconnect');
  const after = await adapter.readNativeHistory('isolated-smoke', { limit: 100 }) as { nativeId: string; records: unknown[] };
  report = { status: 'passed', modelCalls: 0, isolatedHome: true, hostVersion: host.version ?? null, nativeCommit: host.commit ?? null, hostIdentityStatus: host.status,
    identitySource: host.source, manifestFingerprint: host.fingerprint ?? null, operatorApi: true, browserIndex: response.status,
    sessions: sessions.items.length, presets: presets.presets.length, modelGroups: models.groups.length, controlBaseline: control.type, workspaceBaseline: workspaces.type,
    blankSessionCreated: created.nativeId.startsWith('session-'), blankSessionWorkflows: workflows, recoveredNativeRecords: history.records.length,
    closedOperatorRejected, reconnectCredential: 'native-browser-shared-peer',
    physicalSocketReconnect: runtimeClient.isConnected, httpDuringSocketLoss: typeof duringLoss.cursor === 'number', sameNativeIdAfterReconnect: after.nativeId === created.nativeId,
    historyRecordsAfterReconnect: after.records.length,
    remainingNativeAcceptance: ['provider/model execution', 'activeAttempt from a real model stream', 'remote browser isolated surface', 'external owner release/arbitration', 'goal/schedule/card/Forge user workflows'] };
} catch (error) {
  // Native stdout contains the launch token. Deliberately report only an error
  // category; credentials and the complete process output never leave memory.
  const code = (error as { code?: unknown })?.code;
  report = { status: 'failed', stage, isolatedHome: true, category: error instanceof Error ? error.name : 'unknown',
    ...(typeof code === 'string' && /^[a-zA-Z0-9_/-]+$/.test(code) ? { nativeErrorCode: code } : {}) };
  process.exitCode = 1;
} finally {
  await adapter?.shutdown(); await operator?.close(); await browser?.close(); await sidecar?.stop(); await rm(root, { recursive: true, force: true });
  const finalFingerprint = await fingerprint();
  const catalog = await readFile(new URL('../../../../fixtures/dsh/host-api-catalog.json', import.meta.url));
  report = { ...report, testedAt: new Date().toISOString(), commit: initialCommit, sourceFingerprint, sourceChangedDuringRun: finalFingerprint !== sourceFingerprint,
    catalogFingerprint: createHash('sha256').update(catalog).digest('hex'), catalogEndpointCount: Object.keys((JSON.parse(catalog.toString()) as { endpoints: object }).endpoints).length,
    scenarioFingerprint, nativeBaseline: '0.2.2-rc.1', platform: process.platform, node: process.version,
    cleanup: { operatorClosed: true, browserClosed: true, sidecarStopped: true, isolatedHomeRemoved: true },
    evidenceScope: 'real isolated native Host, authentication, APIs and blank-session organization controls; no model/production/surface claims' };
  if (finalFingerprint !== sourceFingerprint) { report['status'] = 'failed'; report['category'] = 'source-changed-during-run'; process.exitCode = 1; }
  await mkdir(dirname(reportFile), { recursive: true }); await writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportFile }));
}
