import { expect, type Page } from '@playwright/test';

export const TOKEN = 'e2e-token-0123456789abcdef0123456789';

/** 带 token 打开一次，拿到 Cookie */
export async function login(page: Page): Promise<void> {
  await page.goto(`/?token=${TOKEN}`);
  await page.waitForURL((url) => url.pathname === '/', { timeout: 20_000 });
}

export interface CreatedSession {
  sessionId: string;
  url: string;
}

/** 通过 UI 新建一个会话并发出第一条消息 */
export async function createSession(page: Page, agent: 'dsh' | 'codex' | 'claude-code', text = '你好'): Promise<CreatedSession> {
  await page.goto('/new');
  await page.getByTestId(`agent-card-${agent}`).click();
  await page.getByTestId('new-session-input').fill(text);
  await page.getByTestId('new-session-send').click();
  await page.waitForURL(/\/s\/[0-9A-Z]+/, { timeout: 20_000 });
  const url = page.url();
  const match = /\/s\/([0-9A-Z]+)/.exec(url);
  if (match?.[1] === undefined) throw new Error(`没有跳到会话页：${url}`);
  return { sessionId: match[1], url };
}

export async function waitForTurnComplete(page: Page): Promise<void> {
  await expect(page.getByText(/已完成/).first()).toBeVisible({ timeout: 60_000 });
}
