import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
    if (width===390) await page.getByTestId('drawer-backdrop').click({position:{x:width-10,y:60}});
    await page.getByTestId('composer-input').fill('/'); await page.getByTestId('slash-menu').waitFor();
    await page.getByTestId('access-mode').click(); await page.getByTestId('slash-menu').waitFor({state:'hidden'});
    expect(await page.getByTestId('composer').getByRole('menu').count()).toBe(1);
    await page.getByRole('menuitemradio').first().click();
    await page.getByTestId('composer-input').fill('@'); await page.getByTestId('at-menu').waitFor();
    await page.getByTestId('model-menu').click(); await page.getByTestId('at-menu').waitFor({state:'hidden'});
    expect(await page.getByTestId('composer').getByRole('menu').count()).toBe(1);
    await page.keyboard.press('Escape'); expect(await page.getByTestId('composer-input').inputValue()).toBe('@');
  } finally { await browser?.close(); await ctx.close(); }
}, 50_000);

it('only adds the last loaded directory and ignores an older browse response', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const a = join(ctx.dataDir, 'directory-a'), b = join(ctx.dataDir, 'directory-b'); await mkdir(a); await mkdir(b);
    const base = await ctx.app.listen({host:'127.0.0.1', port:0}); browser = await chromium.launch({headless:true}); const page = await browser.newPage();
    await page.context().addCookies([{name:'wdcc-auth', value:ctx.cookie.slice('wdcc-auth='.length), url:base}]); await page.goto(base);
    await page.getByRole('button',{name:'添加工作区',exact:true}).click();
    await expect.poll(()=>page.getByTestId('workspace-directory-state').innerText()).toContain('当前目录');
    let release = (): void => {}; const held = new Promise<void>(resolve=>{release=resolve;});
    let seen = (): void => {}; const fetched = new Promise<void>(resolve=>{seen=resolve;});
    await page.route('**/api/fs/browse?*',async route=>{const response=await route.fetch(); if(new URL(route.request().url()).searchParams.get('path')===a){seen(); await held;} await route.fulfill({response});});
    const path = page.getByRole('textbox',{name:'目录路径',exact:true}), dialog=page.getByRole('dialog');
    await path.fill(a); expect(await dialog.getByRole('button',{name:'添加这个目录',exact:true}).isDisabled()).toBe(true);
    await dialog.getByRole('button',{name:'打开',exact:true}).click(); await fetched;
    expect(await dialog.getByRole('button',{name:'新建文件夹',exact:true}).isDisabled()).toBe(true);
    await path.fill(b); await dialog.getByRole('button',{name:'打开',exact:true}).click();
    await expect.poll(()=>page.getByTestId('workspace-directory-state').innerText()).toContain(b); release();
    await page.waitForTimeout(100); expect(await path.inputValue()).toBe(b);
    await dialog.getByRole('button',{name:'添加这个目录',exact:true}).click(); await dialog.waitFor({state:'hidden'});
    expect(ctx.store.listWorkspaces().some(workspace=>workspace.path===b)).toBe(true);
    expect(ctx.store.listWorkspaces().some(workspace=>workspace.path===a)).toBe(false);
  } finally {await browser?.close(); await ctx.close();}
}, 30_000);
