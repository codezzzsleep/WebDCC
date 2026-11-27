import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

it.each([390, 1280])('reads the full end of plain, highlighted and unsupported-language code inside its own scroll container at %spx', async width => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'claude-code');
    const line = 'original-' + '0123456789'.repeat(24) + '-VISIBLE-END';
    const text = ['行内 `original-inline` 保持行内。', ...['', 'bash', 'unsupported-native-format'].map(lang => `\`\`\`${lang}\n${line}\n第二行原文\n\`\`\``)].join('\n\n');
    ctx.store.appendEvent({ sessionId, turnId: 'read-old-answer', itemKey: 'answer', kind: 'assistant.message', data: { text } });
    ctx.store.appendEvent({ sessionId, turnId: 'read-old-answer', itemKey: 'done', kind: 'turn.completed', data: { status: 'completed' } });
    const before = ctx.store.allEvents(sessionId); const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`); await page.locator('.markdown pre').first().waitFor();
    expect(await page.locator('.markdown pre').count()).toBe(3);
    expect(await page.locator('.markdown pre pre').count()).toBe(0);
    expect(await page.locator('.markdown pre .inline-code').count()).toBe(0);
    expect(await page.locator('.markdown p > .inline-code').innerText()).toBe('original-inline');
    for (let index = 0; index < 3; index++) {
      const code = page.locator('.markdown pre').nth(index);
      await code.hover();
      await expect.poll(() => code.evaluate(el => getComputedStyle(el).overflowX)).toBe('auto');
      expect(await code.textContent()).toContain(line);
      expect(await code.getAttribute('tabindex')).toBe('0');
      await code.focus(); await page.keyboard.press('ArrowRight');
      await expect.poll(() => code.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
      await page.waitForTimeout(250);
      await code.hover();
      await page.mouse.wheel(1000, 0);
      await page.waitForTimeout(200);
      await page.mouse.wheel(1000, 0);
      await page.waitForTimeout(200);
      await page.mouse.wheel(1000, 0);
      await expect.poll(() => code.evaluate(el => el.scrollLeft + el.clientWidth >= el.scrollWidth - 2)).toBe(true);
      expect(await code.evaluate(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node: Node | null;
        while ((node = walker.nextNode())) { const offset = node.textContent?.indexOf('VISIBLE-END') ?? -1;
          if (offset >= 0) { const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 11);
            const end = range.getBoundingClientRect(), box = el.getBoundingClientRect(); return end.left >= box.left && end.right <= box.right; }
        }
        return false;
      })).toBe(true);
    }
    expect(await page.getByTestId('timeline').evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollLeft === 0)).toBe(true);
    await page.reload(); await page.locator('.markdown pre').first().waitFor();
    expect(await page.locator('.markdown pre').first().textContent()).toBe(line + '\n第二行原文');
    expect(ctx.store.allEvents(sessionId)).toEqual(before);
  } finally { await browser?.close(); await ctx.close(); }
}, 40_000);

it.each([390, 1280])('shows a readable native failure while preserving exact expandable diagnostics and plain errors at %spx', async width => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    const raw = '{"message":"Reconnecting... 1/5","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":null}},"additionalDetails":"stream disconnected before completion: The service is temporarily unavailable. Please retry later.","misalignment":null}';
    const unknown = '{"nativeUnknown":{"code":709,"detail":"原生字段"}}';
    for (const [index, message] of [raw, unknown, '原样普通错误', '{invalid-json'].entries()) ctx.store.appendEvent({ sessionId, turnId: 'old-failure', itemKey: `error-${index}`, kind: 'error', data: { message } });
    ctx.store.appendEvent({ sessionId, turnId: 'old-failure', itemKey: 'done', kind: 'turn.completed', data: { status: 'interrupted' } });
    const before = ctx.store.allEvents(sessionId), base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`); const cards = page.getByTestId('error-card'); await cards.first().waitFor();
    const first = cards.first(); expect(await first.innerText()).toContain('模型响应连接中断（原生曾尝试重连 1/5）');
    expect(await first.innerText()).not.toContain('codexErrorInfo'); expect(await first.locator('pre').isVisible()).toBe(false);
    await first.locator('summary').focus(); await page.keyboard.press('Enter');
    expect(await first.locator('pre').isVisible()).toBe(true); expect(await first.locator('pre').textContent()).toBe(raw);
    await page.keyboard.press('Enter'); expect(await first.locator('pre').isVisible()).toBe(false);
    const second = cards.nth(1); expect(await second.innerText()).toContain('Agent 返回错误');
    await second.locator('summary').click(); expect(await second.locator('pre').textContent()).toBe(unknown);
    expect(await cards.nth(2).innerText()).toBe('原样普通错误'); expect(await cards.nth(3).innerText()).toBe('{invalid-json');
    expect(await page.getByTestId('timeline').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.reload(); await cards.first().waitFor(); expect(await cards.first().locator('pre').isVisible()).toBe(false);
    expect(ctx.store.allEvents(sessionId)).toEqual(before);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
