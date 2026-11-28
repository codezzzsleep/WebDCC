import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';

it.each([390, 1280])('locates a collapsed older event and gives modal keyboard ownership at %spx', async width => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const w = ctx.store.createWorkspace('page interaction', ctx.dataDir);
    const s = ctx.store.createSession({ workspaceId: w.id, agent: 'codex' });
    for (let index = 0; index < 20; index++) {
      const turnId = 'turn-' + index;
      ctx.store.appendEvent({ sessionId: s.id, turnId, kind: 'user.message', itemKey: 'user-' + index, data: { text: 'Question ' + index } });
      ctx.store.appendEvent({ sessionId: s.id, turnId, kind: 'turn.started', itemKey: 'start-' + index, data: {} });
      ctx.store.appendEvent({ sessionId: s.id, turnId, kind: 'file.read', itemKey: 'read-' + index, data: { path: 'file-' + index + '.txt' } });
      ctx.store.appendEvent({ sessionId: s.id, turnId, kind: 'assistant.message', itemKey: 'answer-' + index, data: { text: 'Answer ' + index } });
      ctx.store.appendEvent({ sessionId: s.id, turnId, kind: 'turn.completed', itemKey: 'end-' + index, data: { status: 'completed' } });
    }
    const target = ctx.store.allEvents(s.id).find(event => event.itemKey === 'read-0')!;
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width, height: 700 } });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${s.id}`); await page.getByTestId('tab-trajectory').click();
    await page.getByTestId('trajectory-search').fill('read-0'); await page.getByTestId('trajectory-row').click();
    const row = page.locator(`[data-event-seq="${target.seq}"]`);
    await expect.poll(() => row.isVisible()).toBe(true);
    await expect.poll(() => row.evaluate(el => { const a=el.getBoundingClientRect(), b=el.closest('.timeline')!.getBoundingClientRect(); return a.top>=b.top-1&&a.bottom<=b.bottom+1&&document.activeElement===el; })).toBe(true);
    expect(await row.innerText()).toContain('file-0.txt'); expect(await row.getAttribute('class')).toContain('highlight');
    await page.getByTestId('tab-trajectory').click(); await page.getByTestId('trajectory-search').fill('start-0'); await page.getByTestId('trajectory-row').click();
    await page.getByTestId('trajectory-event-detail').waitFor(); expect(await page.getByTestId('trajectory-event-detail').innerText()).toContain('没有独立的对话卡片');
    await page.getByTestId('tab-trajectory').click(); await page.getByTestId('trajectory-search').fill('answer-19'); await page.getByTestId('trajectory-row').click();
    const trigger = page.getByRole('button', { name: '带到…', exact: true }).last(); await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    for (let index=0; index<8; index++) { await page.keyboard.press('Tab'); expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true); }
    for (let index=0; index<8; index++) { await page.keyboard.press('Shift+Tab'); expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true); }
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toContain('带到');
    if (width===390) await page.getByTestId('drawer-toggle').click();
    await page.getByRole('button', { name:'添加工作区', exact:true }).click(); const ws = page.getByRole('dialog');
    await expect.poll(() => ws.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape'); await ws.waitFor({state:'hidden'});
    expect(await page.getByRole('button',{name:'添加工作区',exact:true}).evaluate(el=>el===document.activeElement)).toBe(true);
  } finally { await browser?.close(); await ctx.close(); }
}, 50_000);
