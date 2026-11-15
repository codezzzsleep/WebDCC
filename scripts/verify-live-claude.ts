/** Explicit paid-provider diagnostic. Uses only a disposable native profile/workspace. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AdapterEvent, TraceFrame } from '../packages/protocol/src/index.js';
import { isValidEventData } from '../packages/protocol/src/index.js';
import { ClaudeAdapter, PINNED_CLI_VERSION, PINNED_SDK_VERSION, resolveNativeCli } from '../packages/adapters/claude/src/adapter.js';
import { record } from '../packages/adapters/claude/src/native.js';
import { sourceFingerprint } from './lib/gate-report.js';

const parameters = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]; const value = process.argv[index + 1];
  if (!['--credential-file', '--endpoint', '--model'].includes(name ?? '') || !value || value.startsWith('--') || parameters.has(name!)) {
    throw new Error('Usage: verify-live-claude.ts --credential-file <file> --endpoint <https-url> --model <native-model>');
  }
  parameters.set(name!, value);
}
if (parameters.size !== 3) throw new Error('Required parameters: --credential-file, --endpoint, --model');
const credentialFile = resolve(parameters.get('--credential-file')!);
const endpointUrl = new URL(parameters.get('--endpoint')!);
if (endpointUrl.protocol !== 'https:' || endpointUrl.username || endpointUrl.password || endpointUrl.search || endpointUrl.hash) throw new Error('Endpoint must be a credential-free HTTPS base URL');
const endpoint = endpointUrl.href;
const model = parameters.get('--model')!;
if (!model.trim() || model.length > 256 || model.includes('\0')) throw new Error('Native model parameter is invalid');
const output = resolve('web_review/evidence/native-live-claude.json');
const runId = randomUUID();
const sessionId = `live-claude-${runId}`;
const root = await mkdtemp(join(tmpdir(), 'wdcc-live-claude-'));
const workspace = join(root, 'workspace');
const profile = join(root, 'profile');
const fixture = join(workspace, 'fixture.txt');
const fixtureText = `wdcc-native-read-${randomUUID()}`;
const native: TraceFrame[] = [];
const events: AdapterEvent[] = [];
const requests: { id: string; scenario: string; submittedAt: string }[] = [];
const report: Record<string, unknown> = { formatVersion: 1, runId, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceFingerprint: sourceFingerprint(), observedAt: new Date().toISOString(), agent: 'claude-code', sdk: PINNED_SDK_VERSION, cli: PINNED_CLI_VERSION,
  environment: { os: platform(), arch: arch(), node: process.version }, provider: { endpoint, model, protocol: 'anthropic-messages' },
  isolatedProfile: true, productionDatabase: false, productionHistory: false, injectedSystemPrompt: false, paidModel: false,
  scope: 'Actual ClaudeAdapter SDK/CLI/provider smoke; no browser, manager ownership or full NP acceptance', status: 'started', requests,
};
let credential = '';
let adapter: ClaudeAdapter | undefined;
function safe(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (/(authorization|api[_-]?key|auth_token|oauth_token|cookie|credential|password|secret)/i.test(key)) return '<redacted>';
    let text = credential ? value.replaceAll(credential, '<redacted>') : value;
    text = text.replace(/\bBearer\s+[^\s]+/gi, 'Bearer <redacted>').replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '<redacted>');
    return text;
  }
  if (Array.isArray(value)) return value.map(item => safe(item, key));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, safe(item, name)]));
  return value;
}
async function checkpoint(): Promise<void> {
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(safe({ ...report, nativeFrames: native, adapterEvents: events }), null, 2) + '\n', { mode: 0o600 });
}
function projection(input: AdapterEvent[]): unknown {
  const items = new Map<string, { kind: string; data: Record<string, unknown> }>();
  for (const event of input) {
    if (event.type === 'item.start' || event.type === 'item.complete') items.set(event.itemKey, { kind: event.kind, data: record(event.data) });
    if (event.type === 'item.delta') {
      const item = items.get(event.itemKey); if (item !== undefined) item.data[event.field] = String(item.data[event.field] ?? '') + event.append;
    }
    if (event.type === 'item.update') { const item = items.get(event.itemKey); if (item !== undefined) item.data = { ...item.data, ...record(event.data) }; }
  }
  return [...items].filter(([, item]) => ['assistant.message', 'reasoning', 'file.read', 'tool.call', 'error'].includes(item.kind));
}
async function turn(scenario: string, prompt: string): Promise<Extract<AdapterEvent, { type: 'turn.end' }>> {
  const firstEvent = events.length;
  const id = randomUUID();
  requests.push({ id, scenario, submittedAt: new Date().toISOString() });
  report['status'] = `${scenario}:submitting`; report['paidModel'] = true;
  await checkpoint(); // Durable diagnostic job identity before an external model request.
  await adapter!.send(sessionId, { text: prompt, nativeRequestId: id });
  const deadline = Date.now() + 60000;
  for (;;) {
    const completed = events.slice(firstEvent).find((event): event is Extract<AdapterEvent, { type: 'turn.end' }> => event.type === 'turn.end');
    if (completed !== undefined) return completed;
    const closed = events.slice(firstEvent).find(event => event.type === 'transport.closed');
    if (closed !== undefined) throw new Error(`${scenario}: native transport closed before a result`);
    if (Date.now() > deadline) { await adapter!.interrupt(sessionId).catch(() => undefined); throw new Error(`${scenario}: timed out after 60 seconds; no automatic diagnostic retry`); }
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
}

try {
  credential = (await readFile(credentialFile, 'utf8')).trim();
  assert.ok(credential.length > 0, 'configured credential file is empty');
  await mkdir(workspace); await mkdir(profile);
  await writeFile(fixture, fixtureText + '\n');
  const provider = { id: 'authorized-live-claude', name: 'Authorized isolated live provider', baseUrl: endpoint, protocols: ['anthropic-messages'], apiKey: credential };
  const opts = { sessionId, cwd: workspace, providerId: provider.id, provider, model };
  adapter = new ClaudeAdapter({ env: { HOME: root, CLAUDE_CONFIG_DIR: profile, XDG_CONFIG_HOME: join(root, 'xdg'),
    CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }, catalogOptions: async () => opts,
    traceSink: { record: frame => { native.push(structuredClone(frame)); } },
  });
  adapter.onEvent((_id, event) => {
    events.push(structuredClone(event));
    if (event.type === 'native-id') report['nativeSessionId'] = event.nativeId;
    if (event.type === 'item.complete' && event.kind === 'approval.request') {
      const data = record(event.data);
      const permitted = data['tool'] === 'Read' && String(data['title']).includes(fixture);
      void adapter!.respond(sessionId, { approvalId: String(data['approvalId']), optionId: permitted ? 'allow' : 'deny' });
    }
  });
  const probe = await adapter.probe();
  assert.equal(probe.compatible, true, 'SDK/CLI baseline mismatch');
  const binary = resolveNativeCli(); assert.ok(binary);
  const binaryHash = createHash('sha256'); for await (const chunk of createReadStream(binary)) binaryHash.update(chunk);
  report['binarySha256'] = binaryHash.digest('hex');
  await adapter.create(opts);
  const catalog = await adapter.nativeCatalog(sessionId);
  report['models'] = catalog.models;
  const advertised = catalog.models.some(row => row.value === model || row.resolvedModel === model);
  report['catalogModelAdvertised'] = advertised;
  report['configurationFingerprint'] = createHash('sha256').update(JSON.stringify({ endpoint, model, systemPrompt: { type: 'preset', preset: 'claude_code' }, settingSources: ['user', 'project', 'local'], permissionOverride: null, isolatedProfile: true })).digest('hex');
  report['schemaFingerprint'] = createHash('sha256').update(await readFile('node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts')).digest('hex');
  await checkpoint();
  assert.ok(advertised, 'Native supportedModels does not advertise the configured target; no paid request sent');
  const minimal = await turn('minimal-response', 'Reply exactly CLAUDE_LIVE_OK. Do not use any tools.');
  const minimalResults = events.filter((event): event is Extract<AdapterEvent, { type: 'item.complete' }> => event.type === 'item.complete' && event.kind === 'assistant.message' && record(event.data)['nativePhase'] === 'final_result');
  report['minimal'] = { status: minimal.status, usage: minimal.usage, native: minimal.native, text: minimalResults.map(event => record(event.data)['text']) };
  assert.equal(minimal.status, 'completed', 'Minimal native turn did not complete');
  assert.equal(record(minimalResults.at(-1)?.data)['text'], 'CLAUDE_LIVE_OK', 'Minimal output predicate failed');
  report['status'] = 'minimal-response:passed'; await checkpoint();
  const firstReadFrame = native.length;
  const read = await turn('read-fixture', 'Use the native Read tool to read ./fixture.txt. Do not use a shell or any other tool and do not write files. Then reply exactly READ_OK: followed by the file content without its final newline.');
  const sdk = native.slice(firstReadFrame).filter(frame => frame.dir === 'in' && frame.ch === 'sdk').map(frame => record(frame.frame));
  const reads = sdk.flatMap(message => message['type'] === 'assistant' ? (Array.isArray(record(message['message'])['content']) ? record(message['message'])['content'] as unknown[] : []) : [])
    .map(record).filter(block => block['type'] === 'tool_use' && block['name'] === 'Read');
  const readCall = reads.find(block => resolve(workspace, String(record(block['input'])['file_path'])) === fixture);
  const toolId = readCall?.['id'];
  const toolResults = sdk.filter(message => message['type'] === 'user').flatMap(message => {
    const content = record(message['message'])['content']; return (Array.isArray(content) ? content : []).map(record).filter(block => block['type'] === 'tool_result' && block['tool_use_id'] === toolId).map(block => ({ block, structured: message['tool_use_result'] }));
  });
  const exactRead = toolResults.find(result => result.block['is_error'] !== true && JSON.stringify(result.structured ?? result.block['content']).includes(fixtureText));
  const finalReadText = events.filter((event): event is Extract<AdapterEvent, { type: 'item.complete' }> => event.type === 'item.complete' && event.kind === 'assistant.message' && record(event.data)['nativePhase'] === 'final_result').at(-1);
  const readCompleted = events.some(event => event.type === 'item.complete' && event.kind === 'file.read' && event.itemKey === `tool-${toolId}` && resolve(workspace, String(record(event.data)['path'])) === fixture);
  const predicates = { nativeReadCall: readCall !== undefined, successfulExactToolResult: exactRead !== undefined, productionReadCompletion: readCompleted,
    nativeStreamObserved: sdk.some(message => message['type'] === 'stream_event'), nativeCompleted: read.status === 'completed', exactFinalOutput: record(finalReadText?.data)['text'] === `READ_OK:${fixtureText}`,
    fixtureUnchanged: (await readFile(fixture, 'utf8')) === fixtureText + '\n', noUnexpectedTools: sdk.every(message => message['type'] !== 'assistant' || !Array.isArray(record(message['message'])['content']) || (record(message['message'])['content'] as unknown[]).map(record).every(block => block['type'] !== 'tool_use' || block['name'] === 'Read')) };
  report['readFixture'] = { predicates, toolUseId: toolId, nativeToolResult: exactRead, usage: read.usage, status: read.status };
  const replay = ClaudeAdapter.replay(sessionId); const replayed: AdapterEvent[] = [];
  for (const frame of native) if (frame.dir === 'in' && frame.ch === 'sdk') replayed.push(...replay.feed(frame));
  assert.deepEqual(projection(replayed), projection(events), 'Live and replay production Handler projections differ');
  assert.ok(events.every(event => event.type !== 'item.complete' || isValidEventData(event.kind, event.data)), 'Production event schema predicate failed');
  report['productionHandlerReplayEquivalent'] = true;
  report['usage'] = adapter.nativeState(sessionId).usage;
  assert.ok(Object.values(predicates).every(Boolean), 'Read fixture native input/output predicates failed');
  report['status'] = 'passed'; report['passed'] = true;
} catch (failure) {
  report['status'] = 'failed'; report['passed'] = false;
  report['error'] = failure instanceof Error ? failure.message : String(failure);
  process.exitCode = 1;
} finally {
  await adapter?.dispose(sessionId).catch(failure => { report['disposeError'] = failure instanceof Error ? failure.message : String(failure); });
  report['sourceFingerprintAfter'] = sourceFingerprint();
  report['finishedAt'] = new Date().toISOString();
  await checkpoint();
  await rm(root, { recursive: true, force: true });
  const summary = JSON.stringify(safe({ passed: report['passed'], status: report['status'], paidModel: report['paidModel'], error: report['error'], report: output }));
  assert.ok(!credential || !summary.includes(credential), 'Secret leaked into diagnostic summary');
  process.stdout.write(summary + '\n');
}
