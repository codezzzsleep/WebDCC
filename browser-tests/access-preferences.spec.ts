import { chromium, type Browser } from '@playwright/test';
import type { AgentAdapter, CreateOpts, Command, AccessModeOption } from '@webdcc/protocol';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';

const modes: Record<string, { id: string; label: string }> = {
  codex: { id: 'workspace', label: '工作区可写' },
  dsh: { id: 'workspace-write', label: '工作区写入' },
  'claude-code': { id: 'acceptEdits', label: '自动接受编辑' },
};

it.each([
  { agent: 'codex', preference: 'workspace', expected: 'workspace' },
  { agent: 'dsh', preference: 'workspace-write', expected: 'workspace-write' },
  { agent: 'claude-code', preference: 'acceptEdits', expected: 'acceptEdits' },
  { agent: 'codex', preference: 'inherit', expected: 'inherit' },
  { agent: 'codex', preference: 'removed-mode', expected: 'inherit' },
])('$agent restores preference $preference as $expected on a fresh page and preserves the creation contract', async ({ agent, preference, expected }) => {
  const ctx = await createSourceTestApp();
  let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('Preference workspace', ctx.dataDir);
    const declared = modes[agent]!;
    const selected = expected === 'inherit' ? { id: 'inherit', label: '沿用原生权限' } : declared;
    const adapter: AgentAdapter = ctx.manager.adapter(agent);
    const catalog: AccessModeOption[] = [{ id: 'inherit', label: '沿用原生权限', allowed: true, implemented: true }, { ...declared, allowed: true, implemented: true }];
    adapter.listAccessModes = async () => catalog;
    const nativeCreate = adapter.create.bind(adapter);
    const launches: CreateOpts[] = [];
    adapter.create = async options => { launches.push(options); return nativeCreate(options); };
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('missing preference listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const commands: Command[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/commands') commands.push((request.postDataJSON() as { command: Command }).command);
    });
    await page.goto(`${base}/new?w=${workspace.id}&agent=${agent}`);
    if (preference === 'removed-mode') {
      await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: `wdcc:access-mode-default:${agent}`, value: preference });
    } else {
      await page.getByTestId('access-mode').click();
      await page.getByTestId(`access-mode-${preference}`).click();
    }
    expect(await page.evaluate(key => localStorage.getItem(key), `wdcc:access-mode-default:${agent}`)).toBe(preference);
    await page.reload();
    const permission = page.getByTestId('access-mode');
    await expect.poll(() => permission.textContent()).toBe(selected.label);
    await page.getByTestId('new-session-input').fill('Original preference request text');
    await page.getByTestId('new-session-send').click();
    await expect.poll(() => launches.length).toBe(1);
    const create = commands.find(command => command.op === 'create-session');
    expect(create).toMatchObject({ op: 'create-session', agent, accessMode: selected.id });
    expect(launches[0]?.accessMode).toBe(selected.id === 'inherit' ? undefined : selected.id);
    const session = ctx.store.getSession(launches[0]!.sessionId);
    expect(session?.permissions.requested).toBe(selected.id === 'inherit' ? null : selected.id);
    expect(await page.evaluate(key => localStorage.getItem(key), `wdcc:access-mode-default:${agent}`)).toBe(preference);
    expect(session?.permissions.source).toBe('fake/create');
    await expect.poll(() => ctx.store.allEvents(session!.id).some(event => event.kind === 'user.message' && (event.data as { text?: string }).text === 'Original preference request text')).toBe(true);
  } finally { await browser?.close(); await ctx.close(); }
}, 60000);
