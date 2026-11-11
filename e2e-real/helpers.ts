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

/**
 * 在输入框的"模型"菜单里选择 Provider 和模型（新会话页与会话页通用）。
 * model 不传时选该 Provider 的第一个模型；Provider 没有模型列表时用 freeModel 填写。
 */
export async function chooseModel(page: Page, providerName: string, model?: string, freeModel?: string): Promise<void> {
  await page.getByTestId('model-menu').click();
  if (freeModel !== undefined) {
    const input = page.getByRole('group', { name: providerName }).getByTestId('model-input');
    await input.fill(freeModel);
    await input.press('Enter');
    return;
  }
  const selector = `[data-testid="model-option"][data-provider-name="${providerName}"]${model === undefined ? '' : `[data-model="${model}"]`}`;
  await page.locator(selector).first().click();
}

/** 输入框当前选中的 Provider 名与模型 */
export async function currentModel(page: Page): Promise<{ provider: string; model: string }> {
  const pill = page.getByTestId('model-menu');
  return { provider: (await pill.getAttribute('data-provider')) ?? '', model: (await pill.getAttribute('data-model')) ?? '' };
}

export async function agentMarkInHeader(page: Page): Promise<string> {
  return (await page.getByTestId('session-header').locator('.agent-mark').first().innerText()).trim();
}
