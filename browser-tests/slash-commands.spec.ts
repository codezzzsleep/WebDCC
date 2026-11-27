import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AgentAdapter } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from './helpers.js';
import { codexSlashCommands } from '../packages/adapters/codex/src/slash.js';

it('Codex new-session menu reads all commands, applies Web choices without creation and preserves native control routing', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('new slash browser', ctx.dataDir);
    const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' });
    adapter.previewSlashCommands = async () => codexSlashCommands;
    adapter.slashCommands = async () => codexSlashCommands;
    adapter.inputModes = async () => ({ modes: [{ id: 'default', label: '默认' }, { id: 'plan', label: '计划' }], observedMode: null });
    let creates = 0, sends = 0; const original = adapter.create.bind(adapter);
    adapter.create = async opts => { creates++; return original(opts); };
    adapter.send = async () => { sends++; };
    const controls: string[] = [];
    adapter.executeSlashControl = async (_id, line) => { controls.push(line); return { text: 'Status read without model input' }; };
    ctx.manager.registerAdapter(adapter);
    const provider = await ctx.app.inject({ method: 'POST', url: '/api/providers', headers: { cookie: ctx.cookie }, payload: { name: 'Custom fixture', baseUrl: 'https://fixture.invalid/v1', protocols: ['openai-responses'], models: ['gpt-fixture-a', 'gpt-fixture-b'], apiKey: 'fixture-only' } });
    expect(provider.statusCode).toBe(200);
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/new?w=${workspace.id}&agent=codex`);
    const input = page.getByTestId('new-session-input'); await input.waitFor();
    await input.fill('/');
    await expect.poll(() => page.getByTestId('slash-menu').locator('.menu-item').count(), { timeout: 5000 }).toBe(65);
    expect(creates).toBe(0); expect(ctx.store.listSessions()).toEqual([]);
    await input.press('Escape');
    await page.getByTestId('agent-card-dsh').click();
    await input.fill('');
    await input.fill('/');
    await page.getByText('建立原生会话后读取此 Harness 的项目指令目录').waitFor();
    expect(await page.getByTestId('slash-menu').locator('.menu-item').count()).toBe(0);
    await input.press('Escape');
    await page.getByTestId('agent-card-codex').click();
    await input.fill('');
    await input.fill('/');
    await expect.poll(() => page.getByTestId('slash-menu').locator('.menu-item').count()).toBe(65);
    await page.getByTestId('slash-menu').getByRole('button', { name: /^\/model\b/ }).click();
    await page.getByRole('menuitemradio', { name: /gpt-fixture-b/ }).click();
    expect(await input.inputValue()).toBe(''); expect(creates).toBe(0);
    await input.fill('/permissions');
    await page.getByTestId('slash-menu').getByRole('button', { name: /^\/permissions\b/ }).click();
    await page.getByTestId('access-mode-read-only').click(); expect(creates).toBe(0);
    await input.fill('/plan');
    await page.getByTestId('slash-menu').getByRole('button', { name: /^\/plan\b/ }).click();
    await expect.poll(() => page.getByTestId('codex-input-mode').inputValue()).toBe('plan'); expect(creates).toBe(0);
    await input.fill('/does-not-exist'); await input.press('Enter');
    await page.getByText('当前原生目录没有此指令，请核对名称或重新读取目录').waitFor();
    expect(await input.inputValue()).toBe('/does-not-exist'); expect(creates).toBe(0); expect(sends).toBe(0);
    await input.fill('/sta');
    await page.getByTestId('slash-menu').getByRole('button', { name: /^\/status\b/ }).click();
    expect(await input.inputValue()).toBe('/status'); expect(creates).toBe(0);
    await input.press('Enter'); await page.waitForURL('**/s/**');
    await page.getByText('Status read without model input', { exact: false }).first().waitFor();
    expect(creates).toBe(1); expect(sends).toBe(0); expect(controls).toEqual(['/status']);
    await page.reload(); await page.getByTestId('composer-input').waitFor();
    await page.getByTestId('composer-input').fill('/');
    await expect.poll(() => page.getByTestId('slash-menu').locator('.menu-item').count()).toBe(65);
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);

async function fixture(agent: 'codex' | 'claude-code' | 'dsh' = 'codex') {
  const ctx = await createSourceTestApp();
  const workspace = ctx.store.createWorkspace('slash browser', ctx.dataDir);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent });
  ctx.store.updateSession(session.id, { nativeId: 'slash-native' });
  const adapter: AgentAdapter = new FakeAdapter({ id: agent });
  adapter.nativeState = () => ({ nativeId: 'slash-native', turnActive: false });
  adapter.nativeCatalog = async () => ({ actions: [] });
  adapter.slashCommands = async () => [{ name: '/goal', route: 'native-control', source: 'fixture native catalog' }, { name: '/theme', route: 'native-terminal' }];
  ctx.manager.registerAdapter(adapter);
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('No listener');
  const base = `http://127.0.0.1:${address.port}`;
  const browser: Browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
  await page.goto(`${base}/s/${session.id}`); await page.getByTestId('composer-input').waitFor();
  return { ctx, adapter, workspace, session, browser, page, base, async close() { await browser.close(); await ctx.close(); } };
}

it('product slash result and edit form recover after refresh; new text does not reuse the original contentParts', async () => {
  const h = await fixture();
  try {
    const inputs: string[] = [];
    h.adapter.executeSlashControl = async (_id, line, options) => {
      inputs.push(line);
      return options?.editGoal ? { text: 'Saved native objective: ' + line.slice(6) } : { form: 'goal-edit', objective: 'old native objective' };
    };
    h.adapter.send = async () => { throw new Error('Control reached the model'); };
    await h.page.getByTestId('composer-input').fill('/goal edit'); await h.page.getByTestId('composer-input').press('Enter');
    await h.page.getByLabel('原生目标', { exact: true }).waitFor();
    expect(inputs).toEqual(['/goal edit']);
    await h.page.reload(); await h.page.getByLabel('原生目标', { exact: true }).waitFor();
    expect(inputs).toHaveLength(1);
    await h.page.getByLabel('原生目标', { exact: true }).fill('edited\n中文');
    await h.page.getByRole('button', { name: '提交原生修改' }).click();
    await h.page.getByLabel('原生指令结果', { exact: true }).getByText('Saved native objective: edited', { exact: false }).waitFor();
    expect(inputs).toEqual(['/goal edit', '/goal edited\n中文']);
    await h.page.reload(); await h.page.getByText('Saved native objective: edited', { exact: false }).first().waitFor();
    expect(inputs).toHaveLength(2);
    await h.page.getByRole('button', { name: '关闭指令结果' }).click();
    await h.page.reload(); expect(await h.page.getByLabel('原生指令结果', { exact: true }).count()).toBe(0);
  } finally { await h.close(); }
});

it.each(['codex', 'claude-code'] as const)('%s goal replacement confirmation restores file references after refresh without submitting twice', async agent => {
  const h = await fixture(agent);
  try {
    h.adapter.slashCommands = async () => [{ name: '/goal', route: 'native-control', supportsAttachments: true }];
    const inputs: { line: string; content: unknown }[] = [];
    h.adapter.executeSlashControl = async (_id, line, options) => {
      inputs.push({ line, content: options?.contentParts });
      return options?.replaceGoal ? { text: 'Native replacement saved' } : { form: 'goal-replace', objective: line.slice(6) };
    };
    const line = '/goal replacement\n中文';
    await h.page.getByTestId('composer-input').fill(line);
    await h.page.getByTestId('add-file-input').setInputFiles({ name: 'reference.md', mimeType: 'text/markdown', buffer: Buffer.from('original\r\n中文') });
    await expect.poll(() => h.page.getByTestId('send-button').isEnabled()).toBe(true);
    const preparedLine = await h.page.getByTestId('composer-input').inputValue();
    if (agent === 'codex') {
      expect(preparedLine.startsWith(line + '\n')).toBe(true);
      expect(JSON.parse(preparedLine.slice(line.length + 1))).toMatch(/^\.webdcc\/uploads\/.*-reference\.md$/);
    } else expect(preparedLine).toBe(line);
    await h.page.getByTestId('composer-input').press('Enter');
    await h.page.getByRole('button', { name: '确认替换原生目标' }).waitFor();
    expect(inputs).toHaveLength(1);
    await h.page.reload(); await h.page.getByRole('button', { name: '确认替换原生目标' }).waitFor();
    expect(inputs).toHaveLength(1);
    await h.page.getByRole('button', { name: '确认替换原生目标' }).click();
    await h.page.getByText('Native replacement saved', { exact: false }).first().waitFor();
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.line).toBe(preparedLine);
    expect(inputs[1]?.line).toBe(preparedLine);
    if (agent === 'codex') {
      expect(inputs[0]?.content).toEqual({ version: 1, parts: [{ type: 'text', text: preparedLine }] });
      // The existing confirmation flow carries plain text in line, without
      // duplicating it as contentParts when no native attachments remain.
      expect(inputs[1]?.content).toBeUndefined();
    } else {
      expect(inputs[1]).toEqual(inputs[0]);
      expect(inputs[1]?.content).toMatchObject({ parts: [{ type: 'text', text: line }, { type: 'file', name: 'reference.md', sha256: expect.any(String), path: expect.any(String) }] });
    }
  } finally { await h.close(); }
});

it.each(['new', 'session'] as const)('%s Codex slash cannot bypass failed file preparation with a button or Enter', async mode => {
  const h = await fixture();
  try {
    const catalog = async () => [{ name: '/goal', route: 'native-control' as const, supportsAttachments: true }];
    h.adapter.slashCommands = catalog; h.adapter.previewSlashCommands = catalog;
    const inputs: { line: string; content: unknown }[] = [];
    h.adapter.executeSlashControl = async (_id, line, options) => {
      inputs.push({ line, content: options?.contentParts }); return { text: 'Prepared goal accepted' };
    };
    await h.page.route('**/api/workspaces/*/attach', route => route.fulfill({ status: 503, json: { error: 'copy temporarily unavailable' } }));
    if (mode === 'new') await h.page.goto(`${h.base}/new?w=${h.workspace.id}&agent=codex`);
    const input = h.page.getByTestId(mode === 'new' ? 'new-session-input' : 'composer-input');
    const send = h.page.getByTestId(mode === 'new' ? 'new-session-send' : 'send-button');
    const line = '/goal read this file'; await input.fill(line);
    await h.page.getByTestId('add-file-input').setInputFiles({ name: 'retry-goal.md', mimeType: 'text/markdown', buffer: Buffer.from('goal exact bytes') });
    await h.page.getByRole('alert').filter({ hasText: 'copy temporarily unavailable' }).waitFor();
    expect(await send.isDisabled()).toBe(true);
    await input.press('Enter'); await h.page.waitForTimeout(350);
    expect(inputs).toHaveLength(0); expect(h.ctx.store.listSessions()).toHaveLength(1);
    expect(await input.inputValue()).toBe(line);
    await h.page.unroute('**/api/workspaces/*/attach');
    await h.page.getByRole('button', { name: '重试文件准备', exact: true }).click();
    await expect.poll(() => input.inputValue()).toContain('.webdcc/uploads/');
    const prepared = await input.inputValue(); await expect.poll(() => send.isEnabled()).toBe(true);
    await input.press('Enter'); if (mode === 'new') await h.page.waitForURL('**/s/**');
    await h.page.getByText('Prepared goal accepted', { exact: false }).first().waitFor();
    expect(inputs).toEqual([{ line: prepared, content: { version: 1, parts: [{ type: 'text', text: prepared }] } }]);
  } finally { await h.close(); }
});

it('product catalog preserves failure reasons, retries, routes terminal commands, and keeps unknown command drafts', async () => {
  const h = await fixture();
  try {
    let reads = 0;
    h.adapter.slashCommands = async () => { if (++reads === 1) throw new Error('Native Host denied command discovery'); return [{ name: '/theme', route: 'native-terminal', source: 'Native CLI' }]; };
    await h.page.getByTestId('composer-input').fill('/');
    await h.page.getByText('原生指令目录读取失败：Native Host denied command discovery').waitFor();
    await h.page.getByRole('button', { name: '重新读取指令' }).click();
    await h.page.getByTestId('slash-menu').getByRole('button', { name: '/theme', exact: false }).click();
    await h.page.getByTestId('composer-input').press('Enter');
    await h.page.getByText('待执行原生指令：', { exact: false }).waitFor();
    expect(await h.page.getByTestId('composer-input').inputValue()).toBe('/theme');
    await h.page.getByRole('button', { name: '关闭', exact: true }).click();
    await h.page.getByTestId('composer-input').fill('/not-a-native-command\n  original');
    await h.page.getByTestId('composer-input').press('Enter');
    await h.page.getByText('当前原生目录没有此指令，请核对名称或重新读取目录').waitFor();
    expect(h.ctx.store.allEvents(h.session.id).filter(event => event.kind === 'user.message')).toHaveLength(0);
    expect(await h.page.getByTestId('composer-input').inputValue()).toBe('/not-a-native-command\n  original');
  } finally { await h.close(); }
});

it('Claude /model stays on its native SDK route and is not intercepted by the Web model picker', async () => {
  const h = await fixture('claude-code');
  try {
    h.adapter.slashCommands = async () => [{ name: '/model', route: 'native-input', source: 'Claude SDK' }];
    const lines: string[] = []; const original = h.adapter.send.bind(h.adapter);
    h.adapter.send = async (id, input) => { lines.push(input.text); await original(id, input); };
    await h.page.getByTestId('composer-input').fill('/model'); await h.page.getByTestId('composer-input').press('Enter');
    await expect.poll(() => lines).toEqual(['/model']);
  } finally { await h.close(); }
});

it.each(['dsh', 'claude-code'] as const)('%s reads a pre-creation catalog and executes only after an explicit send', async agent => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('native new preview', ctx.dataDir);
    const adapter: AgentAdapter = new FakeAdapter({ id: agent }); let creates = 0, sends = 0;
    const create = adapter.create.bind(adapter); adapter.create = async opts => { creates++; return create(opts); };
    const name = agent === 'dsh' ? '/goal' : '/project-preview';
    adapter.previewSlashCommands = async () => ({ commands: [{ name: agent === 'dsh' ? '/known-baseline' : name, route: agent === 'dsh' ? 'native-control' : 'native-input', supportsAttachments: true }], complete: false, ...(agent === 'dsh' ? { reason: 'DSH 基线预览，创建后核对实际目录' } : {}) });
    adapter.slashCommands = async () => [{ name, route: agent === 'dsh' ? 'native-control' : 'native-input', supportsAttachments: true }];
    const originalSend = adapter.send.bind(adapter); adapter.send = async (id, input) => { sends++; await originalSend(id, input); };
    const lines: string[] = []; adapter.executeSlashControl = async (_id, line) => { lines.push(line); return { text: 'Native DSH goal inspected' }; };
    ctx.manager.registerAdapter(adapter); const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/new?w=${workspace.id}&agent=${agent}`); const input = page.getByTestId('new-session-input'); await input.waitFor();
    await input.fill('/');
    if (agent === 'dsh') { await page.getByText('DSH 基线预览，创建后核对实际目录').waitFor(); await input.fill(name); }
    else await page.getByTestId('slash-menu').getByRole('button', { name: new RegExp(name) }).click();
    expect(await input.inputValue()).toBe(name); expect(creates).toBe(0); expect(sends).toBe(0);
    await input.press('Enter'); await page.waitForURL('**/s/**');
    if (agent === 'dsh') { await page.getByText('Native DSH goal inspected').first().waitFor(); expect(lines).toEqual(['/goal']); expect(sends).toBe(0); }
    else await expect.poll(() => sends).toBe(1);
    expect(creates).toBe(1);
    await page.reload(); await page.getByTestId('composer-input').waitFor();
    await page.getByTestId('composer-input').fill('/'); await page.getByTestId('slash-menu').getByRole('button', { name: new RegExp(name) }).waitFor();
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it.each(['/status', '/status details'])('recovers the first native command %s after a catalog interruption and a lost result', async retryLine => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('new slash retry', ctx.dataDir);
    const adapter: AgentAdapter = new FakeAdapter({ id: 'codex' });
    adapter.previewSlashCommands = async () => codexSlashCommands;
    adapter.slashCommands = async () => codexSlashCommands;
    const controls: string[] = [];
    adapter.executeSlashControl = async (_id, line) => { controls.push(line); return { text: 'First native command returned' }; };
    ctx.manager.registerAdapter(adapter);
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.route('**/api/sessions/*/slash-commands', route => route.fulfill({ status: 503, body: 'controlled catalog interruption' }), { times: 1 });
    await page.goto(`${base}/new?w=${workspace.id}&agent=codex`);
    const input = page.getByTestId('new-session-input');
    await input.fill('/status');
    await input.press('Enter');
    await page.getByRole('alert').filter({ hasText: 'controlled catalog interruption' }).waitFor();
    const [created] = ctx.store.listSessions();
    expect(created).toBeDefined();
    expect(ctx.store.getDraft(created!.id)).toMatchObject({ text: '/status', revision: 1 });
    expect(controls).toEqual([]);

    await page.reload();
    await expect.poll(() => input.inputValue()).toBe('/status');
    const errors: number[] = [];
    page.on('response', response => {
      if (response.url().endsWith('/draft') && response.request().method() === 'PUT' && response.status() >= 400) errors.push(response.status());
    });
    let posts = 0;
    let originalCommandId = '';
    await page.route('**/api/sessions/*/slash-commands', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      posts++;
      if (posts > 1) { await route.continue(); return; }
      originalCommandId = (route.request().postDataJSON() as { commandId: string }).commandId;
      const reply = await route.fetch();
      expect(reply.status()).toBe(200);
      await route.fulfill({ status: 503, body: 'controlled lost native result' });
    });
    await input.fill(retryLine);
    await input.press('Enter');
    await page.getByRole('alert').filter({ hasText: 'controlled lost native result' }).waitFor({ timeout: 5_000 });
    expect(controls).toEqual([retryLine]);
    expect(errors).toEqual([]);
    expect(ctx.store.getDraft(created!.id).text).toBe(retryLine);
    expect(ctx.store.nativeActions.slashResult(originalCommandId, created!.id)?.receipt.state).toBe('completed');

    // Simulate another tab editing the created session while the first tab
    // still has the submitted original in its new-session draft.
    const remote = await ctx.app.inject({ method: 'PUT', url: `/api/sessions/${created!.id}/draft`, headers: { cookie: ctx.cookie },
      payload: { text: 'New cloud draft', contentParts: { version: 1, parts: [{ type: 'text', text: 'New cloud draft' }] },
        expectedRevision: ctx.store.getDraft(created!.id).revision } });
    expect(remote.statusCode).toBe(200);
    await page.reload();
    await expect.poll(() => input.inputValue()).toBe(retryLine);
    await input.press('Enter');
    await page.waitForURL(`**/s/${created!.id}`);
    expect(ctx.store.listSessions().map(session => session.id)).toEqual([created!.id]);
    await page.getByLabel('原生指令结果', { exact: true }).getByText('First native command returned', { exact: true }).waitFor();
    await expect.poll(() => page.getByTestId('composer-input').inputValue()).toBe('New cloud draft');
    expect(ctx.store.getDraft(created!.id).text).toBe('New cloud draft');
    expect(controls).toEqual([retryLine]);
    expect(posts).toBe(1);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
