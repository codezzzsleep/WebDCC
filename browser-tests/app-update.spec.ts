import { chromium, type Browser, type Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';
import { createSourceTestApp } from './helpers.js';

const clientCommit = 'a'.repeat(40);
async function setup() {
  const ctx = await createSourceTestApp({ clientCommit });
  const seeded = await seedWorkspaceAndSession(ctx, 'codex');
  const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  return { ctx, base, ...seeded };
}
async function meta(page: Page, commit: () => string | undefined): Promise<void> {
  await page.route('**/api/meta', async route => {
    const selected = commit();
    if (selected === undefined) return route.abort('connectionreset');
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), commit: selected } });
  });
}

it.each(['delayed', 'denied', 'unregister-pending'])('recovery restores the route before router initialization when worker storage is %s', async mode => {
  const { ctx, base, sessionId } = await setup(); let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.addInitScript(mode => {
      navigator.serviceWorker.getRegistrations = async () => {
        await new Promise(resolve => setTimeout(resolve, 400));
        if (mode === 'denied') throw new DOMException('fixture denied worker storage', 'SecurityError');
        if (mode === 'unregister-pending') return [{ scope: location.origin + '/', installing: { scriptURL: location.origin + '/sw.js' },
          unregister: () => new Promise<boolean>(() => undefined) }] as unknown as readonly ServiceWorkerRegistration[];
        return [];
      };
    }, mode);
    await page.goto(base + '/api/app?to=' + encodeURIComponent(`/s/${sessionId}`));
    await expect.poll(() => page.getByTestId('composer-input').isEnabled()).toBe(true);
    expect(page.url()).toBe(`${base}/s/${sessionId}`);
    expect(await page.getByText('Unexpected Application Error!').count()).toBe(0);
  } finally { await browser?.close(); await ctx.close(); }
});

it('only a confirmed different build offers an update, with no automatic navigation', async () => {
  const { ctx, base, sessionId } = await setup(); let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    let commit: string | undefined = clientCommit; await meta(page, () => commit);
    await page.goto(`${base}/s/${sessionId}`);
    await expect.poll(() => page.getByTestId('composer-input').isEnabled()).toBe(true);
    expect(await page.getByTestId('app-update').count()).toBe(0);
    commit = undefined; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(150); expect(await page.getByTestId('app-update').count()).toBe(0);
    commit = 'b'.repeat(40); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.getByTestId('app-update').waitFor();
    expect(page.url()).toBe(`${base}/s/${sessionId}`);
  } finally { await browser?.close(); await ctx.close(); }
});

it('waits for durable writes including later typing, then restores route, text and attachments', async () => {
  const { ctx, base, sessionId } = await setup(); let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await meta(page, () => 'b'.repeat(40));
    const route = `/s/${sessionId}?preserved=yes#draft`;
    await page.goto(base + route); const input = page.getByTestId('composer-input');
    await expect.poll(() => input.isEnabled()).toBe(true);
    await page.getByTestId('add-image-input').setInputFiles({ name: 'retained.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n1sAAAAASUVORK5CYII=', 'base64') });
    await expect.poll(() => ctx.store.getDraft(sessionId).fileIds.length).toBe(1);
    await page.evaluate(async () => {
      localStorage.setItem('unrelated-retained', 'yes');
      const open = indexedDB.open('webdcc-input-preparation-v1');
      const db = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
      const state = window as Window & { releaseDraftWrite?: () => void };
      let locked = true; state.releaseDraftWrite = () => { locked = false; };
      const tx = db.transaction('drafts', 'readwrite'); tx.oncomplete = () => db.close();
      const keepAlive = (): void => { const request = tx.objectStore('drafts').get('fixture-lock'); request.onsuccess = () => { if (locked) keepAlive(); }; }; keepAlive();
    });
    await input.fill('更新前的草稿');
    let recoveries = 0; page.on('request', request => { if (new URL(request.url()).pathname === '/api/app') recoveries++; });
    await page.getByRole('button', { name: '保存草稿并更新', exact: true }).click();
    await page.getByRole('button', { name: '正在保存草稿…', exact: true }).waitFor();
    await input.fill('更新前的草稿，保存中继续输入');
    expect(recoveries).toBe(0);
    await page.evaluate(() => (window as Window & { releaseDraftWrite: () => void }).releaseDraftWrite());
    await expect.poll(() => recoveries).toBe(1);
    await expect.poll(() => input.inputValue()).toBe('更新前的草稿，保存中继续输入');
    await expect.poll(() => page.getByTestId('composer-attachments').getByRole('img', { name: 'retained.png' }).count()).toBe(1);
    expect(page.url()).toBe(base + route);
    expect(await page.evaluate(() => localStorage.getItem('unrelated-retained'))).toBe('yes');
    expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'user.message')).toHaveLength(0);
  } finally { await browser?.close(); await ctx.close(); }
});

it('retains the page during attachment preparation or failed draft persistence', async () => {
  const { ctx, base, sessionId } = await setup(); let browser: Browser | undefined;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await meta(page, () => 'b'.repeat(40));
    await page.route('**/api/workspaces/*/attach', async route => { await gate; await route.continue(); });
    await page.goto(`${base}/s/${sessionId}`); const input = page.getByTestId('composer-input');
    await expect.poll(() => input.isEnabled()).toBe(true); await input.fill('保留正文');
    const copying = page.waitForRequest('**/api/workspaces/*/attach');
    await page.getByTestId('add-file-input').setInputFiles({ name: 'Model-Agent-RAG-参赛推文.md', mimeType: 'text/markdown', buffer: Buffer.from('# retained') });
    await copying;
    await page.getByRole('button', { name: '保存草稿并更新', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '附件或消息正在处理' }).waitFor();
    expect(page.url()).toBe(`${base}/s/${sessionId}`); release();
    await expect.poll(() => input.inputValue()).toContain('.webdcc/uploads/');
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
        if (this.name === 'drafts') throw new DOMException('fixture draft disk failure', 'QuotaExceededError');
        return original.apply(this, args);
      };
    });
    await input.fill('保存失败也保留正文');
    await page.getByRole('button', { name: '保存草稿并更新', exact: true }).click();
    await page.getByTestId('app-update').getByRole('alert').filter({ hasText: 'fixture draft disk failure' }).waitFor();
    expect(await input.inputValue()).toBe('保存失败也保留正文');
    expect(page.url()).toBe(`${base}/s/${sessionId}`);
  } finally { release(); await browser?.close(); await ctx.close(); }
});
