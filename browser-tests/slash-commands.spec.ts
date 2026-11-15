import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AgentAdapter } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from './helpers.js';

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
