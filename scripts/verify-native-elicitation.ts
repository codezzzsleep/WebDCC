/** Pinned native MCP + browser evidence with an isolated scripted model. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { CodexAdapter, PINNED_VERSION } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from '../browser-tests/helpers.js';
import { isolatedEnv } from '../packages/server/src/test-isolation.js';
import { startResponsesMock } from '../packages/testing/mock-models/src/responses-server.js';
import { sourceFingerprint } from './lib/gate-report.js';

const binaryIndex = process.argv.indexOf('--binary');
if (binaryIndex < 0 || !process.argv[binaryIndex + 1]) throw new Error('需要 --binary 指定隔离安装的 Codex 0.167.0');
const binary = resolve(process.argv[binaryIndex + 1]!);
const reportIndex = process.argv.indexOf('--report');
const reportPath = resolve(reportIndex < 0 ? 'web_review/evidence/native-elicitation.json' : process.argv[reportIndex + 1]!);
const isolated = isolatedEnv({ PATH: process.env['PATH'] }, 'wdcc-native-elicitation');
const workspacePath = join(isolated.dirs.root, 'workspace'); await mkdir(workspacePath);
const fixture = join(isolated.dirs.root, 'mcp-fixture.cjs');
const answerPath = join(isolated.dirs.root, 'mcp-answer.json');
await writeFile(fixture, `const { createInterface } = require('node:readline');
const { writeFileSync } = require('node:fs');
const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
let toolId;
createInterface({ input: process.stdin }).on('line', line => {
 const frame = JSON.parse(line);
 if (frame.id === 'fixture-elicitation' && 'result' in frame) {
  writeFileSync(${JSON.stringify(answerPath)}, JSON.stringify(frame.result));
  send({ jsonrpc: '2.0', id: toolId, result: { content: [{ type: 'text', text: 'MCP acknowledged the submitted details.' }] } }); return;
 }
 if (frame.id === undefined) return;
 if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'webdcc-fixture', version: '1' } } });
 else if (frame.method === 'tools/list') send({ jsonrpc: '2.0', id: frame.id, result: { tools: [{ name: 'ask_details', description: 'Ask for the fixture details.', annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { type: 'object', properties: {} } }] } });
 else if (frame.method === 'tools/call') {
  toolId = frame.id;
  send({ jsonrpc: '2.0', id: 'fixture-elicitation', method: 'elicitation/create', params: { mode: 'form', message: 'Real native MCP details', requestedSchema: { type: 'object', properties: { name: { type: 'string', title: 'Name', minLength: 1 }, count: { type: 'integer', title: 'Count', minimum: 2 } }, required: ['name', 'count'] } } });
 } else if (frame.method === 'ping') send({ jsonrpc: '2.0', id: frame.id, result: {} });
 else send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method unsupported by fixture' } });
});
`);
await writeFile(join(isolated.dirs.CODEX_HOME, 'config.toml'), `approval_policy = "on-request"\nsandbox_mode = "read-only"\n[mcp_servers.webdcc_fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fixture)}]\nstartup_timeout_sec = 10\n`);
const expectedText = 'Native MCP finished';
const modelRecord = join(isolated.dirs.root, 'model.jsonl');
const model = await startResponsesMock({ plan: [{ tool: { kind: 'other', name: 'ask_details', namespace: 'mcp__webdcc_fixture', input: {} } }, { text: expectedText }], recordPath: modelRecord, log: () => undefined });
const overrides = ['model_provider=wdcc_mock', 'model="mock-responses-1"', 'model_providers.wdcc_mock.name="WDCC mock"', `model_providers.wdcc_mock.base_url="${model.url}/v1"`, 'model_providers.wdcc_mock.wire_api="responses"', 'model_providers.wdcc_mock.env_key="WDCC_MOCK_KEY"'];
const ctx = await createSourceTestApp(); let browser: Browser | undefined;
const evidence: Record<string, unknown> = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(),
  kind: 'pinned-native-mcp-with-scripted-model-and-real-browser', baseline: PINNED_VERSION, paidModel: false, startedAt: new Date().toISOString(), passed: false };
try {
  const adapter = new CodexAdapter({ command: binary, configOverrides: overrides, env: { ...isolated.env, WDCC_MOCK_KEY: 'mock-fixture-key' } });
  assert.equal((await adapter.probe()).version, PINNED_VERSION);
  ctx.manager.registerAdapter(adapter); const workspace = ctx.store.createWorkspace('Native MCP', workspacePath);
  const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
  await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('missing listener');
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
  await page.goto(`${base}/s/${session.id}`);
  await ctx.manager.send(session.id, { text: 'Run the configured fixture MCP tool.' }, 'native-mcp-input');
  const card = page.getByTestId('question-card');
  const requestDeadline = Date.now() + 40_000;
  while (!ctx.store.allEvents(session.id).some(event => event.kind === 'question' && 'elicitation' in event.data)) {
    assert.ok(!ctx.store.allEvents(session.id).some(event => event.kind === 'turn.completed'), 'NOT_TRIGGERED: native turn completed without an MCP elicitation request');
    assert.ok(Date.now() < requestDeadline, 'NOT_TRIGGERED: no native MCP request before deadline');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await card.getByLabel(/Name/).waitFor({ timeout: 10_000 });
  const name = '  native original 中文  '; await card.getByLabel(/Name/).fill(name); await card.getByLabel(/Count/).fill('3');
  await card.getByRole('button', { name: '确认提交' }).click();
  await page.locator('[data-testid="question-card"][data-state="resolved"]').waitFor({ timeout: 15_000 });
  const result = JSON.parse(await readFile(answerPath, 'utf8')) as unknown;
  assert.deepEqual(result, { action: 'accept', content: { name, count: 3 } });
  const deadline = Date.now() + 20_000;
  while (!ctx.store.allEvents(session.id).some(event => event.kind === 'turn.completed')) {
    assert.ok(Date.now() < deadline, 'native turn failed to complete'); await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ctx.store.allEvents(session.id).some(event => event.kind === 'assistant.message' && (event.data as { text: string }).text === expectedText));
  await page.reload(); await page.locator('[data-testid="question-card"][data-state="resolved"]').waitFor({ timeout: 15_000 });
  assert.equal(await card.getAttribute('data-state'), 'resolved');
  evidence['nativeResponseFingerprint'] = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  evidence['webRequest'] = ctx.store.allEvents(session.id).find(event => event.kind === 'question');
  evidence['webResolution'] = ctx.store.allEvents(session.id).findLast(event => event.kind === 'question');
  evidence['nativeTerminal'] = ctx.store.allEvents(session.id).findLast(event => event.kind === 'turn.completed'); evidence['passed'] = true;
} catch (error) {
  evidence['error'] = error instanceof Error ? error.message : String(error);
  evidence['events'] = ctx.store.listSessions(true).map(session => ({ session, events: ctx.store.allEvents(session.id) }));
  evidence['nativeRecords'] = ctx.store.nativeEvents.list(undefined, 0, 100).map(record => ctx.store.nativeEvents.get(record.id));
  evidence['modelRequestTools'] = await readFile(modelRecord, 'utf8').then(text => text.split('\n').filter(Boolean).flatMap(line => {
    const row = JSON.parse(line) as { body?: { tools?: unknown[]; input?: unknown[] } };
    return row.body === undefined ? [] : [{ tools: row.body.tools, additionalTools: row.body.input?.filter(value => value && typeof value === 'object' && 'additional_tools' in value),
      toolResults: row.body.input?.filter(value => value && typeof value === 'object' && 'type' in value && ['function_call_output', 'custom_tool_call_output'].includes(String(value.type))) }];
  })).catch(() => []);
  process.exitCode = 1;
}
finally {
  await browser?.close(); await ctx.close(); await model.close();
  evidence['endedAt'] = new Date().toISOString(); await mkdir(resolve(reportPath, '..'), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`);
  await rm(isolated.dirs.root, { recursive: true, force: true }); process.stdout.write(`${JSON.stringify({ passed: evidence['passed'], error: evidence['error'], report: reportPath })}\n`);
}
