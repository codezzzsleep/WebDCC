import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';
import { createSourceTestApp } from './helpers.js';

it.each((['codex', 'claude-code', 'dsh'] as const).flatMap(agent => (['new', 'session'] as const).map(mode => ({ agent, mode }))))('$agent $mode Composer preserves an IME confirmation Enter before allowing a separate send', async ({ agent, mode }) => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { workspaceId, sessionId } = await seedWorkspaceAndSession(ctx, agent);
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(mode === 'new' ? `${base}/new?w=${workspaceId}&agent=${agent}` : `${base}/s/${sessionId}`);
    const input = page.getByTestId(mode === 'new' ? 'new-session-input' : 'composer-input');
    const text = '这段中文还在确认，不能发送'; await input.fill(text);
    for (const event of [{ keyCode: 13, isComposing: true }, { keyCode: 229, isComposing: false }, { keyCode: 229, isComposing: true }]) {
      await input.evaluate((element, init) => element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...init,
      })), event);
      // Give the real durable send path time to run; no assertion relies on
      // a synchronous snapshot taken before IndexedDB/outbox work completes.
      await page.waitForTimeout(350);
      expect(ctx.store.listSessions().flatMap(session => ctx.store.allEvents(session.id)).filter(event => event.kind === 'user.message')).toHaveLength(0);
      expect(ctx.store.listSessions()).toHaveLength(1);
      expect(await input.inputValue()).toBe(text);
      if (mode === 'new') expect(new URL(page.url()).pathname).toBe('/new');
    }
    await input.press('Shift+Enter'); expect(await input.inputValue()).toBe(text + '\n');
    expect(ctx.store.listSessions().flatMap(session => ctx.store.allEvents(session.id)).filter(event => event.kind === 'user.message')).toHaveLength(0);
    await input.press('Enter'); if (mode === 'new') await page.waitForURL('**/s/**');
    const target = mode === 'new' ? new URL(page.url()).pathname.slice(3) : sessionId;
    await expect.poll(() => ctx.store.allEvents(target).filter(event => event.kind === 'user.message').length).toBe(1);
    expect(ctx.store.allEvents(target).find(event => event.kind === 'user.message')?.data).toMatchObject({ text: text + '\n' });
  } finally { await browser?.close(); await ctx.close(); }
});
