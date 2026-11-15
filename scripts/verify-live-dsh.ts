/** Two authorized, isolated native user turns. No original native home,
 * deployment, shell proxy, replay handler or credential logging is used. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DshAdapter, DshHostClient, attachToDshCredentials, readDshHostIdentity, startSidecar, requireDshBaseline } from '../packages/adapters/dsh/src/index.js';
import type { AdapterEvent, TraceFrame } from '../packages/protocol/src/index.js';
import { redactDiagnosticValue } from '../packages/testing/model-proxy/src/redaction.js';

const reportPath = resolve('web_review/evidence/native-live-dsh.json');
const runId = randomUUID();
const secrets: string[] = [];
let report: Record<string, unknown> = { status: 'running', runId, paidModel: true, userRequestsSent: 0, maxUserTurns: 2, startedAt: new Date().toISOString(), pid: process.pid };
let root: string | undefined;
let adapter: DshAdapter | undefined;
let sidecar: Awaited<ReturnType<typeof startSidecar>> | undefined;
let setup: DshHostClient | undefined;
let stage = 'arguments';
const raw: TraceFrame[] = [];
const projected: AdapterEvent[] = [];
const violations: string[] = [];
const allowedCalls = new Set<string>();
let fixturePath = '';
let sourceFingerprint = '';
let preserveExistingReceipt = false;
let ledgerLock: FileHandle | undefined;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourcePaths = ['packages/adapters/dsh/src/adapter.ts', 'packages/adapters/dsh/src/host.ts', 'packages/adapters/dsh/src/contracts.ts', 'packages/adapters/dsh/src/history.ts', 'packages/adapters/dsh/src/assistant.ts', 'packages/adapters/dsh/src/identity.ts', 'packages/adapters/dsh/src/native.ts'];
const fingerprint = async () => hash(Buffer.concat(await Promise.all(sourcePaths.map(path => readFile(resolve(path))))));
const clean = (value: unknown) => redactDiagnosticValue(value, secrets);
async function persist(): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.${runId}.tmp`;
  await writeFile(temporary, JSON.stringify(clean(report), null, 2), { mode: 0o600 }); await rename(temporary, reportPath);
}
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function nativeEvent(frame: TraceFrame): Record<string, unknown> | undefined {
  const value = record(record(frame.frame)['value']);
  return value['type'] === 'event' ? record(value['event']) : undefined;
}
function text(event: AdapterEvent): string { return event.type === 'item.complete' && event.kind === 'assistant.message' ? String(record(event.data)['text'] ?? '') : ''; }
function suppressCompactStreams(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(suppressCompactStreams); return; }
  const object = record(value);
  if (['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(String(object['type']))) {
    for (const key of ['texts', 'args']) if (Array.isArray(object[key])) object[key] = (object[key] as unknown[]).map(member => ({ omitted: 'stream payload', sha256: hash(String(member)), bytes: Buffer.byteLength(String(member)) }));
  }
  Object.values(object).forEach(child => { if (child !== null && typeof child === 'object') suppressCompactStreams(child); });
}
function sanitizedTrace(frame: TraceFrame): unknown {
  const detached = structuredClone(frame);
  const value = record(record(detached.frame)['value']);
  if (value['type'] === 'assistant-stream') {
    const wire = record(value['frame']); const chunk = record(wire['chunk']);
    for (const field of ['text', 'argumentsDelta']) if (typeof chunk[field] === 'string') chunk[field] = { omitted: 'stream payload', sha256: hash(chunk[field] as string), bytes: Buffer.byteLength(chunk[field] as string) };
    const block = record(chunk['block']); if (typeof block['text'] === 'string') block['text'] = { omitted: 'stream payload', sha256: hash(block['text'] as string) };
  }
  const event = nativeEvent(detached);
  if (event?.['type'] === 'tool/call') {
    const data = record(event['data']);
    if (!allowedCalls.has(String(data['callId'] ?? ''))) event['data'] = { name: data['name'], callId: data['callId'], omitted: 'out-of-scope tool input', sha256: hash(JSON.stringify(data)) };
  }
  if (event?.['type'] === 'tool/result') {
    const data = record(event['data']); const message = record(data['message']);
    const callId = String(data['toolCallId'] ?? message['toolCallId'] ?? '');
    if (!allowedCalls.has(callId)) event['data'] = { omitted: 'out-of-scope tool result', sha256: hash(JSON.stringify(data)) };
  }
  suppressCompactStreams(detached);
  return clean(detached);
}
async function waitTurn(after: number, timeoutMs = 120_000): Promise<AdapterEvent[]> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const events = projected.slice(after);
    if (violations.length > 0) throw new Error('Native model selected a tool outside the authorized fixture scope');
    const end = events.find(event => event.type === 'turn.end');
    if (end !== undefined) { if (end.type !== 'turn.end' || end.status !== 'completed') throw new Error('Native user turn did not complete'); return events; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Native turn timed out; do not blindly replay the paid input');
}
try {
  await mkdir(dirname(reportPath), { recursive: true });
  try { ledgerLock = await open(`${reportPath}.lock`, 'wx', 0o600); await ledgerLock.writeFile(JSON.stringify({ runId, pid: process.pid, startedAt: new Date().toISOString() })); }
  catch { preserveExistingReceipt = true; throw new Error('A native DSH verification job already holds the durable lock; inspect its ledger before retrying'); }
  const previous = await readFile(reportPath, 'utf8').then(value => JSON.parse(value) as { userRequestsSent?: number; runId?: string }).catch(() => undefined);
  if ((previous?.userRequestsSent ?? 0) > 0) { preserveExistingReceipt = true; throw new Error('A previous paid DSH run already submitted inputs; its receipt is preserved and must be reconciled before another run'); }
  const args = process.argv.slice(2); const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1];
    if (name === undefined || value === undefined || !['--credential-file', '--endpoint', '--model'].includes(name)) throw new Error('Require --credential-file, --endpoint and --model');
    flags[name] = value;
  }
  const credentialFile = flags['--credential-file']; const endpoint = flags['--endpoint']; const model = flags['--model'];
  if (credentialFile === undefined || endpoint === undefined || model === undefined || !/^[A-Za-z0-9_.:-]{1,200}$/.test(model)) throw new Error('Require valid credential-file, endpoint and model arguments');
  const api = new URL(endpoint);
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) throw new Error('Model endpoint must be a credential-free HTTPS URL');
  if (api.pathname === '/') api.pathname = '/v1/';
  const credentialPath = resolve(credentialFile); secrets.push(credentialPath, credentialFile);
  sourceFingerprint = await fingerprint();
  report = { ...report, model, endpointOrigin: api.origin, commit: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), sourceFingerprint,
    scenarioFingerprint: hash(await readFile(new URL(import.meta.url))), loadedHandlerFingerprint: hash(DshAdapter.toString()), predicates: {} };
  await persist();
  console.log(JSON.stringify({ runId, status: 'running', phase: 'isolated-native-setup', paidModel: true, report: 'web_review/evidence/native-live-dsh.json' }));
  stage = 'credential-load';
  const key = (await readFile(credentialPath, 'utf8')).trim();
  if (key.length < 8 || key.length > 4096 || /[\r\n\0]/.test(key)) throw new Error('Credential file does not contain one usable API key'); secrets.push(key);
  root = await mkdtemp(join(tmpdir(), 'webdcc-live-dsh-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  fixturePath = join(workspace, 'fixture.txt'); const proof = randomBytes(16).toString('hex');
  const fixture = `run=${runId}\nproof_nonce=${proof}\n`; await writeFile(fixturePath, fixture, { mode: 0o600 });
  const keyEnv = 'WEB_DCC_DSH_LIVE_VERIFICATION_KEY';
  stage = 'native-host-launch';
  sidecar = await startSidecar({ port: 0, cwd: workspace, bootTimeoutMs: 30_000, env: { PATH: process.env['PATH'], HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), DSH_HOME: join(root, 'dsh'), WDCC_DATA_DIR: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), LANG: 'C.UTF-8', [keyEnv]: key } });
  secrets.push(sidecar.token);
  const hostUrl = `http://127.0.0.1:${sidecar.port}/`;
  const credentials = await attachToDshCredentials(hostUrl, sidecar.token); secrets.push(credentials.cookie, credentials.browserCookie, credentials.cookie.slice(credentials.cookie.indexOf('=') + 1), credentials.browserCookie.slice(credentials.browserCookie.indexOf('=') + 1));
  const host = await readDshHostIdentity(hostUrl, credentials.browserCookie); requireDshBaseline(host);
  setup = new DshHostClient(hostUrl); setup.useCookie(credentials.cookie);
  stage = 'isolated-provider-configuration';
  const description = await setup.rpc<{ writable: boolean; namespaces: { ns: string; revision: number }[] }>('settings/describe');
  const namespace = description.namespaces.find(namespace => namespace.ns === 'llm-pi-ai');
  if (!description.writable || namespace === undefined) throw new Error('Temporary Host does not expose writable llm-pi-ai settings');
  const provider = 'webdcc-live-verification';
  await setup.rpc('settings/mutate', { ns: namespace.ns, expectedRevision: namespace.revision, ops: [{ op: 'set', path: ['providers', provider], value: {
    displayName: 'Isolated native verification', apiKeyEnv: keyEnv, api: 'openai-completions', baseURL: api.toString(), reasoning: 'off', timeoutMs: 60_000,
    models: [{ id: model, name: model, contextWindow: 65536, maxTokens: 1024, reasoningEfforts: false }],
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: true, supportsStrictMode: false, maxTokensField: 'max_tokens' },
  } }] });
  const models = await setup.rpc<{ groups: { id: string; models: { id: string }[] }[] }>('session/modelCatalog');
  if (!models.groups.some(group => group.id === provider && group.models.some(value => value.id === model))) throw new Error('Configured model route is not in the native Host catalog');
  adapter = new DshAdapter({ mode: 'attach', attachUrl: hostUrl, attachCookie: credentials.cookie, attachBrowserCookie: credentials.browserCookie, traceSink: { record: frame => {
    if (raw.length >= 20_000) { violations.push('native trace overflow'); return; }
    raw.push(structuredClone(frame));
    const event = nativeEvent(frame);
    if (event?.['type'] === 'tool/call') {
      const data = record(event['data']); let input: Record<string, unknown> = {};
      try { input = record(JSON.parse(String(data['arguments'] ?? '{}'))); } catch { /* invalid input remains unauthorized */ }
      const path = String(input['file_path'] ?? input['path'] ?? '');
      if (data['name'] === 'read' && resolve(workspace, path) === fixturePath) allowedCalls.add(String(data['callId'] ?? ''));
      else { violations.push(`unexpected native tool: ${String(data['name'] ?? 'unknown')}`); void adapter?.interrupt(runId).catch(() => undefined); }
    }
  } } });
  adapter.onEvent((sessionId, event) => {
    projected.push(structuredClone(event));
    if (event.type === 'item.complete' && event.kind === 'approval.request') {
      const approval = record(event.data);
      let detail: Record<string, unknown> = {};
      try { detail = record(JSON.parse(String(approval['detail'] ?? '{}'))); } catch { /* incomplete identity never grants approval */ }
      const optionId = approval['tool'] === 'read' && allowedCalls.has(String(detail['callId'] ?? '')) ? 'allowed-once' : 'rejected';
      void adapter?.respond(sessionId, { approvalId: String(approval['approvalId']), optionId }).catch(() => { violations.push('approval reply failed'); });
    }
  });
  stage = 'public-adapter-create';
  const created = await adapter.create({ sessionId: runId, cwd: workspace, providerId: null, model, accessMode: 'read-only' });
  report = { ...report, nativeId: created.nativeId, hostVersion: host.version, nativeCommit: host.commit, manifestFingerprint: host.fingerprint, provider,
    fixtureSha256: hash(fixture), fixtureBytes: Buffer.byteLength(fixture), isolatedHome: true, requestIds: [randomUUID(), randomUUID()], nativeLaunch: ['dsh', 'web', '--no-open', '--port', '0', '--host', '127.0.0.1'],
    tracePolicy: 'stream text/argument fragments hashed; authorized fixture tool inputs/results retained after credential redaction', maxOutputTokens: 1024 };
  if (!preserveExistingReceipt) await persist();
  const prompts = ['  Reply exactly with: DSH_NATIVE_MODEL_READY.  ', `Use the read tool to read ${basename(fixturePath)} in the current workspace. Reply only with the value after proof_nonce=. Do not modify any file.`];
  const turns: AdapterEvent[][] = [];
  for (const [index, prompt] of prompts.entries()) {
    stage = `native-user-turn-${index + 1}`;
    const after = projected.length; report['userRequestsSent'] = index + 1; report['activeRequestId'] = (report['requestIds'] as string[])[index]; await persist();
    await adapter.send(runId, { text: prompt, nativeRequestId: (report['requestIds'] as string[])[index] });
    turns.push(await waitTurn(after));
    report['completedUserTurns'] = turns.length; await persist();
    console.log(JSON.stringify({ runId, phase: stage, completedUserTurns: turns.length }));
  }
  const first = turns[0]!.map(text).filter(Boolean).join('\n'); const second = turns[1]!.map(text).filter(Boolean).join('\n');
  const durable = raw.flatMap(frame => { const event = nativeEvent(frame); return event === undefined ? [] : [event]; });
  const results = durable.filter(event => event['type'] === 'tool/result').map(event => record(event['data']));
  const fixtureResult = results.some(data => { const message = record(data['message']); const id = String(data['toolCallId'] ?? message['toolCallId'] ?? ''); const content = JSON.stringify(message['content']); return allowedCalls.has(id) && message['isError'] !== true && content.includes(proof); });
  const usages = projected.filter(event => event.type === 'item.complete' && event.kind === 'usage').map(event => record((event as { data: unknown }).data));
  const headers = durable.filter(event => event['type'] === 'request/header').map(event => record(record(record(event['data'])['header'])['config']));
  const out = raw.filter(frame => frame.dir === 'out' && frame.ch === 'rpc:session/prompt').map(frame => record(record(record(frame.frame)['args'])['request']));
  const predicates = { fixedPhrase: first.includes('DSH_NATIVE_MODEL_READY.'), fixtureToolInput: allowedCalls.size > 0, fixtureToolResult: fixtureResult,
    fixtureProductionProjection: projected.some(event => event.type === 'item.complete' && event.kind === 'file.read' && resolve(workspace, String(record(event.data)['path'])) === fixturePath),
    fixtureFinalResponse: second.includes(proof), nativeUsage: usages.some(usage => Number(usage['inputTokens']) > 0 && Number(usage['outputTokens']) > 0),
    twoNativeCompletedTurns: turns.length === 2, actualModelIdentity: headers.length > 0 && headers.every(header => header['provider'] === provider && header['model'] === model),
    inputBytesPreserved: prompts.every((prompt, index) => String(record((out[index]?.['content'] as unknown[] | undefined)?.[0])['text']) === prompt), noUnauthorizedTools: violations.length === 0 };
  report = { ...report, status: Object.values(predicates).every(Boolean) ? 'passed' : 'failed', stage: 'complete', predicates, nativeUsage: usages,
    nativeRequestHeaders: headers, nativeFrames: raw.length, productionHandlerEvents: projected.length, observedToolCalls: allowedCalls.size, violations,
    firstResponse: first, secondResponse: second, rawTrace: `web_review/evidence/native-live-dsh.${runId}.jsonl`, productionProjection: `web_review/evidence/native-live-dsh.${runId}.projection.json`,
    evidenceScope: 'two real native DshAdapter.create/send turns; installed Host and production handlers; no deployment or external file writes' };
  if (report['status'] !== 'passed') process.exitCode = 1;
} catch (error) {
  report = { ...report, status: 'failed', stage, error: clean(error instanceof Error ? error.message : 'Unknown failure'), violations };
  process.exitCode = 1;
} finally {
  await adapter?.shutdown().catch(() => undefined); await setup?.close().catch(() => undefined); await sidecar?.stop().catch(() => undefined); if (root !== undefined) await rm(root, { recursive: true, force: true });
  if (raw.length > 0) {
    await writeFile(resolve(`web_review/evidence/native-live-dsh.${runId}.jsonl`), raw.map(sanitizedTrace).map(value => JSON.stringify(value)).join(String.fromCharCode(10)) + String.fromCharCode(10), { mode: 0o600 });
    const summaries = projected.map(event => event.type === 'item.delta' ? { ...event, append: { omitted: 'stream payload', sha256: hash(event.append), bytes: Buffer.byteLength(event.append) } } : violations.length > 0 ? { type: event.type, sha256: hash(JSON.stringify(event)), omitted: 'out-of-scope payload' } : event);
    await writeFile(resolve(`web_review/evidence/native-live-dsh.${runId}.projection.json`), JSON.stringify(clean(summaries), null, 2), { mode: 0o600 });
  }
  const changed = sourceFingerprint !== '' && sourceFingerprint !== await fingerprint();
  report = { ...report, finishedAt: new Date().toISOString(), sourceChangedDuringRun: changed, cleanup: { adapterClosed: true, setupClientClosed: true, sidecarStopped: true, temporaryHomeRemoved: root !== undefined } };
  if (changed) { report['status'] = 'failed'; report['error'] = 'Source changed during the native run; its receipt must not be presented as current-build verification'; process.exitCode = 1; }
  if (!preserveExistingReceipt) await persist();
  if (ledgerLock !== undefined) { await ledgerLock.close(); await rm(`${reportPath}.lock`, { force: true }); }
  console.log(JSON.stringify({ status: report['status'], runId, paidModel: true, userRequestsSent: report['userRequestsSent'], predicates: report['predicates'], report: 'web_review/evidence/native-live-dsh.json' }));
}
