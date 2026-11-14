import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { issueCookie, isAuthenticated } from '../packages/server/src/auth.js';
import { registerNativeTerminalRoutes } from '../packages/server/src/native-terminal-routes.js';
import { resolveClaudeTerminalBinary } from '../packages/server/src/native-surface.js';
import { createTerminalFixture, terminalEventually } from '../packages/server/test/native-terminal-fixture.js';
import { nativeTerminalSourceFingerprint, writeNativeTerminalEvidence } from '../packages/server/test/native-terminal-evidence.js';
import type FastifyFactory from '../packages/server/node_modules/fastify/fastify.js';
import type WebsocketPlugin from '../packages/server/node_modules/@fastify/websocket/index.js';

const serverRequire = createRequire(new URL('../packages/server/package.json', import.meta.url));
const Fastify = serverRequire('fastify') as typeof FastifyFactory;
const websocket = serverRequire('@fastify/websocket') as typeof WebsocketPlugin;

async function terminalBrowserFixture(options: Parameters<typeof createTerminalFixture>[0] = {}) {
  const ctx = await createTerminalFixture(options);
  const web = await mkdtemp(join(tmpdir(), 'wdcc-terminal-browser-'));
  try {
    await build({ stdin: { contents: `import {createRoot} from 'react-dom/client'; import {NativeSurface} from './src/components/NativeSurface.tsx'; createRoot(document.getElementById('root')).render(<NativeSurface sessionId=${JSON.stringify(ctx.source.id)} agent=${JSON.stringify(options.agent ?? 'codex')} />);`, resolveDir: '/root/WebDCC-repair/packages/web', loader: 'tsx' }, bundle: true, outfile: join(web, 'ui.js'), format: 'esm', platform: 'browser', jsx: 'automatic' });
  } catch (error) { await ctx.close(); await rm(web, { recursive: true, force: true }); throw error; }
  const app = Fastify(); const token = 'isolated-terminal-browser-token'; await app.register(websocket);
  app.get('/', async (request, reply) => {
    if ((request.query as { token?: string }).token === token) reply.header('set-cookie', `wdcc-auth=${issueCookie(token)}; Path=/; HttpOnly; SameSite=Lax`);
    else if (!isAuthenticated(token, request.headers.cookie)) return reply.status(401).send('unauthorized');
    return reply.type('text/html').send('<!doctype html><html><head><link rel="stylesheet" href="/ui.css"></head><body><main id="root"></main><script type="module" src="/ui.js"></script></body></html>');
  });
  app.get('/ui.js', async (_request, reply) => reply.type('text/javascript').send(createReadStream(join(web, 'ui.js'))));
  app.get('/ui.css', async (_request, reply) => reply.type('text/css').send(createReadStream(join(web, 'ui.css'))));
  registerNativeTerminalRoutes(app, { supervisor: ctx.supervisor, config: { host: '127.0.0.1', port: 0, token }, executeControl: async (_action, run) => run() });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ headless: true }); const context = await browser.newContext(); await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: address }); const page = await context.newPage();
  await page.goto(`${address}/?token=${token}`);
  return { ...ctx, address, page, async close() { await browser.close(); await app.close(); await ctx.close(); await rm(web, { recursive: true, force: true }); } };
}

it('operates the real PTY through source xterm, rejects HTML, and refreshes without restarting', async () => {
  const sourceFingerprint = await nativeTerminalSourceFingerprint(); let passed = false;
  const ctx = await terminalBrowserFixture();
  try {
    await ctx.page.getByRole('checkbox').check();
    const createdResponse = ctx.page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/native-terminal'));
    await ctx.page.getByRole('button', { name: '创建新原生会话' }).click();
    const created = await createdResponse; const createdBody = await created.json(); expect(created.status()).toBe(200); expect(createdBody.sourceSessionId).toBe(ctx.source.id); expect(ctx.supervisor.list(ctx.source.id)).toHaveLength(1);
    await terminalEventually(() => ctx.supervisor.list(ctx.source.id).length === 1);
    const terminal = ctx.supervisor.list(ctx.source.id)[0]!;
    await ctx.page.getByText('已连接 · running', { exact: false }).waitFor();
    expect(await ctx.page.locator('img').count()).toBe(0);
    expect(await ctx.page.evaluate(() => (globalThis as { terminalInjected?: boolean }).terminalInjected)).toBeUndefined();
    const input = ctx.page.locator('.xterm-helper-textarea');
    await input.focus(); await ctx.page.keyboard.type('browser-'); await ctx.page.evaluate(() => navigator.clipboard.writeText('你好🐈')); await ctx.page.getByRole('button', { name: '粘贴剪贴板' }).click();
    await terminalEventually(() => ctx.supervisor.snapshot(terminal.id).chunks.some(chunk => chunk.data.includes('INPUT-ALL browser-你好🐈')));
    await ctx.page.setViewportSize({ width: 700, height: 750 });
    await terminalEventually(() => ctx.supervisor.snapshot(terminal.id).chunks.some(chunk => chunk.data.includes('SIZE')));
    await ctx.page.reload(); await ctx.page.getByText('已连接 · running', { exact: false }).waitFor();
    expect(ctx.supervisor.list(ctx.source.id)).toHaveLength(1); expect(ctx.supervisor.get(terminal.id).process.pid).toBe(terminal.process.pid);
    await ctx.page.locator('.xterm-helper-textarea').focus(); await ctx.page.keyboard.type('after-refresh');
    await terminalEventually(() => ctx.supervisor.snapshot(terminal.id).chunks.some(chunk => chunk.data.includes('browser-你好🐈after-refresh')));
    const download = ctx.page.waitForEvent('download'); await ctx.page.getByRole('link', { name: '下载临时日志' }).click(); expect((await download).suggestedFilename()).toBe('native-terminal-output.txt');
    await ctx.page.getByRole('button', { name: '关闭并清除日志' }).click(); await terminalEventually(() => ctx.supervisor.metrics().terminals === 0);
    expect(ctx.supervisor.metrics()).toEqual({ terminals: 0, processes: 0, ptys: 0, clients: 0, listeners: 0, replayBytes: 0, logFiles: 0 });
    passed = true;
  } finally {
    await mkdir('.artifacts/native-terminal-validation', { recursive: true });
    const terminals = ctx.supervisor.list(ctx.source.id);
    if (terminals.length) await writeFile('.artifacts/native-terminal-validation/fixture-output.txt', ctx.supervisor.snapshot(terminals[0]!.id).chunks.map(chunk => chunk.data).join(''));
    await ctx.page.screenshot({ path: '.artifacts/native-terminal-validation/fixture-screen.png', fullPage: true });
    await ctx.close();
    await writeNativeTerminalEvidence('fixture', sourceFingerprint, { state: passed ? 'passed' : 'failed', nativeCli: false, pty: 'real node-pty', assertions: ['browser keyboard and Unicode clipboard paste', 'resize', 'HTML remains terminal text', 'refresh keeps PID', 'log download', 'confirmed exit and zero resources'], resourcesAfterClose: ctx.supervisor.metrics() });
  }
});

it('operates fixed Codex 0.167.0 native keymap/theme/vim in Chromium without a model request', async () => {
  const sourceFingerprint = await nativeTerminalSourceFingerprint(); let passed = false;
  const ctx = await terminalBrowserFixture({ nativeExecutable: '/root/WebDCC-repair/.artifacts/native-baseline/package/vendor/x86_64-unknown-linux-musl/bin/codex' });
  let modelRequests = 0;
  const model = createServer((request, reply) => { modelRequests++; request.resume(); reply.writeHead(503, { 'content-type': 'application/json' }); reply.end('{"error":{"message":"No model requests are permitted in this terminal control test"}}'); });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve)); const modelAddress = model.address();
  if (modelAddress === null || typeof modelAddress === 'string') throw new Error('isolated model listener failed');
  try {
    // An isolated provider removes account onboarding. No model turn is sent.
    await writeFile(join(ctx.profile, 'config.toml'), `model_provider="terminal_probe"\nmodel="probe-model"\n[model_providers.terminal_probe]\nname="Isolated terminal probe"\nbase_url="http://127.0.0.1:${modelAddress.port}/v1"\nwire_api="responses"\n[projects.${JSON.stringify(ctx.cwd)}]\ntrust_level="trusted"\n`);
    await mkdir(join(ctx.home, '.cache'), { recursive: true });
    await ctx.page.getByRole('checkbox').check(); const createdResponse = ctx.page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/native-terminal'));
    await ctx.page.getByRole('button', { name: '创建新原生会话' }).click(); const created = await createdResponse; const createdBody = await created.json(); expect(created.status()).toBe(200); expect(createdBody.sourceSessionId).toBe(ctx.source.id); expect(ctx.supervisor.list(ctx.source.id)).toHaveLength(1);
    await terminalEventually(() => ctx.supervisor.list(ctx.source.id).length === 1);
    const terminal = ctx.supervisor.list(ctx.source.id)[0]!;
    const transcript = () => ctx.supervisor.snapshot(terminal.id).chunks.map(chunk => chunk.data).join('');
    await terminalEventually(() => transcript().includes('state=idle:app=codex') && transcript().includes('probe-model default'), 10_000);
    await ctx.page.getByText('已连接 · running', { exact: false }).waitFor();
    await ctx.page.locator('.xterm-helper-textarea').focus();
    // Only recognized native commands are submitted. Startup text/typed echo
    // cannot satisfy a command result predicate.
    let cursor = transcript().length;
    await ctx.page.keyboard.type('/', { delay: 30 });
    await terminalEventually(() => /\/keymap/.test(transcript().slice(cursor)) && /\/vim/.test(transcript().slice(cursor)), 10_000);
    await mkdir('.artifacts/native-terminal-validation', { recursive: true });
    await ctx.page.screenshot({ path: '.artifacts/native-terminal-validation/codex-palette.png', fullPage: true });
    cursor = transcript().length; await ctx.page.keyboard.type('keymap', { delay: 30 }); await ctx.page.keyboard.press('Enter');
    await terminalEventually(() => /All configurable shortcuts/.test(transcript().slice(cursor)) && /actions,.*customized/.test(transcript().slice(cursor)), 10_000);
    await ctx.page.screenshot({ path: '.artifacts/native-terminal-validation/codex-keymap.png', fullPage: true });
    await ctx.page.keyboard.press('Escape'); await ctx.page.keyboard.press('Control+U');
    cursor = transcript().length; await ctx.page.keyboard.type('/theme', { delay: 30 }); await ctx.page.keyboard.press('Enter');
    await terminalEventually(() => /Select Syntax Theme/.test(transcript().slice(cursor)) && /live preview themes/.test(transcript().slice(cursor)), 10_000);
    await ctx.page.screenshot({ path: '.artifacts/native-terminal-validation/codex-theme.png', fullPage: true });
    await ctx.page.keyboard.press('Escape'); await ctx.page.keyboard.press('Control+U');
    cursor = transcript().length; await ctx.page.keyboard.type('/vim', { delay: 30 }); await ctx.page.keyboard.press('Enter');
    await terminalEventually(() => /Vim mode enabled|Vim mode is on|VIM INSERT|-- INSERT --/.test(transcript().slice(cursor)), 10_000);
    expect(modelRequests).toBe(0);
    await mkdir('.artifacts/native-terminal-validation', { recursive: true });
    await writeFile('.artifacts/native-terminal-validation/codex-output.txt', transcript());
    await ctx.page.screenshot({ path: '.artifacts/native-terminal-validation/codex-commands.png', fullPage: true });
    expect(ctx.supervisor.get(terminal.id).nativeVersion).toBe('0.167.0');
    await ctx.page.reload(); await ctx.page.getByText('已连接 · running', { exact: false }).waitFor();
    expect(ctx.supervisor.get(terminal.id).process.pid).toBe(terminal.process.pid);
    await ctx.page.getByRole('button', { name: '关闭并清除日志' }).click(); await terminalEventually(() => ctx.supervisor.metrics().terminals === 0);
    passed = true;
  } finally {
    await mkdir('.artifacts/native-terminal-validation', { recursive: true });
    await ctx.page.screenshot({ path: '.artifacts/native-terminal-validation/codex-screen.png', fullPage: true });
    const terminals = ctx.supervisor.list(ctx.source.id);
    if (terminals.length) await writeFile('.artifacts/native-terminal-validation/codex-output.txt', ctx.supervisor.snapshot(terminals[0]!.id).chunks.map(chunk => chunk.data).join(''));
    await ctx.close();
    await new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve()));
    await writeNativeTerminalEvidence('codex', sourceFingerprint, { state: passed ? 'passed' : 'failed', nativeCli: true, nativeVersion: '0.167.0', profile: 'isolated temporary HOME/CODEX_HOME', commands: ['/keymap', '/theme', '/vim'], modelRequests, paidModel: false,
      sameSessionTakeover: 'blocked: external release/arbitration and full history/settings roundtrip unverified', nativeSessionIdentity: 'unverified: no model turn/history record generated', resourcesAfterClose: ctx.supervisor.metrics() });
  }
}, 40_000);

it('opens the actual Claude Code 2.1.322 authentication surface in Chromium with an isolated profile', async () => {
  const sourceFingerprint = await nativeTerminalSourceFingerprint(); let passed = false;
  const ctx = await terminalBrowserFixture({ nativeExecutable: resolveClaudeTerminalBinary(), agent: 'claude-code' });
  try {
    await ctx.page.getByRole('checkbox').check(); await ctx.page.getByRole('button', { name: '创建新原生会话' }).click();
    await terminalEventually(() => ctx.supervisor.list(ctx.source.id).length === 1);
    const terminal = ctx.supervisor.list(ctx.source.id)[0]!;
    const transcript = () => ctx.supervisor.snapshot(terminal.id).chunks.map(chunk => chunk.data).join('');
    // Claude draws whitespace with cursor moves. Assert the rendered terminal
    // text rather than treating raw ANSI fragments as complete plain lines.
    await ctx.page.getByRole('list').getByText('Welcome to Claude Code v2.1.322', { exact: false }).waitFor({ timeout: 15_000 });
    expect(terminal.nativeVersion).toBe('2.1.322');
    await ctx.page.getByText('已连接 · running', { exact: false }).waitFor();
    await ctx.page.locator('.xterm-helper-textarea').focus();
    await ctx.page.getByRole('list').getByText('Choose the text style that looks best with your terminal', { exact: false }).waitFor();
    await ctx.page.keyboard.press('ArrowDown'); await ctx.page.keyboard.press('Enter');
    await ctx.page.getByText(/Claude subscription|Anthropic Console|Select login method|How do you want to log in/i).first().waitFor({ timeout: 15_000 });
    await mkdir('.artifacts/native-terminal-validation', { recursive: true });
    await writeFile('.artifacts/native-terminal-validation/claude-output.txt', transcript());
    await ctx.page.screenshot({ path: '.artifacts/native-terminal-validation/claude-authentication.png', fullPage: true });
    await ctx.page.reload(); await ctx.page.getByText('已连接 · running', { exact: false }).waitFor();
    expect(ctx.supervisor.get(terminal.id).process.pid).toBe(terminal.process.pid);
    await ctx.page.getByRole('button', { name: '关闭并清除日志' }).click(); await terminalEventually(() => ctx.supervisor.metrics().terminals === 0);
    passed = true;
  } finally {
    await mkdir('.artifacts/native-terminal-validation', { recursive: true });
    const terminals = ctx.supervisor.list(ctx.source.id);
    if (terminals.length) await writeFile('.artifacts/native-terminal-validation/claude-output.txt', ctx.supervisor.snapshot(terminals[0]!.id).chunks.map(chunk => chunk.data).join(''));
    await ctx.page.screenshot({ path: '.artifacts/native-terminal-validation/claude-final.png', fullPage: true });
    await ctx.close();
    await writeNativeTerminalEvidence('claude', sourceFingerprint, { state: passed ? 'passed' : 'failed', nativeCli: true, nativeVersion: '2.1.322', profile: 'isolated temporary HOME/CLAUDE_CONFIG_DIR', interactions: ['native theme choice', 'native login method screen', 'refresh keeps PID', 'confirmed close and zero resources'], authenticatedCommands: 'environment-blocked: no Claude account configured', paidModel: false, sameSessionTakeover: 'blocked', resourcesAfterClose: ctx.supervisor.metrics() });
  }
}, 40_000);

it('shows continuous identity drift and revokes browser writes (real PTY with an identity fixture)', async () => {
  const sourceFingerprint = await nativeTerminalSourceFingerprint(); let passed = false;
  let nativeId = 'native-fixture-a';
  const ctx = await terminalBrowserFixture({ identityProbeIntervalMs: 50, verifyNativeIdentity: async () => ({ nativeId, evidence: 'fixture-only, not native ownership proof' }) });
  try {
    await ctx.page.getByRole('button', { name: '创建新原生会话' }).click(); await terminalEventually(() => ctx.supervisor.list(ctx.source.id).length === 1);
    const terminal = ctx.supervisor.list(ctx.source.id)[0]!;
    await ctx.page.getByText('已连接 · running', { exact: false }).waitFor();
    nativeId = 'native-fixture-b';
    await ctx.page.getByText('原生身份需要核对：', { exact: false }).waitFor();
    await terminalEventually(() => ctx.supervisor.get(terminal.id).state === 'exited');
    expect(ctx.store.nativeOwners.get(terminal.ownerSessionId)?.state).toBe('uncertain');
    expect(ctx.supervisor.get(terminal.id).identityInspection.nativeId).toBe('native-fixture-b');
    expect(await ctx.page.getByRole('button', { name: '粘贴剪贴板' }).isDisabled()).toBe(true);
    await ctx.page.getByRole('button', { name: '关闭并清除日志' }).click(); await terminalEventually(() => ctx.supervisor.metrics().terminals === 0);
    passed = true;
  } finally {
    await ctx.close();
    await writeNativeTerminalEvidence('identity-drift', sourceFingerprint, { state: passed ? 'passed' : 'failed', nativeCli: false, pty: 'real node-pty with scripted identity observations', limitations: ['identity monitoring cannot prevent native side effects before detection', 'external native writers do not recognize WebDCC fencing', 'unobservable identity remains unverified'], resourcesAfterClose: ctx.supervisor.metrics() });
  }
});
