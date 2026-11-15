/** Actual pinned Claude CLI, authenticated API-key mode against an isolated
 * loopback model. No real profile, account, credential or paid inference. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';
import { createSourceTestApp } from '../browser-tests/helpers.js';
import { isolatedEnv } from '../packages/server/src/test-isolation.js';
import { startAnthropicMock } from '../packages/testing/mock-models/src/anthropic-server.js';
import { MockControl } from '../packages/testing/mock-models/src/mock-control.js';
import { sourceFingerprint } from './lib/gate-report.js';

const index = process.argv.indexOf('--report');
const reportPath = resolve(index < 0 ? '.artifacts/claude-terminal.json' : process.argv[index + 1]!);
const isolated = isolatedEnv({ PATH: process.env['PATH'] }, 'wdcc-claude-native-terminal');
const cwd = join(isolated.dirs.root, 'workspace'); await mkdir(cwd);
const plan = [{ text: 'CLAUDE_NATIVE_TERMINAL_ANSWER', chunkDelayMs: 100 }]; const control = new MockControl(plan, '');
const model = await startAnthropicMock({ plan, control, log: () => undefined });
const fixtureKey = 'sk-ant-test-native-terminal-0000';
const env = Object.fromEntries(Object.entries({ ...isolated.env, DISABLE_AUTOUPDATER: '1', ANTHROPIC_API_KEY: fixtureKey, ANTHROPIC_BASE_URL: model.url }).filter((row): row is [string, string] => row[1] !== undefined));
const configuration = { hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: [fixtureKey, fixtureKey.slice(-20)], rejected: [] },
  projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1, allowedTools: [] } } };
await writeFile(join(isolated.dirs.home, '.claude.json'), JSON.stringify(configuration), { mode: 0o600 });
await writeFile(join(isolated.dirs.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify(configuration), { mode: 0o600 });
const report: Record<string, unknown> = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(), paidModel: false, passed: false };
const ctx = await createSourceTestApp(); const adapter = new ClaudeAdapter({ env, model: 'mock-anthropic-1' }); ctx.manager.registerAdapter(adapter);
const browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(15_000);
try {
  report['probe'] = await adapter.probe();
  const workspace = ctx.store.createWorkspace('Claude CLI command verification', cwd);
  const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code', model: 'mock-anthropic-1' });
  await ctx.manager.send(session.id, { text: '/goal' }); await expect.poll(() => ctx.manager.getRuntime(session.id)?.status).toBe('idle');
  const catalog = await ctx.manager.slashCommandCatalog(session.id);
  assert.equal(catalog.commands.find(command => command.name === '/permissions')?.route, 'native-terminal');
  assert.equal(catalog.commands.find(command => command.name === '/login')?.route, 'native-terminal');
  report['catalog'] = { count: catalog.commands.length, cliOnlyCommandsPresent: true };
  await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
  await page.goto(`${base}/s/${session.id}`); const composer = page.getByTestId('composer-input'); await composer.waitFor();
  await composer.fill('/color blue'); await composer.press('Enter');
  await page.getByRole('checkbox', { name: '临时保留日志供下载', exact: false }).check();
  const response = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/native-terminal'));
  await page.getByRole('button', { name: '创建新原生会话' }).click(); const opened = await response; const terminal = await opened.json(); assert.equal(opened.status(), 200, JSON.stringify(terminal));
  report['terminal'] = { nativeVersion: terminal.nativeVersion, intent: terminal.intent };
  await page.getByText('已连接 · running', { exact: false }).waitFor();
  const screen = page.getByRole('list');
  await screen.getByText(/mock-anthropic-1|Welcome to Claude Code|Claude Code/, { exact: false }).first().waitFor();
  const type = async (line: string) => { await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type(line, { delay: 30 }); await page.keyboard.press('Enter'); };
  await type('native terminal verification message');
  await screen.getByText('CLAUDE_NATIVE_TERMINAL_ANSWER', { exact: false }).waitFor();
  report['apiKeyModeModelTurn'] = true;
  await type('/permissions');
  await screen.getByText('Permissions', { exact: false }).first().waitFor();
  report['permissions'] = true; await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '填入原生指令' }).click(); await page.keyboard.press('Enter');
  await screen.getByText(/color.*(?:set|changed)|(?:set|changed).*color/i, { exact: false }).first().waitFor();
  report['color'] = true;
  const doctorStart = control.requests.length;
  (control.currentPlan[0] as { text: string }).text = 'CLAUDE_NATIVE_DOCTOR_ANSWER';
  await type('/doctor'); await screen.getByText('CLAUDE_NATIVE_DOCTOR_ANSWER', { exact: false }).first().waitFor();
  const doctorRequests = control.requests.slice(doctorStart);
  report['doctor'] = { dispatchedNativeModel: doctorRequests.length > 0, nativeExpansion: doctorRequests.some(request => /<command-name>\/doctor<\/command-name>|Base directory for this skill|Health.check your setup/.test(JSON.stringify(request.body))) };
  assert.ok((report['doctor'] as { nativeExpansion: boolean }).nativeExpansion, 'Native /doctor instructions were not observed');
  await page.keyboard.press('Escape'); await type('/reload-plugins');
  await screen.getByText(/(?:reload(?:ed)?|no|not).*plugins|plugins.*(?:reload(?:ed)?|installed)/i, { exact: false }).first().waitFor(); report['reloadPlugins'] = true;
  await page.reload(); await page.getByRole('button', { name: '原生控制', exact: true }).click();
  await page.getByText('原生 CLI', { exact: true }).click(); await page.getByText('已连接 · running', { exact: false }).waitFor();
  const retained = await page.request.get(base + '/api/native-terminal?sessionId=' + session.id); assert.equal((await retained.json()).terminals[0].process.pid, terminal.process.pid);
  report['refreshPreservesPid'] = true;
  await page.getByRole('button', { name: '关闭并清除日志' }).click(); report['passed'] = true;
} catch (error) { report['error'] = error instanceof Error ? error.message : String(error); report['screen'] = await page.locator('body').innerText().catch(() => ''); process.exitCode = 1; }
finally {
  report['modelRequests'] = control.requests.length;
  report['profileFiles'] = await readdir(isolated.dirs.CLAUDE_CONFIG_DIR).catch(() => []);
  await mkdir(resolve(reportPath, '..'), { recursive: true }); await page.screenshot({ path: reportPath + '.png', fullPage: true }).catch(() => undefined);
  await browser.close(); await ctx.close(); await model.close();
  await rm(isolated.dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ passed: report['passed'], error: report['error'], report: reportPath }) + '\n');
}
