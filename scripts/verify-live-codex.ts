/** Explicit paid-provider smoke. Durable diagnostic admission prevents a lost
 * response or repeated invocation from silently submitting another model turn. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AdapterEvent, TraceFrame } from '../packages/protocol/src/index.js';
import { isValidEventData } from '../packages/protocol/src/index.js';
import { CodexAdapter, PINNED_VERSION } from '../packages/adapters/codex/src/adapter.js';
import { captureProcess } from '../packages/server/src/process-identity.js';
import { sourceFingerprint } from './lib/gate-report.js';

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]; const value = process.argv[index + 1];
  if (!['--binary', '--credential-file', '--endpoint', '--model', '--verify-recording', '--live-script-sha'].includes(name ?? '') || !value || value.startsWith('--') || args.has(name!)) throw new Error('Required arguments: --binary --credential-file --endpoint --model');
  args.set(name!, value);
}
if (!['--binary', '--credential-file', '--endpoint', '--model'].every(name => args.has(name))) throw new Error('Required arguments: --binary --credential-file --endpoint --model');
const binary = resolve(args.get('--binary')!);
const credentialFile = resolve(args.get('--credential-file')!);
let suppliedEndpoint: URL;
try { suppliedEndpoint = new URL(args.get('--endpoint')!); } catch { throw new Error('Endpoint must be a HTTPS base URL'); }
if (suppliedEndpoint.protocol !== 'https:' || suppliedEndpoint.username || suppliedEndpoint.password || suppliedEndpoint.search || suppliedEndpoint.hash) throw new Error('Endpoint must be a credential-free HTTPS base URL');
// Codex providers use an OpenAI API base; a bare origin explicitly selects /v1.
const endpoint = suppliedEndpoint.pathname === '/' ? new URL('v1/', suppliedEndpoint).href : suppliedEndpoint.href;
const model = args.get('--model')!;
if (!model.trim() || model.length > 256 || model.includes('\0')) throw new Error('Model argument is invalid');
const output = resolve('web_review/evidence/native-live-codex.json');
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
if (args.has('--verify-recording')) {
  if (resolve(args.get('--verify-recording')!) !== output) throw new Error('Offline verification is limited to the fixed Codex diagnostic report');
  await revalidateRecording(output);
  process.exit(0);
}
const lockPath = output + '.lock';
await mkdir(dirname(output), { recursive: true });
try { await readFile(output); throw new Error('Existing Codex report prevents another paid run; review it before authorizing a new run'); }
catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
const runId = randomUUID();
let lock;
try { lock = await open(lockPath, 'wx', 0o600); }
catch { throw new Error('A durable Codex run lock already exists; no model request will be repeated'); }
await lock.writeFile(JSON.stringify({ runId, process: captureProcess(process.pid), createdAt: new Date().toISOString(), report: output }) + '\n');
await lock.sync(); await lock.close();

const native: TraceFrame[] = []; const events: AdapterEvent[] = [];
const requests: { id: string; scenario: string; submittedAt: string; nativeTurnId?: string; inputBytes?: number; inputUnchanged?: boolean }[] = [];
const report: Record<string, unknown> = { formatVersion: 1, runId, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  liveScriptSha256: createHash('sha256').update(await readFile('scripts/verify-live-codex.ts')).digest('hex'),
  sourceFingerprint: sourceFingerprint(), startedAt: new Date().toISOString(), agent: 'codex', cli: PINNED_VERSION,
  environment: { os: platform(), arch: arch(), node: process.version }, provider: { suppliedEndpoint: suppliedEndpoint.href, responsesBaseUrl: endpoint, model, protocol: 'openai-responses' },
  scope: 'Actual CodexAdapter/binary/Provider smoke, not browser or full native acceptance', paidModel: false, passed: false, status: 'admitted',
  requests, nativeGoalCreated: false, productionDatabase: false, productionHistory: false, isolatedProfile: true, maxUserTurns: 2,
};
let credential = ''; let root: string | undefined; let adapter: CodexAdapter | undefined;
const sessionId = `live-codex-${runId}`;
function safe(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (/(authorization|api[_-]?key|auth_token|oauth_token|cookie|credential|password|secret)/i.test(key)) return '<redacted>';
    return (credential ? value.replaceAll(credential, '<redacted>') : value).replace(/\bBearer\s+[^\s]+/gi, 'Bearer <redacted>').replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '<redacted>');
  }
  if (Array.isArray(value)) return value.map(item => safe(item, key));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, safe(item, name)]));
  return value;
}
async function checkpoint(): Promise<void> {
  const serialized = JSON.stringify(safe({ ...report, nativeFrames: native, adapterEvents: events }), null, 2) + '\n';
  const file = await open(output + '.writing', 'w', 0o600);
  try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
  const { rename } = await import('node:fs/promises'); await rename(output + '.writing', output);
}
const finalMessage = (event: AdapterEvent): event is Extract<AdapterEvent, { type: 'item.complete' }> => event.type === 'item.complete' && event.kind === 'assistant.message' && object(event.data)['nativePhase'] === 'final_answer';
function projection(input: AdapterEvent[]): unknown {
  const items = new Map<string, { kind: string; data: Record<string, unknown> }>();
  for (const event of input) {
    if (event.type === 'item.start' || event.type === 'item.complete') items.set(event.itemKey, { kind: event.kind, data: { ...object(event.data) } });
    if (event.type === 'item.delta') { const item = items.get(event.itemKey); if (item) item.data[event.field] = String(item.data[event.field] ?? '') + event.append; }
    if (event.type === 'item.update') { const item = items.get(event.itemKey); if (item) item.data = { ...item.data, ...object(event.data) }; }
  }
  return [...items].filter(([, item]) => ['assistant.message', 'reasoning', 'command', 'file.change', 'file.read', 'error'].includes(item.kind));
}
function fixtureReadCommand(command: string, cwd: string, fixture: string): boolean {
  // Codex 0.167.0 records its fixed launch wrapper. Accept only one literal cat,
  // not an arbitrary script that happens to have a parsed "read" action.
  return ["cat -- fixture.txt", "/bin/bash -lc 'cat -- fixture.txt'"].includes(command) && resolve(cwd, 'fixture.txt') === fixture;
}
async function revalidateRecording(path: string): Promise<void> {
  const originalBytes = await readFile(path);
  const original = JSON.parse(originalBytes.toString('utf8')) as Record<string, unknown>;
  assert.equal(original['cli'], PINNED_VERSION);
  assert.equal(object(original['provider'])['model'], model);
  assert.equal(object(original['provider'])['responsesBaseUrl'], endpoint);
  const recordedFrames = original['nativeFrames'] as TraceFrame[];
  const recordedEvents = original['adapterEvents'] as AdapterEvent[];
  const read = object(original['readFixture']); const oldPredicates = object(read['predicates']);
  assert.equal(oldPredicates['exactFinalOutput'], true, 'The original live run did not match its independently generated fixture expectation');
  assert.equal(oldPredicates['fixtureUnchanged'], true);
  const cwd = String(original['isolatedWorkspace']); const fixture = resolve(cwd, 'fixture.txt');
  const commands = read['completedCommands'] as Record<string, unknown>[];
  const command = commands.find(item => item['type'] === 'commandExecution' && item['status'] === 'completed' && item['exitCode'] === 0 && fixtureReadCommand(String(item['command']), String(item['cwd']), fixture));
  assert.ok(command, 'No successful standard native wrapper executed the exact fixture read');
  const stdout = String(command['aggregatedOutput']);
  const final = recordedEvents.filter((event): event is Extract<AdapterEvent, { type: 'item.complete' }> => event.type === 'item.complete' && event.kind === 'assistant.message' && object(event.data)['nativePhase'] === 'final_answer').at(-1);
  const originalExpectation = String(object(final?.data)['text']).slice('READ_OK:'.length);
  const predicates = { nativeStandardSingleCat: fixtureReadCommand(String(command['command']), String(command['cwd']), fixture),
    nativeParsedReadPath: Array.isArray(command['commandActions']) && command['commandActions'].length === 1 && object(command['commandActions'][0])['type'] === 'read' && resolve(String(object(command['commandActions'][0])['path'])) === fixture,
    nativeExitZero: command['exitCode'] === 0, exactAggregatedStdout: stdout === originalExpectation + '\n',
    exactModelAnswer: object(final?.data)['text'] === `READ_OK:${originalExpectation}`, nativeCompleted: read['status'] === 'completed',
    productionCommandCompletion: recordedEvents.some(event => event.type === 'item.complete' && event.kind === 'command' && event.itemKey === command['id'] && object(event.data)['exitCode'] === 0 && object(event.data)['outputTail'] === stdout),
    oneCommandOnly: commands.length === 1, noSyntheticFileRead: oldPredicates['noSyntheticFileRead'] === true, noFileChanges: oldPredicates['noFileChanges'] === true,
    originalFixtureUnchanged: oldPredicates['fixtureUnchanged'] === true, noNativeGoal: oldPredicates['noNativeGoal'] === true,
    inputBytesUnchanged: Array.isArray(original['requests']) && original['requests'].length === 2 && original['requests'].every(request => object(request)['inputUnchanged'] === true),
  };
  const replay = CodexAdapter.replay('recorded-codex', String(original['nativeThreadId'])); const replayed: AdapterEvent[] = [];
  for (const frame of recordedFrames) if (frame.dir === 'in') replayed.push(...replay.feed(frame));
  assert.deepEqual(projection(replayed), projection(recordedEvents), 'Recorded live projection differs from the current production replay Handler');
  assert.ok(Object.values(predicates).every(Boolean), 'Captured native predicates failed offline revalidation');
  const binaryHash = createHash('sha256'); for await (const chunk of createReadStream(binary)) binaryHash.update(chunk);
  assert.equal(binaryHash.digest('hex'), original['binarySha256'], 'Native binary changed since the paid run');
  const { stat } = await import('node:fs/promises');
  const adapterSources: Record<string, unknown> = {};
  for (const file of ['adapter.ts', 'rpc.ts', 'controls.ts', 'permissions.ts', 'native.ts', 'elicitation.ts']) {
    const path = `packages/adapters/codex/src/${file}`; const info = await stat(path);
    adapterSources[path] = { sha256: createHash('sha256').update(await readFile(path)).digest('hex'), modifiedAt: info.mtime.toISOString(),
      unchangedSinceBeforeLiveRun: info.mtimeMs <= Date.parse(String(original['startedAt'])) && info.ctimeMs <= Date.parse(String(original['startedAt'])) };
  }
  const liveScriptSha256 = original['liveScriptSha256'] ?? args.get('--live-script-sha');
  assert.ok(typeof liveScriptSha256 === 'string' && /^[a-f0-9]{64}$/.test(liveScriptSha256), 'This older recording requires --live-script-sha from its preserved executed source');
  const revalidatedPath = path.replace(/\.json$/, '-revalidated.json');
  const offline = { formatVersion: 1, mode: 'offline verification of captured real paid-model run', passed: true, paidModel: true, additionalUserTurns: 0,
    runId: original['runId'], originalReport: path, originalFailedResult: { passed: original['passed'], status: original['status'], error: original['error'], predicates: oldPredicates },
    originalRedactedReportSha256: createHash('sha256').update(originalBytes).digest('hex'), originalLiveScriptSha256: liveScriptSha256,
    liveSourceFingerprint: original['sourceFingerprint'], liveSourceFingerprintAfter: original['sourceFingerprintAfter'], sourceChangedDuringRun: original['sourceChangedDuringRun'],
    scope: 'Local actual Codex behavior only; source changed during the run, so this is not current whole-repository release acceptance', adapterSources,
    currentValidatorSha256: createHash('sha256').update(await readFile('scripts/verify-live-codex.ts')).digest('hex'),
    predicates, nativeCommand: command, nativeTerminal: read['native'], requests: original['requests'], nativeUsage: original['nativeUsage'], projectedUsage: original['projectedUsage'],
    productionLiveReplayEquivalent: true, observations: { commandOutputDeltaObserved: oldPredicates['commandOutputDeltaObserved'] === true,
      commandOutputSource: 'Native completed commandExecution.aggregatedOutput', assistantOutputDeltaObserved: recordedFrames.some(frame => object(frame.frame)['method'] === 'item/agentMessage/delta'),
      noDeltaReason: 'The native command completed in 0 ms; the completed item contained full stdout. No stdout streaming acceptance is claimed.' }, verifiedAt: new Date().toISOString() };
  await writeFile(revalidatedPath, JSON.stringify(offline, null, 2) + '\n', { mode: 0o600 });
  assert.deepEqual(await readFile(path), originalBytes, 'The original failed report was modified');
  process.stdout.write(JSON.stringify({ passed: true, offline: true, additionalUserTurns: 0, originalPreserved: true, report: revalidatedPath }) + '\n');
}
async function userTurn(scenario: string, text: string): Promise<{ ended: Extract<AdapterEvent, { type: 'turn.end' }>; events: AdapterEvent[]; frames: TraceFrame[] }> {
  assert.ok(requests.length < 2, 'Two-user-turn limit reached');
  const firstEvent = events.length; const firstFrame = native.length;
  const request = { id: randomUUID(), scenario, submittedAt: new Date().toISOString() } as typeof requests[number];
  requests.push(request); report['paidModel'] = true; report['status'] = `${scenario}:submitting`;
  await checkpoint(); // Persist external request identity before native admission.
  await adapter!.send(sessionId, { text, nativeRequestId: request.id });
  const submitted = native.slice(firstFrame).find(frame => frame.dir === 'out' && object(frame.frame)['method'] === 'turn/start');
  const params = object(object(submitted?.frame)['params']);
  const parts = Array.isArray(params['input']) ? params['input'].map(object).filter(part => part['type'] === 'text') : [];
  const actual = parts.map(part => String(part['text'])).join('');
  request.inputBytes = Buffer.byteLength(text); request.inputUnchanged = Buffer.from(actual).equals(Buffer.from(text));
  assert.equal(params['clientUserMessageId'], request.id, 'Native input identity was not preserved');
  assert.equal(request.inputUnchanged, true, 'User text bytes changed');
  assert.equal(object(params['sandboxPolicy'])['type'], 'readOnly');
  assert.equal(object(params['sandboxPolicy'])['networkAccess'], false);
  await checkpoint();
  const deadline = Date.now() + 60000;
  for (;;) {
    const ended = events.slice(firstEvent).find((event): event is Extract<AdapterEvent, { type: 'turn.end' }> => event.type === 'turn.end');
    if (ended) { request.nativeTurnId = ended.nativeTurnId; return { ended, events: events.slice(firstEvent), frames: native.slice(firstFrame) }; }
    if (events.slice(firstEvent).some(event => event.type === 'transport.closed')) throw new Error(`${scenario}: native transport closed before terminal result`);
    if (Date.now() > deadline) { await adapter!.interrupt(sessionId).catch(() => undefined); throw new Error(`${scenario}: timed out; no diagnostic retry`); }
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
}

try {
  await checkpoint();
  credential = (await readFile(credentialFile, 'utf8')).trim(); assert.ok(credential, 'Credential file is empty');
  report['schemaFingerprint'] = createHash('sha256').update(await readFile('packages/adapters/codex/src/json-schema/codex_app_server_protocol.schemas.json')).digest('hex');
  root = await mkdtemp(join(tmpdir(), 'wdcc-live-codex-'));
  const workspace = join(root, 'workspace'); const profile = join(root, 'profile');
  await mkdir(workspace); await mkdir(profile);
  const fixture = join(workspace, 'fixture.txt'); const fixtureText = `wdcc-codex-read-${randomUUID()}`;
  await writeFile(fixture, fixtureText + '\n');
  report['fixture'] = { path: fixture, text: fixtureText + '\n' };
  report['isolatedWorkspace'] = workspace; report['isolatedProfilePath'] = profile;
  const env: NodeJS.ProcessEnv = { HOME: root, CODEX_HOME: profile, XDG_CONFIG_HOME: join(root, 'xdg') };
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) if (process.env[name] !== undefined) env[name] = process.env[name];
  adapter = new CodexAdapter({ command: binary, env, traceSink: { record: frame => native.push(structuredClone(frame)) } });
  adapter.onEvent((_id, event) => {
    events.push(structuredClone(event));
    if (event.type === 'turn.start') { const request = requests.at(-1); if (request) request.nativeTurnId = event.nativeTurnId; }
    if (event.type === 'item.complete' && event.kind === 'approval.request') {
      // The smoke authorizes only this exact fixture read; never escalate the sandbox.
      const data = object(event.data); const params = object(object(event.native)['params']);
      const command = Array.isArray(params['command']) ? params['command'].map(String).join(' ') : String(params['command'] ?? '');
      const permitted = data['tool'] === 'exec_command' && fixtureReadCommand(command, String(params['cwd'] ?? workspace), fixture) && params['networkApprovalContext'] == null;
      void adapter!.respond(sessionId, { approvalId: String(data['approvalId']), optionId: permitted ? 'accept' : 'decline' }).catch(failure => { report['approvalError'] = failure instanceof Error ? failure.message : String(failure); });
    }
  });
  const probe = await adapter.probe(); assert.equal(probe.compatible, true, 'Native baseline mismatch');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(binary)) hash.update(chunk);
  report['binarySha256'] = hash.digest('hex');
  const models = await adapter.listModels(); report['models'] = models;
  assert.ok(models.some(row => row.id === model), 'Target absent from the native model catalog; no paid request sent');
  const provider = { id: 'authorized-live-codex', name: 'Authorized isolated live Codex provider', baseUrl: endpoint, protocols: ['openai-responses'], apiKey: credential };
  const created = await adapter.create({ sessionId, cwd: workspace, providerId: provider.id, provider, model, accessMode: 'read-only',
    onManagedProcess: pid => { report['nativeProcess'] = captureProcess(pid); } });
  report['nativeThreadId'] = created.nativeId;
  const permissions = events.filter((event): event is Extract<AdapterEvent, { type: 'permissions' }> => event.type === 'permissions').at(-1);
  assert.equal(permissions?.observation.effective, 'read-only', 'Native read-only policy was not confirmed');
  const start = native.find(frame => frame.dir === 'out' && object(frame.frame)['method'] === 'thread/start');
  const startParams = object(object(start?.frame)['params']);
  assert.ok(!['baseInstructions', 'developerInstructions', 'dynamicTools'].some(name => startParams[name] !== undefined), 'Platform injected native instructions/tools');
  report['configurationFingerprint'] = createHash('sha256').update(JSON.stringify({ endpoint, model, accessMode: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false }, nativeInstructions: 'inherit' })).digest('hex');
  await checkpoint();
  const minimal = await userTurn('minimal-response', 'Reply exactly CODEX_LIVE_OK. Do not use any tools.  \r\n');
  report['minimal'] = { native: minimal.ended.native, status: minimal.ended.status, text: minimal.events.filter(finalMessage).map(event => object(event.data)['text']) };
  assert.equal(minimal.ended.status, 'completed'); assert.equal(object(minimal.events.filter(finalMessage).at(-1)?.data)['text'], 'CODEX_LIVE_OK');
  assert.ok(!minimal.events.some(event => event.type === 'item.start' && ['command', 'file.change', 'tool.call', 'file.read'].includes(event.kind)), 'Minimal response unexpectedly used a tool');
  const read = await userTurn('read-fixture', 'Use the native exec_command tool to run only cat -- fixture.txt in the current working directory. Do not write files or run any other command. Then reply exactly READ_OK: followed by the file content without the final newline.');
  const completedCommands = read.frames.filter(frame => frame.dir === 'in' && object(frame.frame)['method'] === 'item/completed').map(frame => object(object(object(frame.frame)['params'])['item'])).filter(item => item['type'] === 'commandExecution');
  const actualRead = completedCommands.find(item => item['status'] === 'completed' && item['exitCode'] === 0 && String(item['aggregatedOutput'] ?? '').includes(fixtureText)
    && resolve(String(item['cwd'])) === workspace && fixtureReadCommand(String(item['command']), workspace, fixture));
  const allItems = read.frames.filter(frame => frame.dir === 'in' && object(frame.frame)['method'] === 'item/completed').map(frame => object(object(object(frame.frame)['params'])['item']));
  const predicates = { nativeCommandRead: actualRead !== undefined, nativeExitZero: actualRead?.['exitCode'] === 0,
    successfulExactOutput: String(actualRead?.['aggregatedOutput'] ?? '').includes(fixtureText), nativeCompleted: read.ended.status === 'completed',
    exactFinalOutput: object(read.events.filter(finalMessage).at(-1)?.data)['text'] === `READ_OK:${fixtureText}`,
    productionCommandCompletion: read.events.some(event => event.type === 'item.complete' && event.kind === 'command' && event.itemKey === actualRead?.['id'] && object(event.data)['exitCode'] === 0 && String(object(event.data)['outputTail']).includes(fixtureText)),
    noSyntheticFileRead: !read.events.some(event => event.type === 'item.complete' && event.kind === 'file.read'),
    noFileChanges: !allItems.some(item => item['type'] === 'fileChange'), fixtureUnchanged: (await readFile(fixture, 'utf8')) === fixtureText + '\n',
    noUnexpectedCommands: completedCommands.length === 1 && completedCommands.every(item => fixtureReadCommand(String(item['command']), String(item['cwd']), fixture)),
    nativeCommandCompletionObserved: actualRead !== undefined,
    noNativeGoal: !native.some(frame => frame.dir === 'out' && /goal\/(?:set|clear)/.test(String(object(frame.frame)['method'])) || frame.dir === 'in' && object(frame.frame)['method'] === 'thread/goal/updated'),
  };
  report['readFixture'] = { predicates, nativeCommand: actualRead, completedCommands, status: read.ended.status, native: read.ended.native };
  report['observations'] = { commandOutputDeltaObserved: read.frames.some(frame => object(frame.frame)['method'] === 'item/commandExecution/outputDelta'),
    assistantOutputDeltaObserved: read.frames.some(frame => object(frame.frame)['method'] === 'item/agentMessage/delta') };
  const usage = native.filter(frame => frame.dir === 'in' && object(frame.frame)['method'] === 'thread/tokenUsage/updated').map(frame => object(object(frame.frame)['params']));
  report['nativeUsage'] = usage; report['projectedUsage'] = events.filter(event => event.type === 'item.complete' && event.kind === 'usage');
  assert.ok(usage.some(item => Number(object(object(item['tokenUsage'])['total'])['inputTokens']) > 0 && Number(object(object(item['tokenUsage'])['total'])['outputTokens']) > 0), 'Real native usage was not observed');
  const replay = CodexAdapter.replay(sessionId, created.nativeId); const replayed: AdapterEvent[] = [];
  for (const frame of native) if (frame.dir === 'in') replayed.push(...replay.feed(frame));
  assert.deepEqual(projection(replayed), projection(events), 'Production live/replay item projection differs');
  assert.ok(events.every(event => event.type !== 'item.complete' || isValidEventData(event.kind, event.data)), 'Production event schema check failed');
  report['productionHandlerReplayEquivalent'] = true;
  assert.ok(Object.values(predicates).every(Boolean), 'Native command input/output predicates failed');
  report['passed'] = true; report['status'] = 'passed';
} catch (failure) { report['passed'] = false; report['status'] = 'failed'; report['error'] = failure instanceof Error ? failure.message : String(failure); process.exitCode = 1; }
finally {
  await adapter?.dispose(sessionId).catch(failure => { report['disposeError'] = failure instanceof Error ? failure.message : String(failure); });
  if (root) { await rm(root, { recursive: true, force: true }); report['temporaryWorkspaceRemoved'] = true; }
  report['sourceFingerprintAfter'] = sourceFingerprint(); report['finishedAt'] = new Date().toISOString();
  report['sourceChangedDuringRun'] = report['sourceFingerprintAfter'] !== report['sourceFingerprint'];
  await checkpoint();
  const summary = JSON.stringify(safe({ passed: report['passed'], status: report['status'], paidModel: report['paidModel'], userTurns: requests.length, error: report['error'], report: output, lock: lockPath }));
  assert.ok(!credential || !summary.includes(credential), 'Credential appeared in summary');
  process.stdout.write(summary + '\n');
}
