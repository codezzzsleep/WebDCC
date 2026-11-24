/**
 * Opt-in target-platform acceptance using an already deployed WebDCC bundle.
 * Capture is a side channel: native request and response bodies are forwarded
 * unchanged. This script never patches a native CLI, SDK or Host.
 *
 * node scripts/accept-deployed-trajectories.mjs <private-config.json> <agent> [--live]
 */
import assert from 'node:assert/strict';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { URL, pathToFileURL } from 'node:url';
import { closeVerifiedServer, finalizeVerifiedServer } from './deployed-native-cleanup.mjs';

const [configPath, agent, flag] = process.argv.slice(2);
assert(['codex', 'claude-code', 'dsh'].includes(agent), 'Select one of all three Agents');
const config = JSON.parse(await readFile(resolve(configPath), 'utf8'));
const acceptanceScope = config.acceptanceScope ?? 'target-deployment';
assert(['target-deployment', 'source-native'].includes(acceptanceScope), 'Select an explicit source or target acceptance scope');
const live = flag === '--live';
const selected = config.agents[agent];
assert(selected && selected.credentialFile && selected.model && selected.upstream);
const release = await realpath(config.release);
const manifest = JSON.parse(await readFile(join(release, 'manifest.json'), 'utf8'));
assert.equal(manifest.commit, config.expectedCommit, 'Deployment changed since admission');
const root = resolve(config.out, agent);
await mkdir(root, { recursive: true, mode: 0o700 });
const lock = await open(join(root, 'admission.lock'), 'wx', 0o600);
const runId = randomUUID();
await lock.writeFile(JSON.stringify({ runId, pid: process.pid, live, startedAt: new Date().toISOString() }));
await lock.sync(); await lock.close();
const credential = (await readFile(selected.credentialFile, 'utf8')).trim();
assert(credential && !credential.includes('\n'), 'Credential must be loaded from one private file');
const providerUrl = new URL(selected.upstream);
assert.equal(providerUrl.protocol, 'https:');
assert(!providerUrl.username && !providerUrl.password && !providerUrl.search, 'Provider URL must be credential-free');
const secrets = new Set([credential]);
const hash = input => createHash('sha256').update(input).digest('hex');
function safe(value, field = '') {
  if (typeof value === 'string') {
    if (/authorization|api.?key|auth.?token|cookie|password|secret/i.test(field)) return '<redacted>';
    let out = value;
    for (const secret of secrets) if (secret) out = out.replaceAll(secret, '<redacted>');
    return out.replace(/([?&]token=)[^&\s]+/gi, '$1<redacted>');
  }
  if (Array.isArray(value)) return value.map(item => safe(item, field));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safe(item, key)]));
  return value;
}
async function atomic(path, value) {
  const file = await open(path + '.writing', 'w', 0o600);
  try { await file.writeFile(JSON.stringify(safe(value), null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(path + '.writing', path);
}
const report = {
  formatVersion: 1, runId, agent, live, pid: process.pid, startedAt: new Date().toISOString(),
  acceptanceScope,
  deployment: { release, commit: manifest.commit, sourceFingerprint: manifest.sourceFingerprint, role: acceptanceScope === 'source-native' ? 'source-candidate' : 'target-release' },
  provider: { upstream: selected.upstream, model: selected.model, protocol: selected.protocol },
  nativeBehavior: `official CLI/SDK/Host; ${acceptanceScope === 'source-native' ? 'source-candidate' : 'deployed production'} server and UI bundle; no injected adapter or modified model bodies`,
  validatorSha256: hash(await readFile(new URL(import.meta.url))),
  isolation: 'dedicated native profile, workspace and database on target host; not personal production sessions',
  status: 'admitted', requests: [], userCommands: [], browserErrors: [], checks: {}, pending: [],
};
const ledger = join(root, 'report.json');
let saves = Promise.resolve();
const save = () => {
  const snapshot = JSON.parse(JSON.stringify(report));
  saves = saves.then(() => atomic(ledger, snapshot));
  return saves;
};
await save();
const paths = { profile: join(root, 'profile'), workspace: join(root, 'workspace'), data: join(root, 'data') };
for (const path of Object.values(paths)) await mkdir(path, { recursive: true, mode: 0o700 });
const fixture = 'native-proof-' + randomUUID();
await writeFile(join(paths.workspace, 'fixture.txt'), fixture + '\n', { mode: 0o600 });
report.fixture = { path: 'fixture.txt', contentSha256: hash(fixture + '\n'), expectedText: fixture };
const environment = {
  HOME: paths.profile, CODEX_HOME: join(paths.profile, 'codex'),
  CLAUDE_CONFIG_DIR: join(paths.profile, 'claude'), DSH_HOME: join(paths.profile, 'dsh'),
  XDG_CONFIG_HOME: join(paths.profile, 'xdg'), XDG_CACHE_HOME: join(paths.profile, 'cache'),
  WDCC_DSH_MODE: 'spawn', WDCC_DSH_PORT: '0', WDCC_TRACE: '1', WDCC_TEST_HOOKS: '0',
  WDCC_ENABLE_CODEX: agent === 'codex' ? '1' : '0',
  WDCC_ENABLE_CLAUDE: agent === 'claude-code' ? '1' : '0',
  WDCC_ENABLE_DSH: agent === 'dsh' ? '1' : '0',
  WEB_DCC_ACCEPTANCE_MODEL_KEY: credential,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  ...(config.browserCache ? { PLAYWRIGHT_BROWSERS_PATH: config.browserCache } : {}),
};
Object.assign(process.env, environment);
for (const name of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
  await mkdir(environment[name], { recursive: true, mode: 0o700 });
}
for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','OPENAI_API_KEY','CODEX_API_KEY']) delete process.env[key];
let modelAdmission = false;
const bridge = createServer((req, res) => {
  void (async () => {
    if (req.method !== 'POST' || !/\/(responses|messages|chat\/completions)$/.test((req.url ?? '').split('?')[0])) {
      res.writeHead(404); res.end(); return;
    }
    if (!live || !modelAdmission || report.requests.length >= (config.maxModelRequestsPerAgent ?? 6)) {
      report.pending.push({ kind: 'model-admission', reason: !modelAdmission ? 'model request outside an admitted user turn' : 'diagnostic request cap', path: req.url });
      await save(); res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Acceptance recorder did not admit this inference request' } })); return;
    }
    const buffers = []; for await (const part of req) buffers.push(Buffer.from(part));
    const body = Buffer.concat(buffers);
    const parsed = JSON.parse(body.toString());
    const declaredTools = parsed.tools ?? (parsed.input ?? []).filter(input => input.type === 'additional_tools');
    assert.equal(parsed.model, selected.model, 'Native client chose an unexpected model');
    const row = {
      id: randomUUID(), startedAt: new Date().toISOString(), state: 'in-flight',
      request: { method: req.method, path: req.url, headers: safe(req.headers),
        body: Buffer.from(safe(body.toString())).toString('base64'), sha256: hash(body), bytes: body.length },
      toolsSha256: hash(JSON.stringify(declaredTools)), toolCount: declaredTools.length,
      response: { chunks: [] },
    };
    report.requests.push(row); await save(); // durable identity before the paid request
    const upstream = new URL(req.url, selected.upstream);
    const begun = Date.now();
    const forward = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)(upstream, {
      method: req.method, headers: { ...req.headers, host: upstream.host },
    }, incoming => {
      row.response.status = incoming.statusCode; row.response.headers = safe(incoming.headers);
      res.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.on('data', chunk => {
        res.write(chunk);
        row.response.chunks.push({ t: Date.now() - begun, data: chunk.toString('base64'), bytes: chunk.length });
      });
      incoming.on('end', () => {
        res.end(); row.state = incoming.statusCode >= 200 && incoming.statusCode < 300 ? 'completed' : 'failed';
        // Preserve arbitrary binary/UTF-8 boundaries. Redact the detached full
        // copy, then split it at the original chunk lengths; live bytes above
        // have already been forwarded unchanged.
        const wire = Buffer.concat(row.response.chunks.map(chunk => Buffer.from(chunk.data, 'base64')));
        for (const secret of secrets) {
          const needle = Buffer.from(secret); let offset = 0;
          while (needle.length && (offset = wire.indexOf(needle, offset)) !== -1) {
            wire.fill(42, offset, offset + needle.length); offset += needle.length;
          }
        }
        let offset = 0;
        for (const chunk of row.response.chunks) {
          chunk.data = wire.subarray(offset, offset + chunk.bytes).toString('base64'); offset += chunk.bytes;
        }
        row.response.sha256 = hash(wire); row.response.digestScope = 'redacted';
        row.durationMs = Date.now() - begun;
        void save().then(() => process.stdout.write(JSON.stringify({ agent, requestId: row.id, state: row.state, httpStatus: row.response.status }) + '\n'));
      });
      incoming.on('error', error => { row.state = 'uncertain'; row.error = String(error); void save(); res.destroy(); });
    });
    forward.setTimeout(90000, () => forward.destroy(new Error('Native upstream request timed out; reconcile receipt before retry')));
    forward.on('error', error => { row.state = 'uncertain'; row.error = String(error); void save(); if (!res.headersSent) res.writeHead(502); res.end(); });
    forward.end(body); // same bytes; capture never edits the native inference body
  })().catch(error => { report.pending.push({ kind: 'bridge-error', error: String(error) }); void save(); if (!res.headersSent) res.writeHead(502); res.end(); });
});
await new Promise(resolveListen => bridge.listen(0, '127.0.0.1', resolveListen));
const proxy = 'http://127.0.0.1:' + bridge.address().port;
if (agent === 'claude-code') Object.assign(process.env, {
  ANTHROPIC_AUTH_TOKEN: credential, ANTHROPIC_BASE_URL: proxy,
  ANTHROPIC_MODEL: selected.model, ANTHROPIC_DEFAULT_SONNET_MODEL: selected.model,
});
const { start } = await import(pathToFileURL(join(release, 'packages/server/dist/main.js')).href);
const { chromium } = await import(pathToFileURL(config.playwrightModule).href);
let server, browser, page, base;
const serverConfig = {
  host: '127.0.0.1', port: 0, token: randomUUID() + randomUUID(), dataDir: paths.data,
  dshPort: 0, idleDisposeMin: 0, version: 'target-platform-acceptance',
  recordInteractions: true,
};
secrets.add(serverConfig.token);
process.env.WDCC_COMMIT = manifest.commit;
process.env.WDCC_BUILT_AT = manifest.builtAt;
async function boot() {
  server = await start(serverConfig, { webDist: join(release, 'packages/web/dist') });
  base = new URL(server.url).origin;
}
const api = async (path, method = 'GET', data) => {
  const response = await page.request.fetch(base + path, { method, ...(data === undefined ? {} : { data }) });
  assert(response.ok(), path + ' returned ' + response.status());
  return response.json();
};
async function authenticate() {
  await page.goto(base + '/?token=' + encodeURIComponent(serverConfig.token));
}
let sid;
async function waitTurn(before) {
  const until = Date.now() + 150000;
  while (Date.now() < until) {
    const approvals = page.locator('[data-testid="approval-card"][data-state="pending"][data-sync="ready"]');
    if (await approvals.count()) {
      const card = approvals.first();
      const text = await card.innerText();
      report.userCommands.push({ kind: 'browser-native-approval', text, at: new Date().toISOString() });
      await save();
      // Only this disposable fixture workspace is in scope. Displayed details
      // remain in the evidence; no global "always allow" mode is selected.
      await card.getByRole('button', { name: /^(允许一次|允许|Allow|Yes|接受|确认)$/i }).first().click();
    }
    const events = (await api('/api/sessions/' + sid + '/events?limit=500')).events;
    const done = events.filter(event => event.kind === 'turn.completed');
    if (done.length > before) {
      assert.equal(done.at(-1).data.status, 'completed', 'Official native turn did not complete');
      return events;
    }
    if (report.requests.some(row => row.state === 'uncertain')) throw Error('Uncertain model receipt; paid input will not be repeated');
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw Error('Native turn did not finish; receipt remains incomplete');
}
const walk = (value, out = []) => {
  if (value && typeof value === 'object') { out.push(value); for (const child of Object.values(value)) walk(child, out); }
  return out;
};
try {
  await boot();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.browserErrors.push(error.message));
  await authenticate();
  report.nativeVersions = (await api('/api/meta')).agents;
  await api('/api/watchdog', 'PATCH', { enabled: false }); // only the disposable server
  const workspace = await api('/api/workspaces', 'POST', { name: 'Native parity ' + agent, path: paths.workspace });
  let providerName = 'Real acceptance ' + agent;
  if (agent === 'dsh') {
    const adapter = server.manager.adaptersList().find(adapter => adapter.id === 'dsh');
    const host = await adapter.ensureSidecar();
    let description = await host.rpc('settings/describe', {});
    const llm = description.namespaces.find(namespace => namespace.ns === 'llm-pi-ai');
    await host.rpc('settings/mutate', { ns: llm.ns, expectedRevision: llm.revision, ops: [{ op: 'set', path: ['providers', 'acceptance-real'], value: {
      displayName: providerName, api: selected.protocol,
      baseURL: proxy + (selected.protocol === 'anthropic-messages' ? '' : '/v1'),
      apiKeyEnv: 'WEB_DCC_ACCEPTANCE_MODEL_KEY',
      models: [{ id: selected.model, name: selected.model, contextWindow: 128000, maxTokens: 1024, reasoningEfforts: false }],
    } }] });
    description = await host.rpc('settings/describe', {});
    const defaults = description.namespaces.find(namespace => namespace.ns === 'agent-default-model');
    await host.rpc('settings/mutate', { ns: defaults.ns, expectedRevision: defaults.revision, ops: [
      { op: 'set', path: ['provider'], value: 'acceptance-real' }, { op: 'set', path: ['model'], value: selected.model },
    ] });
    report.nativeHost = await adapter.hostIdentity();
  } else {
    await api('/api/providers', 'POST', { name: providerName,
      baseUrl: proxy + (agent === 'codex' ? '/v1' : ''),
      protocols: [selected.protocol], models: [selected.model], apiKey: credential });
  }
  await page.goto(base + '/new?w=' + workspace.id + '&agent=' + agent);
  await page.getByTestId('new-session-input').waitFor();
  await page.getByTestId('model-menu').click();
  await page.locator('[data-testid="model-option"][data-model="' + selected.model + '"]').first().click();
  await page.getByTestId('new-session-input').fill('/');
  await page.getByTestId('slash-menu').waitFor();
  const catalogDeadline = Date.now() + 45000;
  while (await page.getByTestId('slash-menu').locator('.menu-item').count() === 0 && Date.now() < catalogDeadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  report.checks.preview = { sessionCreates: server.store.listSessions().length, modelRequests: report.requests.length,
    commandCount: await page.getByTestId('slash-menu').locator('.menu-item').count() };
  assert.equal(report.checks.preview.sessionCreates, 0);
  assert.equal(report.checks.preview.modelRequests, 0);
  assert(report.checks.preview.commandCount > 0, 'Native command catalog is not ready');
  assert.equal(report.pending.length, 0, 'Pre-creation discovery attempted a model call');
  await page.screenshot({ path: join(root, 'preview.png'), fullPage: true });
  if (!live) {
    report.status = 'probe-passed'; await save();
  } else {
    if (['question-denial', 'permission-only'].includes(config.scenario)) {
      const permissionOnly = config.scenario === 'permission-only';
      const guarded = join(root, 'guarded.txt');
      const sentinel = 'UNCHANGED-' + randomUUID();
      await writeFile(guarded, sentinel, { mode: 0o600 });
      report.guardedFixture = { path: guarded, sha256: hash(sentinel) };
      const questionTool = { codex: 'request_user_input_async', 'claude-code': 'AskUserQuestion', dsh: 'ask_user_question' }[agent];
      const prompt = permissionOnly
        ? 'Use the native write tool to attempt file_path=' + guarded + ' and content=SHOULD_NOT_BE_WRITTEN, outside the workspace. First try without sandbox_permissions. If the native sandbox rejects it, retry that exact same operation once with sandbox_permissions="danger-full-access" and a justification asking the user to approve this one file operation. Do not change the global permission mode. The user will reject it. After refusal keep the file unchanged and finish with CONTROL_DONE:Probe. Do not retry again, use other tools or launch subagents.'
        : 'Use your native ' + questionTool + ' tool to ask one question "Choose a validation path" with options "Probe" and "Skip". Wait for the actual user answer; do not answer it yourself. After the user chooses Probe, attempt to write SHOULD_NOT_BE_WRITTEN to ' + guarded + ', which is outside the current workspace. Request native permission if required; do not bypass permissions or try another way. The user will refuse permission. After refusal leave the file unchanged and finish with CONTROL_DONE:Probe. Do not use other tools or launch subagents.';
      report.scenario = config.scenario;
      report.userCommands.push({ kind: 'controls-prompt', prompt, submittedAt: new Date().toISOString() });
      modelAdmission = true; report.status = 'controls:submitting'; await save();
      await page.getByTestId('new-session-input').fill(prompt);
      await page.getByTestId('new-session-send').click(); await page.waitForURL('**/s/**');
      sid = page.url().split('/s/')[1].split('?')[0]; report.sessionId = sid; await save();
      let answered = permissionOnly, denied = false, complete = false;
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const questions = page.locator('[data-testid="question-card"][data-state="pending"][data-sync="ready"]');
        if (!answered && await questions.count()) {
          await page.screenshot({ path: join(root, 'question-before-refresh.png'), fullPage: true });
          await page.reload(); await page.getByTestId('composer-input').waitFor();
          const card = page.locator('[data-testid="question-card"][data-state="pending"][data-sync="ready"]').first();
          await card.waitFor();
          report.checks.questionPendingRefresh = true;
          report.userCommands.push({ kind: 'browser-native-answer', question: await card.innerText(), answer: 'Probe', at: new Date().toISOString() });
          await save();
          const radios = card.locator('input[type="radio"]');
          if (await radios.count()) await radios.first().check();
          else await card.getByRole('textbox', { name: '其他回答' }).fill('Probe');
          await card.getByRole('button', { name: '提交', exact: true }).click(); answered = true;
        }
        const approvals = page.locator('[data-testid="approval-card"][data-state="pending"][data-sync="ready"]');
        if (await approvals.count()) {
          const card = approvals.first();
          report.userCommands.push({ kind: 'browser-native-deny', detail: await card.innerText(), at: new Date().toISOString() });
          await save(); await page.screenshot({ path: join(root, 'approval-before-deny.png'), fullPage: true });
          await card.getByRole('button', { name: /拒绝|不允许|Deny|Reject|Decline|^No$/i }).first().click(); denied = true;
        }
        const events = server.store.allEvents(sid);
        const final = events.filter(event => event.kind === 'assistant.message').at(-1)?.data.text ?? '';
        const terminal = events.filter(event => event.kind === 'turn.completed').at(-1);
        if (answered && denied && terminal?.data.status === 'interrupted' && terminal.native?.terminal_reason === 'aborted_tools') {
          report.checks.nativeDenialTerminatesQuery = true;
          report.checks.nativeTerminalReason = 'aborted_tools';
          report.finalNativeText = ''; complete = true; break;
        }
        if (answered && denied && /CONTROL_DONE:\s*Probe/.test(final) && events.filter(event => event.kind === 'turn.completed').length) {
          report.finalNativeText = final; complete = true; break;
        }
        if (report.requests.some(row => row.state === 'uncertain')) throw Error('Uncertain controls receipt; do not repeat paid input');
        await new Promise(resolveWait => setTimeout(resolveWait, 250));
      }
      modelAdmission = false;
      assert(complete, 'Native question/denial flow was not fully triggered');
      assert.equal(await readFile(guarded, 'utf8'), sentinel, 'Denied operation changed the protected fixture');
      report.checks.nativeQuestionAnswered = permissionOnly ? 'not-applicable; separate question recording' : answered;
      report.checks.nativeApprovalDenied = denied;
      report.checks.deniedFixtureUnchanged = true;
      const journal = server.store.journal;
      const answers = server.store.allEvents(sid).filter(event => event.kind === 'question');
      report.checks.questionEvents = answers.map(event => ({ itemKey: event.itemKey, questionId: event.data.questionId, status: event.data.status, resolution: event.data.resolution }));
      report.checks.answerCommands = report.userCommands.filter(command => command.kind === 'browser-native-answer').length;
      assert(journal && report.checks.answerCommands === (permissionOnly ? 0 : 1));
      report.nativeId = server.store.getSession(sid).nativeId;
      await page.reload();
      if (report.finalNativeText) await page.getByText(report.finalNativeText, { exact: false }).first().waitFor();
      else await page.getByText('已中断', { exact: false }).first().waitFor();
      report.checks.controlsRefresh = true;
      await page.screenshot({ path: join(root, 'controls-complete.png'), fullPage: true });
      report.status = permissionOnly ? 'permission-denial-live-passed' : 'controls-live-passed';
      report.pending.push({ kind: 'full-acceptance', reason: 'This run proves one real native question/answer and explicit permission denial. Cancel/retry/multiple-choice/multimodal and complete NP-48 matrices retain their separate acceptance scope.' });
    } else {
    const prompts = [
      'Reply exactly NATIVE_TEXT_OK. Do not use any tools.',
      'Read fixture.txt in the current workspace using your native tools. Copy its exact complete content into result.txt in this workspace. Also try reading deliberately-missing.txt once, record that it is missing, and continue. Do not change any other file or launch sub-agents. Finish with exactly NATIVE_TOOL_OK: followed by the content of fixture.txt without its final newline.',
    ];
    report.userCommands.push({ id: randomUUID(), prompt: prompts[0], phase: 'create-and-text', submittedAt: new Date().toISOString() });
    report.status = 'create-and-text:submitting'; modelAdmission = true; await save();
    await page.getByTestId('new-session-input').fill(prompts[0]);
    await page.getByTestId('new-session-send').click();
    await page.waitForURL('**/s/**');
    sid = page.url().split('/s/')[1].split('?')[0];
    report.sessionId = sid; await save();
    let events = await waitTurn(0);
    assert(events.some(event => event.kind === 'assistant.message' && event.data.text?.trim() === 'NATIVE_TEXT_OK'));
    report.checks.text = true;
    const before = events.filter(event => event.kind === 'turn.completed').length;
    report.userCommands.push({ id: randomUUID(), prompt: prompts[1], phase: 'native-tools', submittedAt: new Date().toISOString() });
    report.status = 'native-tools:submitting'; await save();
    await page.getByTestId('composer-input').fill(prompts[1]);
    await page.getByTestId('send-button').click();
    events = await waitTurn(before);
    modelAdmission = false;
    assert.equal(await readFile(join(paths.workspace, 'result.txt'), 'utf8'), fixture + '\n', 'Actual native filesystem result differs');
    const finalText = events.filter(event => event.kind === 'assistant.message').at(-1)?.data.text?.trim();
    report.checks.strictOutputFormat = finalText === 'NATIVE_TOOL_OK:' + fixture;
    assert(finalText?.startsWith('NATIVE_TOOL_OK:') && finalText.slice('NATIVE_TOOL_OK:'.length).trim() === fixture,
      'Native answer does not contain the independently generated file proof');
    report.finalNativeText = finalText;
    report.checks.toolSideEffect = { resultSha256: hash(await readFile(join(paths.workspace, 'result.txt'))), fixtureUnchanged: (await readFile(join(paths.workspace, 'fixture.txt'), 'utf8')) === fixture + '\n' };
    const bodyObjects = report.requests.flatMap(row => walk(JSON.parse(Buffer.from(row.request.body, 'base64').toString())));
    const results = bodyObjects.filter(value => ['tool_result', 'function_call_output', 'custom_tool_call_output'].includes(value.type));
    report.checks.toolResultReturnedToModel = results.some(value => JSON.stringify(value).includes(fixture));
    report.checks.nativeToolErrorReturned = results.some(value => /no such file|does not exist|not found|ENOENT|不存在/i.test(JSON.stringify(value)));
    assert.equal(report.checks.toolResultReturnedToModel, true);
    assert.equal(report.checks.nativeToolErrorReturned, true);
    assert(report.requests.every(row => row.state === 'completed'));
    report.nativeId = server.store.getSession(sid).nativeId;
    let trace = await api('/api/sessions/' + sid + '/trace');
    const response = await page.request.get(base + '/api/sessions/' + sid + '/trace?format=jsonl');
    const traceText = await response.text();
    await writeFile(join(root, 'interaction.jsonl'), traceText, { mode: 0o600 });
    report.trace = { summary: trace, sha256: hash(traceText), file: 'interaction.jsonl' };
    assert(trace.nativeFrames > 0 && !trace.incomplete, 'Native recording is incomplete');
    report.checks.stream = report.requests.some(row => row.response.chunks.length > 1 && /event-stream/.test(row.response.headers['content-type'] ?? ''));
    assert.equal(report.checks.stream, true);
    await writeFile(join(root, 'events.json'), JSON.stringify(safe(events), null, 2), { mode: 0o600 });
    report.checks.approvals = report.userCommands.some(row => row.kind === 'browser-native-approval') ? 'live-browser-action-observed' : 'not-triggered';
    report.checks.questions = events.some(event => event.kind === 'question') ? 'native-event-observed' : 'not-triggered';
    await page.reload(); await page.getByTestId('composer-input').waitFor();
    await page.getByText('NATIVE_TOOL_OK:' + fixture, { exact: false }).first().waitFor();
    report.checks.refresh = true;
    await page.context().setOffline(true); await new Promise(resolveWait => setTimeout(resolveWait, 800));
    await page.context().setOffline(false);
    await page.getByText('NATIVE_TOOL_OK:' + fixture, { exact: false }).first().waitFor();
    report.checks.browserReconnect = true;
    await page.setViewportSize({ width: 420, height: 900 });
    await page.screenshot({ path: join(root, 'mobile-refresh.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: join(root, 'reply-refresh.png'), fullPage: true });
    const beforeRestore = report.requests.length;
    await closeVerifiedServer(server, environment.DSH_HOME);
    server = undefined; await boot(); await authenticate();
    await page.goto(base + '/s/' + sid); await page.getByTestId('composer-input').waitFor();
    await page.getByText('NATIVE_TOOL_OK:' + fixture, { exact: false }).first().waitFor();
    const restored = await api('/api/sessions/' + sid);
    assert.equal(restored.nativeId, report.nativeId);
    assert.equal(report.requests.length, beforeRestore);
    report.checks.restart = { sameNativeId: true, additionalModelRequests: 0 };
    await page.screenshot({ path: join(root, 'restart.png'), fullPage: true });
    report.checks.browserErrors = report.browserErrors.length === 0;
    assert.equal(report.browserErrors.length, 0);
    report.status = 'core-live-passed';
    report.pending.push({ kind: 'full-acceptance', reason: 'This capture covers text, streams, actual file tools/results/error, UI refresh/reconnect/restart. Question, permission deny/cancel, multimodal and full NP-48 acceptance require their own triggered evidence.' });
    }
  }
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  modelAdmission = false;
  if (page && report.status === 'failed') {
    await page.screenshot({ path: join(root, 'failed-page.png'), fullPage: true }).catch(() => undefined);
    report.failedBrowserText = await page.locator('body').innerText().catch(() => 'unavailable');
  }
  if (server && sid) {
    try {
      const session = server.store.getSession(sid);
      const traceText = await server.recorder.read(sid, session.nativeId, session.workspaceId);
      await writeFile(join(root, 'interaction.jsonl'), traceText, { mode: 0o600 });
      report.trace = { summary: await server.recorder.summary(sid, session.nativeId, session.workspaceId), sha256: hash(traceText), file: 'interaction.jsonl' };
      await writeFile(join(root, 'events.json'), JSON.stringify(safe(server.store.allEvents(sid)), null, 2), { mode: 0o600 });
      report.nativeId = session.nativeId;
    } catch (error) { report.captureError = String(error); }
  }
  await browser?.close();
  await finalizeVerifiedServer(server, environment.DSH_HOME, () => new Promise(resolveClose => bridge.close(resolveClose)))
    .then(pids => { report.cleanup = { stoppedOwnedDshPids: pids }; })
    .catch(error => { report.cleanupError = String(error); report.status = 'failed'; process.exitCode = 1; });
  report.finishedAt = new Date().toISOString();
  await save();
  process.stdout.write(JSON.stringify(safe({ agent, status: report.status, runId, modelRequests: report.requests.length, checks: report.checks, error: report.error, report: ledger })) + '\n');
}
