/** Native command discovery and result evidence; no paid model or real home. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AgentAdapter, AgentId, TraceFrame } from '../packages/protocol/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';
import { DshAdapter } from '../packages/adapters/dsh/src/adapter.js';
import { createTestApp } from '../packages/server/test/helpers.js';
import { isolatedEnv } from '../packages/server/src/test-isolation.js';
import { startAnthropicMock } from '../packages/testing/mock-models/src/anthropic-server.js';
import { startResponsesMock } from '../packages/testing/mock-models/src/responses-server.js';
import { MockControl } from '../packages/testing/mock-models/src/mock-control.js';
import { sourceFingerprint } from './lib/gate-report.js';
import { chromium, expect, type Browser } from '@playwright/test';
import { createSourceTestApp } from '../browser-tests/helpers.js';
import { processState } from '../packages/server/src/process-identity.js';
import { JsonRpcStdio } from '../packages/adapters/codex/src/rpc.js';
import { nativeRequest } from '../packages/adapters/codex/src/controls.js';

const option = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const binary = resolve(option('--binary') ?? '.artifacts/native-baseline/package/vendor/x86_64-unknown-linux-musl/bin/codex');
const reportPath = resolve(option('--report') ?? 'web_review/evidence/native-slash-probe.json');
const selected = option('--agent');
const agents: AgentId[] = ['codex', 'claude-code', 'dsh'];
const report: Record<string, unknown> = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(), paidModel: false, results: [] };
for (const agent of agents.filter(agent => !selected || agent === selected)) {
  const isolated = isolatedEnv({ PATH: process.env['PATH'] }, 'wdcc-native-slash'); const cwd = join(isolated.dirs.root, 'workspace'); await mkdir(cwd);
  const plan = [{ text: 'Native slash probe model response.', chunkDelayMs: process.argv.includes('--fast') ? 0 : 200 }]; const control = new MockControl(plan, '');
  const model = agent === 'codex' ? await startResponsesMock({ plan, control, log: () => undefined }) : await startAnthropicMock({ plan, control, log: () => undefined });
  const env = Object.fromEntries(Object.entries(isolated.env).filter((row): row is [string, string] => row[1] !== undefined));
  const frames: TraceFrame[] = []; let observedFrames = 0;
  const traceSink = { record: (frame: TraceFrame): void => { observedFrames++; if (frames.length < 5_000) frames.push(frame); } };
  const browserMode = process.argv.includes('--browser');
  const ctx = browserMode ? await createSourceTestApp() : await createTestApp(); let adapter: AgentAdapter | undefined;
  let browser: Browser | undefined;
  const result: Record<string, unknown> = { agent, passed: false };
  try {
    if (agent === 'codex') {
      await writeFile(join(isolated.dirs.CODEX_HOME, 'config.toml'), `[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);
      adapter = new CodexAdapter({ command: binary, env: { ...env, WDCC_MOCK_KEY: 'fixture-only' }, traceSink, configOverrides: ['model_provider=wdcc_mock', 'model="mock-responses-1"', 'model_providers.wdcc_mock.name="WDCC isolated mock"',
        `model_providers.wdcc_mock.base_url="${model.url}/v1"`, 'model_providers.wdcc_mock.wire_api="responses"', 'model_providers.wdcc_mock.env_key="WDCC_MOCK_KEY"'] });
    } else if (agent === 'claude-code') adapter = new ClaudeAdapter({ env: { ...env, ANTHROPIC_API_KEY: 'fixture-only', ANTHROPIC_BASE_URL: model.url }, model: 'mock-anthropic-1', traceSink });
    else adapter = new DshAdapter({ env: { ...env, DEEPSEEK_API_KEY: 'fixture-only', DEEPSEEK_BASE_URL: model.url }, port: 0, traceSink });
    ctx.manager.registerAdapter(adapter); result['probe'] = await adapter.probe();
    const workspace = ctx.store.createWorkspace('native slash', cwd); const accessMode = option('--access-mode');
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent, ...(accessMode ? { accessMode } : {}) });
    const catalog = await ctx.manager.slashCommandCatalog(session.id); result['catalog'] = catalog;
    assert.equal(catalog.status, 'ready', catalog.reason ?? 'Native catalog is not ready');
    const goal = catalog.commands.find(command => command.name === '/goal'); assert.ok(goal, 'Native goal missing from the catalog');
    const line = option('--line') ?? '/goal';
    if (browserMode) {
      await ctx.app.listen({ host: '127.0.0.1', port: 0 });
      const address = ctx.app.server.address(); assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(10_000);
      const browserErrors: string[] = []; result['browserErrors'] = browserErrors;
      page.on('pageerror', error => browserErrors.push(error.message));
      page.on('console', message => { if (message.type() === 'error' && browserErrors.length < 10) browserErrors.push(message.text().slice(0, 1000)); });
      await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
      await page.goto(`${base}/s/${session.id}`); const input = page.getByTestId('composer-input'); await input.waitFor();
      const lines = process.argv.includes('--sequence') && agent !== 'claude-code'
        ? ['/goal', '/goal 原生适配验证\n第二行', '/goal pause', '/goal resume', '/goal clear', '/goal'] : [line];
      result['browserCommands'] = [];
      for (const command of lines) {
        process.stdout.write(JSON.stringify({ agent, browserStep: (result['browserCommands'] as unknown[]).length + 1 }) + '\n');
        const previousTurns = ctx.store.allEvents(session.id).filter(event => event.kind === 'turn.completed').length;
        await input.fill('/'); await page.getByTestId('slash-menu').getByRole('button', { name: '/goal', exact: false }).waitFor();
        await input.fill(command);
        if (goal.route === 'native-control') {
          const reply = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/slash-commands'));
          await input.press('Enter'); const response = await reply; assert.equal(response.status(), 200);
          let body = await response.json(); const deadline = Date.now() + 10_000;
          while (body.receipt.state === 'dispatching') {
            assert.ok(Date.now() < deadline, 'Native receipt never completed'); await new Promise(resolve => setTimeout(resolve, 50));
            body = ctx.manager.slashControlResult(session.id, body.receipt.commandId);
          }
          assert.equal(body.receipt.state, 'completed'); assert.notEqual(body.result?.failed, true);
          (result['browserCommands'] as unknown[]).push({ line: command, response: body });
        } else {
          await input.press('Enter'); const deadline = Date.now() + 15_000;
          while (ctx.store.allEvents(session.id).filter(event => event.kind === 'turn.completed').length === previousTurns) {
            assert.ok(Date.now() < deadline, 'Browser SDK command did not complete'); await new Promise(resolve => setTimeout(resolve, 50));
          }
          (result['browserCommands'] as unknown[]).push({ line: command });
        }
      }
      if (agent === 'codex' && process.argv.includes('--attachments')) {
        const original = '附件目标🐈'.repeat(801);
        const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n1sAAAAASUVORK5CYII=', 'base64');
        const document = Buffer.from('\ufeff原始文档\r\nexact bytes');
        const submit = async (command: string) => {
          await input.fill(command);
          const response = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/slash-commands'));
          await input.press('Enter'); const reply = await response; assert.equal(reply.status(), 200);
          let body = await reply.json();
          while (body.receipt.state === 'dispatching') { await new Promise(resolve => setTimeout(resolve, 50)); body = ctx.manager.slashControlResult(session.id, body.receipt.commandId); }
          assert.equal(body.receipt.state, 'completed'); return body;
        };
        await input.fill('/goal ' + original);
        await page.getByTestId('add-image-input').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: image });
        await page.getByTestId('add-file-input').setInputFiles({ name: 'reference.md', mimeType: 'text/markdown', buffer: document });
        await expect.poll(() => page.getByTestId('send-button').isEnabled()).toBe(true);
        const created = await submit('/goal ' + original);
        await submit('/goal pause');
        const reference = created.result.result.goal.objective as string;
        assert.ok(reference.startsWith('Read the Codex goal objective file at '));
        const objectiveFile = reference.slice('Read the Codex goal objective file at '.length, -' before continuing.'.length);
        const expanded = await readFile(objectiveFile, 'utf8'); assert.ok(expanded.startsWith(original));
        const imagePath = expanded.match(/- \[Image #\d+\]: (.+)/)?.[1]; const filePath = expanded.match(/- \[File #\d+\]: (.+)/)?.[1]; assert.ok(imagePath && filePath);
        assert.ok((await readFile(imagePath)).equals(image)); assert.ok((await readFile(filePath)).equals(document));
        await submit('/goal edit');
        await page.getByLabel('原生目标', { exact: true }).waitFor(); assert.equal(await page.getByLabel('原生目标', { exact: true }).inputValue(), expanded);
        await page.reload(); await page.getByLabel('原生目标', { exact: true }).waitFor(); assert.equal(await page.getByLabel('原生目标', { exact: true }).inputValue(), expanded);
        await submit('/goal clear');
        result['goalAttachments'] = { passed: true, imageBytes: image.length, documentBytes: document.length, unicodeObjectiveChars: [...original].length, fullEditAfterRefresh: true };
      }
      if (agent === 'codex' && process.argv.includes('--takeover')) {
        await expect.poll(() => ctx.manager.getRuntime(session.id)?.status).toBe('idle');
        const originalPermissions = ctx.store.getSession(session.id)?.permissions?.policy;
        const originalProcess = ctx.store.nativeOwners.managedProcess(session.id); assert.ok(originalProcess);
        await input.fill('/theme'); await input.press('Enter');
        await expect.poll(() => page.getByRole('button', { name: '接管当前原生会话' }).isEnabled()).toBe(true);
        const response = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/native-terminal'));
        await page.getByRole('button', { name: '接管当前原生会话' }).click(); const opened = await response;
        const terminal = await opened.json(); assert.equal(opened.status(), 200, JSON.stringify(terminal));
        assert.equal(terminal.nativeId, session.nativeId); assert.equal(terminal.ownerSessionId, session.id); assert.equal(terminal.nativeIdentityVerified, true);
        assert.equal(processState(originalProcess), 'exited'); assert.equal(ctx.manager.getRuntime(session.id), undefined);
        await page.getByText('已连接 · running', { exact: false }).waitFor();
        await page.getByRole('button', { name: '填入原生指令' }).click(); await page.keyboard.press('Enter');
        await page.getByText('Select Syntax Theme', { exact: false }).waitFor(); await page.keyboard.press('Escape');
        const nativeText = 'native CLI roundtrip message';
        (control.currentPlan[0] as { text: string }).text = 'Native terminal roundtrip response.';
        await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type(nativeText, { delay: 30 }); await page.keyboard.press('Enter');
        await page.getByRole('list').getByText('Native terminal roundtrip response.', { exact: false }).waitFor();
        const returning = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/return'));
        await page.getByRole('button', { name: '结束 CLI 并返回结构化会话' }).click();
        const returned = await returning; assert.equal(returned.status(), 200, JSON.stringify(await returned.json()));
        await expect.poll(() => ctx.manager.getRuntime(session.id)?.nativeId).toBe(session.nativeId);
        const restored = ctx.store.allEvents(session.id).filter(event => event.kind === 'user.message').map(event => (event.data as { text: string }).text);
        assert.ok(restored.includes(nativeText)); assert.equal(ctx.store.getSession(session.id)?.model, 'mock-responses-1');
        const answers = ctx.store.allEvents(session.id).filter(event => event.kind === 'assistant.message');
        const identities = answers.map(event => JSON.stringify([event.turnId, event.itemKey]));
        assert.equal(new Set(identities).size, identities.length, 'Returning history duplicated a live answer');
        assert.deepEqual(ctx.store.getSession(session.id)?.permissions?.policy, originalPermissions);
        const restoredPid = ctx.store.nativeOwners.managedProcess(session.id)?.pid;
        const repeated = await page.evaluate(async ({ url, body }) => {
          const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          return { status: response.status, body: await response.json() };
        }, { url: returned.url(), body: returned.request().postDataJSON() });
        assert.equal(repeated.status, 200, JSON.stringify(repeated.body)); assert.equal(ctx.store.nativeOwners.managedProcess(session.id)?.pid, restoredPid);
        const external = JsonRpcStdio.start({ command: binary, args: adapter.buildLaunchSpec({ sessionId: session.id, cwd, providerId: null }).args ?? ['app-server'], env: { ...env, WDCC_MOCK_KEY: 'fixture-only' } });
        try {
          await nativeRequest(external, 'initialize', { clientInfo: { name: 'writer-lock-verification', version: '1', title: null }, capabilities: { experimentalApi: true, requestAttestation: false } }); external.notify('initialized', {});
          await assert.rejects(nativeRequest(external, 'thread/resume', { threadId: session.nativeId!, excludeTurns: true }), /active writer|locked/);
        } finally { await external.kill(); }
        await page.reload(); await page.getByTestId('composer-input').waitFor(); await page.getByText(nativeText, { exact: true }).waitFor();
        result['sameSessionTakeover'] = { passed: true, nativeId: session.nativeId, oldWriterReleased: true, nativeKernelLockVerified: true, terminalCommand: '/theme', nativeInputImported: true, liveAnswersDeduplicated: true, refresh: true, repeatedReturnPreservesPid: true, nativeExternalWriterRejected: true };
      }
      process.stdout.write(JSON.stringify({ agent, browserStep: 'refresh' }) + '\n');
      const mutations = () => frames.filter(frame => frame.dir === 'out' && typeof frame.frame === 'object' && frame.frame !== null
        && ['thread/goal/set', 'thread/goal/clear', 'commands/execute'].includes(String((frame.frame as { method?: string }).method))).length;
      const mutationsBeforeRefresh = mutations();
      await page.reload(); await page.getByTestId('composer-input').waitFor();
      if (goal.route === 'native-control') await page.getByRole('button', { name: '关闭指令结果' }).waitFor();
      assert.equal(mutations(), mutationsBeforeRefresh);
      result['browserRefresh'] = 'result restored without native resubmission';
      await page.screenshot({ path: reportPath + '.' + agent + '.png', fullPage: true });
    } else if (goal.route === 'native-control') {
      result['response'] = await ctx.manager.executeSlashControl(session.id, { commandId: randomUUID(), line, revision: catalog.revision });
      assert.notEqual((result['response'] as { result?: { failed?: boolean } }).result?.failed, true);
    } else if (goal.route === 'native-input') {
      await ctx.manager.send(session.id, { text: line });
      const deadline = Date.now() + 15_000;
      while (!ctx.store.allEvents(session.id).some(event => event.kind === 'turn.completed')) {
        assert.ok(Date.now() < deadline, 'Native slash command did not close its public turn'); await new Promise(resolve => setTimeout(resolve, 50));
      }
    } else result['nativeTerminalRequired'] = true;
    result['events'] = ctx.store.allEvents(session.id); result['modelRequests'] = control.requests.length;
    if (line === '/goal' && !process.argv.includes('--sequence')) assert.equal(control.requests.filter(request => !request.helper).length, 0, 'Bare native goal view unexpectedly became a model prompt');
    result['passed'] = true;
  } catch (error) { result['error'] = error instanceof Error ? error.message : String(error); process.exitCode = 1;
    if (browser) await browser.contexts()[0]?.pages()[0]?.screenshot({ path: reportPath + '.' + agent + '.failed.png', fullPage: true }).catch(() => undefined);
  }
  finally {
    result['events'] = ctx.store.allEvents((result['catalog'] as { sessionId?: string } | undefined)?.sessionId ?? ctx.store.listSessions(true)[0]?.id ?? '');
    result['frames'] = frames; result['observedFrames'] = observedFrames; result['traceComplete'] = observedFrames === frames.length;
    result['modelBodies'] = control.requests.slice(0, 20).map(request => request.body);
    await browser?.close(); await ctx.close(); if (adapter instanceof DshAdapter) await adapter.shutdown();
    await model.close(); await rm(isolated.dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    (report['results'] as unknown[]).push(result); await mkdir(resolve(reportPath, '..'), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ agent, passed: result['passed'], error: result['error'], modelRequests: result['modelRequests'], report: reportPath }) + '\n');
  }
}
