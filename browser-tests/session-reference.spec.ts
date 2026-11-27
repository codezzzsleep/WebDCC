import { chromium, type Browser, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { SessionReferenceResponse } from '../packages/protocol/src/index.js';
import { createSourceTestApp } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

async function clickCopy(page: Page, name: string): Promise<string> {
  await page.getByTestId('session-more').click();
  if (name === '复制会话引用') await page.getByTestId('copy-session-reference').click();
  else await page.getByRole('menuitem', { name, exact: true }).click();
  await expect.poll(() => page.locator('.session-copy-notice').innerText()).toContain('已复制');
  return page.evaluate(() => navigator.clipboard.readText());
}
it.each(['codex', 'claude-code', 'dsh'])('%s copies actual native identity and a readable whole saved conversation reference at desktop and phone widths', async agent => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { sessionId, workspaceId } = await seedWorkspaceAndSession(ctx, agent);
    const nativeId = agent === 'codex' ? '019ba535-dac6-7de5-a658-d837bedda232' : `native-${agent}-actual`;
    ctx.store.updateSession(sessionId, { nativeId, title: '此前会话的完整记录' });
    ctx.store.appendEvent({ sessionId, turnId: 'old-turn', itemKey: 'early', kind: 'user.message', data: { text: 'EARLY-HISTORY-MARKER' } });
    ctx.store.appendEvent({ sessionId, turnId: 'new-turn', itemKey: 'last', kind: 'assistant.message', data: { text: 'LATEST-HISTORY-MARKER' } });
    const before = ctx.store.allEvents(sessionId), base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] }); const page = await context.newPage();
    await context.addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 }); await page.goto(`${base}/s/${sessionId}`);
      await page.getByTestId('composer-input').waitFor(); await expect.poll(() => page.getByTestId('composer-input').isEnabled()).toBe(true);
      if (await page.getByTestId('dock').isVisible()) await page.getByRole('button', { name: '关闭停靠区', exact: true }).click();
      await page.getByTestId('composer-input').fill('未发送草稿必须保留');
      await page.evaluate(dock => history.replaceState(null, '', location.pathname + '?token=not-a-real-token' + (dock ? '&dock=files' : '&temporary=files') + '#transient'), width >= 1024);
      expect(await clickCopy(page, '复制链接')).toBe(`${base}/s/${sessionId}`);
      await page.evaluate(() => history.replaceState(null, '', location.pathname));
      expect(await clickCopy(page, '复制原生 Session ID')).toBe(nativeId);
      if (agent === 'codex') expect(await clickCopy(page, '复制 Deep Link')).toBe(`codex://threads/${nativeId}`);
      else { await page.getByTestId('session-more').click(); expect(await page.getByRole('menuitem', { name: '复制 Deep Link', exact: true }).count()).toBe(0); await page.getByTestId('session-more').click(); }
      const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/api/sessions/${sessionId}/reference`));
      const text = await clickCopy(page, '复制会话引用');
      const reference = await (await response).json() as SessionReferenceResponse;
      expect(text).toContain(`原生 Session ID：${nativeId}`); expect(text).toContain(`会话链接：${base}/s/${sessionId}`);
      expect(text).toContain(`记录文件：${JSON.stringify(reference.absolutePath)}`); expect(text).toContain(reference.sha256);
      expect(text).not.toContain('not-a-real-token'); expect(text).not.toContain('dock=files');
      const file = await readFile(reference.absolutePath, 'utf8');
      expect(file).toContain('EARLY-HISTORY-MARKER'); expect(file).toContain('LATEST-HISTORY-MARKER');
      const evidence = process.env['WDCC_SESSION_REFERENCE_EVIDENCE_DIR'];
      if (evidence) { await page.getByTestId('session-more').click(); await page.screenshot({ path: join(evidence, `${agent}-${width}-copy-menu.png`), fullPage: true }); await page.getByTestId('session-more').click(); }
      expect(await page.getByTestId('composer-input').inputValue()).toBe('未发送草稿必须保留');
      await page.reload(); await expect.poll(() => page.getByTestId('composer-input').inputValue()).toBe('未发送草稿必须保留');
    }
    expect(ctx.store.allEvents(sessionId)).toEqual(before);
    expect(ctx.store.getWorkspace(workspaceId)).toBeDefined();
  } finally { await browser?.close(); await ctx.close(); }
}, 40_000);

it('clipboard rejection exposes selectable reference and preparation failure never reports success', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex'); const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`); await expect.poll(() => page.getByTestId('composer-input').isEnabled()).toBe(true);
    await page.getByTestId('composer-input').fill('原草稿');
    await page.evaluate(() => { navigator.clipboard.write = async () => { throw new DOMException('fixture denied', 'NotAllowedError'); }; });
    await page.getByTestId('session-more').click(); await page.getByRole('menuitem', { name: /复制会话引用/ }).click();
    const dialog = page.getByRole('dialog', { name: '手动复制会话信息' }); await dialog.waitFor();
    expect(await dialog.getByRole('textbox').inputValue()).toContain('记录文件：');
    expect(await page.locator('.session-copy-notice').innerText()).toContain('复制未完成');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.route(`**/api/sessions/${sessionId}/reference`, route => route.request().method() === 'POST'
      ? route.fulfill({ status: 503, json: { error: 'fixture reference preparation unavailable' } }) : route.continue());
    await page.getByTestId('session-more').click(); await page.getByRole('menuitem', { name: /复制会话引用/ }).click();
    await expect.poll(() => page.locator('.session-copy-notice').innerText()).toContain('fixture reference preparation unavailable');
    expect(await page.getByRole('dialog', { name: '手动复制会话信息' }).count()).toBe(0);
    expect(await page.getByTestId('composer-input').inputValue()).toBe('原草稿');
    await page.unrouteAll({ behavior: 'wait' });
    await page.getByTestId('copy-session-reference').click(); await dialog.waitFor();
    expect(await dialog.getByRole('textbox').inputValue()).toContain('记录文件：');
    expect(await dialog.getByRole('textbox').evaluate(el => { const t = el as HTMLTextAreaElement; return t.selectionStart === 0 && t.selectionEnd === t.value.length; })).toBe(true);
  } finally { await browser?.close(); await ctx.close(); }
});

it('missing native identity is explicit and a delayed copy cannot copy another source after session navigation', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const { sessionId, workspaceId } = await seedWorkspaceAndSession(ctx, 'codex');
    const other = await ctx.manager.createSession({ workspaceId, agent: 'codex' });
    ctx.store.updateSession(sessionId, { nativeId: null });
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] }); const page = await context.newPage();
    await context.addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`); await page.getByTestId('composer-input').waitFor();
    await page.getByTestId('session-more').click();
    expect(await page.getByRole('menuitem', { name: '复制原生 Session ID', exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole('menuitem', { name: '复制 Deep Link', exact: true }).isDisabled()).toBe(true);
    ctx.store.updateSession(sessionId, { nativeId: '019ba535-dac6-7de5-a658-d837bedda232' });
    await page.getByTestId('session-more').click();
    await page.route(`**/api/sessions/${sessionId}/reference`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(); await gate; await route.fulfill({ response });
    });
    await page.evaluate(() => navigator.clipboard.writeText('prior-clipboard-retained'));
    const accepted = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(`/${sessionId}/reference`));
    await page.getByTestId('session-more').click(); await page.getByTestId('copy-session-reference').click(); await accepted;
    await page.locator(`[data-testid="session-row"][href="/s/${other.id}"]`).click(); await page.waitForURL(`**/s/${other.id}`);
    release(); await page.waitForTimeout(150);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('prior-clipboard-retained');
    expect(await page.locator('.session-copy-notice').count()).toBe(0);
  } finally { release(); await browser?.close(); await ctx.close(); }
});
