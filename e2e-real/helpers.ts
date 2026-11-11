import type { Page } from '@playwright/test';
import { expect } from './fixtures.js';

export type AgentKey = 'dsh' | 'codex' | 'claude';

export const AGENT_CARD: Record<AgentKey, string> = { dsh: 'dsh', codex: 'codex', claude: 'claude-code' };
export const AGENT_MARK: Record<AgentKey, string> = { dsh: 'DS', codex: 'CX', claude: 'CC' };

/** 新建会话并发送一条消息，返回会话 id */
export async function newSession(page: Page, agent: AgentKey, text: string): Promise<string> {
  await page.goto(`${page.url().split('/').slice(0, 3).join('/')}/new`);
  await page.getByTestId(`agent-card-${AGENT_CARD[agent]}`).click();
  await page.getByTestId('new-session-input').fill(text);
  await page.getByTestId('new-session-send').click();
  await page.waitForURL(/\/s\/[0-9A-Z]+/, { timeout: 60_000 });
  const match = /\/s\/([0-9A-Z]+)/.exec(page.url());
  if (match?.[1] === undefined) throw new Error(`没有跳到会话页：${page.url()}`);
  return match[1];
}

export async function waitTurnDone(page: Page): Promise<void> {
  // 等这一轮真正结束：停止按钮消失，并且时间线出现"已完成/已中断"
  await expect.poll(async () => page.getByTestId('stop-button').count(), { timeout: 150_000 }).toBe(0);
  await expect.poll(async () => page.getByTestId('timeline').innerText(), { timeout: 60_000 }).toMatch(/已完成|已中断/);
}

export async function agentMarkInHeader(page: Page): Promise<string> {
  return (await page.getByTestId('session-header').locator('.agent-mark').first().innerText()).trim();
}
