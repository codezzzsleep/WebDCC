import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = 'e2e-token-0123456789abcdef0123456789';
const root = join(process.cwd(), 'fixtures', 'traces');
const shots = join(process.cwd(), 'docs', 'acceptance', 'M9', 'shots');
mkdirSync(shots, { recursive: true });

interface Case {
  agent: 'codex' | 'claude-code' | 'dsh';
  scenario: string;
  prompt: string;
  reference: string;
}

function cases(): Case[] {
  const result: Case[] = [];
  for (const agent of ['codex', 'claude-code', 'dsh'] as const) {
    for (const scenario of readdirSync(join(root, agent, 'default')).filter((name) => /^S\d+$/.test(name)).sort()) {
      const fixture = join(root, agent, 'default', scenario);
      const meta = JSON.parse(readFileSync(join(fixture, 'meta.json'), 'utf8')) as { prompt?: string; notTriggered?: unknown[] };
      if (meta.prompt === undefined || (meta.notTriggered?.length ?? 0) > 0) continue;
      result.push({ agent, scenario, prompt: meta.prompt, reference: readFileSync(join(fixture, 'reference', 'final.txt'), 'utf8') });
    }
  }
  return result;
}

async function login(page: Page): Promise<void> {
  await page.goto(`/?token=${TOKEN}`);
  await page.waitForURL((url) => url.pathname === '/', { timeout: 20_000 });
}

async function waitForTerminal(page: Page): Promise<void> {
  await expect.poll(async () => {
    const status = await page.locator('.turn-title').allTextContents();
    return status.some((text) => /已完成|已中断|出错/.test(text));
  }, { timeout: 90_000 }).toBe(true);
}

async function rawAnswer(page: Page): Promise<string> {
  const selector = '[data-raw-text]';
  const count = await page.locator(selector).count();
  if (count === 0) return '';
  const item = page.locator(selector).nth(count - 1);
  return (await item.getAttribute('data-raw-text')) ?? (await item.textContent()) ?? '';
}

async function timelineText(page: Page): Promise<string> {
  await page.waitForSelector('[data-testid="timeline"]', { state: 'attached', timeout: 20_000 });
  return page.evaluate(() => document.querySelector('[data-testid="timeline"]')?.textContent ?? '');
}

for (const fixture of cases()) {
  test(`${fixture.agent} ${fixture.scenario}：录像回放、刷新和第二上下文一致`, async ({ page, browser }) => {
    await login(page);
    await page.goto('/new');
    await page.getByTestId(`agent-card-${fixture.agent}`).click();
    await page.getByTestId('new-session-input').fill(fixture.prompt);
    await page.getByTestId('new-session-send').click();
    await page.waitForURL(/\/s\/[0-9A-Z]+/, { timeout: 20_000 });
    const sessionUrl = page.url();

    // Check the activity indicator throughout the stream. The reducer owns
    // the single activity value, so the DOM must never show two titles.
    for (let i = 0; i < 500; i += 1) {
      expect(await page.locator('.turn-title.running, .turn-title.waiting').count()).toBeLessThanOrEqual(1);
      const terminal = await page.locator('.turn-title').allTextContents().then((texts) => texts.some((text) => /已完成|已中断|出错/.test(text)));
      if (terminal) break;
      await page.waitForTimeout(10);
    }
    await waitForTerminal(page);

    if (fixture.scenario === 'S10') {
      await page.getByTestId('composer-input').fill('再读 README.md 的第二行。');
      await page.getByTestId('send-button').click();
      await expect.poll(() => rawAnswer(page), { timeout: 90_000 }).toBe(fixture.reference.replace(/\r\n/g, '\n'));
      await expect.poll(async () => (await page.locator('.turn-title').allTextContents()).filter((text) => /已完成|已中断|出错/.test(text)).length, { timeout: 90_000 }).toBeGreaterThanOrEqual(2);
    }
    // The final assistant item precedes turn.end in both real recordings.
    // Wait for the terminal reducer state before taking the consistency
    // snapshot, otherwise the first context can still contain live rows.
    await page.waitForTimeout(50);

    const expected = fixture.reference.replace(/\r\n/g, '\n');
    expect(await rawAnswer(page)).toBe(expected);
    const beforeRefresh = await timelineText(page);
    const stem = `${fixture.agent}-${fixture.scenario}`;
    await page.screenshot({ path: join(shots, `${stem}-collapsed.png`), fullPage: true });
    await page.getByRole('button', { name: /已完成|已中断|出错/ }).last().click();
    await page.screenshot({ path: join(shots, `${stem}-expanded.png`), fullPage: true });

    await page.reload();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await waitForTerminal(page);
    await expect.poll(() => timelineText(page), { timeout: 20_000 }).toBe(beforeRefresh);
    expect(await rawAnswer(page)).toBe(expected);

    const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const otherPage = await other.newPage();
    await login(otherPage);
    await otherPage.goto(sessionUrl);
    await expect(otherPage.getByTestId('timeline')).toBeVisible();
    await waitForTerminal(otherPage);
    await expect.poll(() => timelineText(otherPage), { timeout: 20_000 }).toBe(beforeRefresh);
    expect(await rawAnswer(otherPage)).toBe(expected);
    await other.close();
  });
}
