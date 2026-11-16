/** Actual pinned SDK/CLI with a controlled local model. Never calls a real Provider. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AdapterEvent, TraceFrame } from '../packages/protocol/src/index.js';
import { ClaudeAdapter, PINNED_CLI_VERSION, PINNED_SDK_VERSION, resolveNativeCli } from '../packages/adapters/claude/src/adapter.js';
import { startAnthropicMock } from '../packages/testing/mock-models/src/anthropic-server.js';
import { MockControl } from '../packages/testing/mock-models/src/mock-control.js';
import type { Plan } from '../packages/testing/mock-models/src/plan.js';
import { sourceFingerprint } from './lib/gate-report.js';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--out' || !args[1] || args[2] !== '--run-id' || !/^[0-9a-f-]{36}$/i.test(args[3] ?? '')) throw new Error('Usage: verify-claude-output.ts --out <new-private-directory> --run-id <uuid>');
const output = resolve(args[1]);
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Refuse to overwrite an earlier or uncertain run.
const runId = args[3]!;
const workspace = join(output, 'workspace'); const profile = join(output, 'profile');
await mkdir(workspace); await mkdir(profile);
const report: Record<string, unknown> = { runId, startedAt: new Date().toISOString(),
  source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(),
  scope: 'actual official SDK/CLI and native StructuredOutput tool, controlled local model; no live Provider or target platform',
  sdk: PINNED_SDK_VERSION, cli: PINNED_CLI_VERSION, realProviderRequests: 0, status: 'started', checks: {}, requests: [],
};
const native: TraceFrame[] = []; const events: AdapterEvent[] = [];
const checks: Record<string, 'passed' | 'failed' | 'not-triggered'> = {
  version: 'not-triggered', illegalSchema: 'not-triggered', schemaAccepted: 'not-triggered', nativeResult: 'not-triggered', projection: 'not-triggered',
};
report['checks'] = checks;
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const save = async () => {
  await writeFile(join(output, 'sdk.jsonl'), native.map(frame => JSON.stringify(frame)).join('\n') + '\n', { mode: 0o600 });
  await writeFile(join(output, 'events.json'), JSON.stringify(events, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
};
await save();
const value = { ok: true, items: ['alpha', 'beta'] };
const schema = { type: 'object', properties: { ok: { type: 'boolean' }, items: { type: 'array', items: { type: 'string' } } }, required: ['ok', 'items'], additionalProperties: false };
const plan: Plan = [{ tool: { kind: 'other', name: 'StructuredOutput', input: value } }];
const control = new MockControl(plan, workspace);
const mock = await startAnthropicMock({ plan, control, port: 0, log: () => undefined, recordPath: join(output, 'local-model.jsonl') });
const sessionId = `claude-output-${runId}`;
const adapter = new ClaudeAdapter({ env: { HOME: output, CLAUDE_CONFIG_DIR: profile,
  ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
  CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }, traceSink: { record: frame => native.push(structuredClone(frame)) } });
adapter.onEvent((_id, event) => events.push(structuredClone(event)));
try {
  const probe = await adapter.probe(); assert.equal(probe.compatible, true);
  const cli = resolveNativeCli(); assert.ok(cli);
  const sdk = dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));
  report['nativeHashes'] = { binary: hash(await readFile(cli)), sdk: hash(await readFile(join(sdk, 'sdk.mjs'))), schema: hash(await readFile(join(sdk, 'sdk.d.ts'))) };
  checks['version'] = 'passed'; await save();
  await adapter.create({ sessionId, cwd: workspace, providerId: 'local-output-fixture', model: 'claude-sonnet-5',
    provider: { id: 'local-output-fixture', name: 'Controlled local model', baseUrl: mock.url, protocols: ['anthropic-messages'], apiKey: 'local-fixture-key' } });
  const before = await adapter.nativeCatalog(sessionId);
  await assert.rejects(adapter.executeNativeControl(sessionId, { type: 'output', schema: { type: 'illegal-type' } }), { code: 'native-control-rejected' });
  assert.equal((await adapter.nativeCatalog(sessionId)).revision, before.revision);
  checks['illegalSchema'] = 'passed'; await save();
  const accepted = await adapter.executeNativeControl(sessionId, { type: 'output', schema }) as { selected: { outputFormat?: unknown } };
  assert.deepEqual(accepted.selected.outputFormat, { type: 'json_schema', schema });
  checks['schemaAccepted'] = 'passed'; await save();
  const inputId = randomUUID();
  report['requests'] = [{ inputId, submittedAt: new Date().toISOString(), purpose: 'single controlled native StructuredOutput tool flow' }];
  await save(); // Persist identity before submitting the one user turn.
  await adapter.send(sessionId, { text: 'Return {"ok":true,"items":["alpha","beta"]} using the configured structured output.', nativeRequestId: inputId });
  const deadline = Date.now() + 30_000;
  while (!events.some(event => event.type === 'turn.end')) {
    if (events.some(event => event.type === 'transport.closed')) throw new Error('Native disconnected before its result');
    if (Date.now() >= deadline) throw new Error('Native result NOT_TRIGGERED before deadline; no automatic retry');
    await new Promise<void>(done => setTimeout(done, 50));
  }
  const result = native.find(frame => frame.ch === 'sdk' && (frame.frame as { type?: string }).type === 'result')?.frame as { structured_output?: unknown; is_error?: boolean; uuid?: string } | undefined;
  assert.ok(result); assert.equal(result.is_error, false); assert.deepEqual(result.structured_output, value);
  checks['nativeResult'] = 'passed';
  const projected = events.filter(event => event.type === 'item.complete' && event.kind === 'structured.output');
  assert.equal(projected.length, 1); assert.deepEqual((projected[0] as { data: { value?: unknown } }).data.value, value);
  checks['projection'] = 'passed'; report['status'] = 'passed';
} catch (error) {
  report['status'] = 'failed'; report['error'] = error instanceof Error ? error.message : String(error);
  const next = Object.keys(checks).find(key => checks[key] === 'not-triggered'); if (next) checks[next] = 'failed';
  process.exitCode = 1;
} finally {
  await adapter.dispose(sessionId).catch(error => { report['cleanupError'] = String(error); process.exitCode = 1; });
  report['localModelRequests'] = control.requests.length;
  report['requestSummary'] = control.requests.map(request => ({ helper: request.helper === true, failed: request.failed === true,
    model: (request.body as { model?: string }).model, tools: ((request.body as { tools?: { name: string }[] }).tools ?? []).map(tool => tool.name) }));
  await writeFile(join(output, 'requests.json'), JSON.stringify(control.requests, null, 2) + '\n', { mode: 0o600 });
  await mock.close(); report['finishedAt'] = new Date().toISOString(); await save();
  report['evidenceHashes'] = Object.fromEntries(await Promise.all(['sdk.jsonl', 'events.json', 'requests.json', 'local-model.jsonl'].map(async name => [name, hash(await readFile(join(output, name)))])));
  await save(); console.log(JSON.stringify({ runId, status: report['status'], checks, scope: report['scope'], realProviderRequests: 0 }));
}
