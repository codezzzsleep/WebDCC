import { test, expect } from '@playwright/test';
import { createSession, login, waitForTurnComplete } from './helpers.js';

test('手动两级转交保持层级，子会话的 Watchdog 接续同级，刷新保留', async ({ page }) => {
  await login(page);
  await page.request.patch('/api/watchdog', { data: { enabled: true, baseDelaySeconds: 5, maxDelaySeconds: 20, maxAttempts: null, maxHandoffs: null } });
  const { sessionId: rootId } = await createSession(page, 'codex', '手动多级转交来源');
  await waitForTurnComplete(page);
  const original = await page.evaluate(() => [...document.querySelectorAll('[data-testid="timeline"] .assistant')].at(-1)?.textContent ?? '');
  expect(original.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: '带到…', exact: true }).first().click();
  await page.getByTestId('handoff-dialog').getByRole('button', { name: /在 Codex 中继续/ }).click();
  await page.waitForURL(/\/s\/[0-9A-Z]+\+[0-9A-Z]+/);
  const childId = /\/s\/([0-9A-Z]+)/.exec(page.url())?.[1] as string;
  const row = (id: string) => page.getByTestId('sidebar').locator(`a.session-row[href="/s/${id}"]`);
  await expect(row(rootId)).toHaveAttribute('data-depth', '0');
  await expect(row(childId)).toHaveAttribute('data-depth', '1');
  const child = await (await page.request.get(`/api/sessions/${childId}`)).json();
  expect(child).toMatchObject({ parentId: rootId, handoffKind: 'manual' });
  const childEvents = await (await page.request.get(`/api/sessions/${childId}/events`)).json();
  expect(childEvents.events.filter((event: { kind: string }) => event.kind === 'user.message')).toHaveLength(0);
  const main = page.getByTestId('main-column');
  await expect(main.getByTestId('composer-input')).toHaveValue(original);
  await main.getByTestId('composer-input').fill('完成子会话的工作');
  await main.getByTestId('send-button').click();
  await expect(main.getByText(/已完成/).first()).toBeVisible();
  await main.getByTestId('harness-pill').click();
  await main.getByTestId('continue-in-codex').click();
  await page.waitForURL(url => /\/s\/([0-9A-Z]+)/.exec(url.pathname)?.[1] !== childId);
  const grandchildId = /\/s\/([0-9A-Z]+)/.exec(page.url())?.[1] as string;
  await expect(row(grandchildId)).toHaveAttribute('data-depth', '2');
  const grandchild = await (await page.request.get(`/api/sessions/${grandchildId}`)).json();
  expect(grandchild).toMatchObject({ parentId: childId, handoffKind: 'manual' });
  // Trigger recovery in the first manual child: it must be its sibling.
  await page.goto(`/s/${childId}`);
  await page.getByTestId('composer-input').fill('[watchdog-resource] 自动修复子会话');
  await page.getByTestId('send-button').click();
  let recoveryId = '';
  await expect.poll(async () => {
    const view = await (await page.request.get('/api/watchdog')).json();
    const job = view.jobs.find((job: { sessionId: string }) => job.sessionId === childId);
    recoveryId = job?.targetSessionId ?? '';
    return job?.status;
  }, { timeout: 30_000 }).toBe('handed-off');
  await expect(row(childId)).toHaveAttribute('data-depth', '1');
  await expect(row(recoveryId)).toHaveAttribute('data-depth', '1');
  await expect(row(grandchildId)).toHaveAttribute('data-depth', '2');
  const recovery = await (await page.request.get(`/api/sessions/${recoveryId}`)).json();
  expect(recovery).toMatchObject({ parentId: childId, handoffKind: 'watchdog' });
  // Clear the source's job; the persisted origin must still keep recovery flat.
  await page.getByTestId('composer-input').fill('手动介入旧会话');
  await page.getByTestId('send-button').click();
  await expect(row(recoveryId)).toHaveAttribute('data-depth', '1');
  await page.reload();
  await expect(row(childId)).toHaveAttribute('data-depth', '1');
  await expect(row(grandchildId)).toHaveAttribute('data-depth', '2');
  await expect(row(recoveryId)).toHaveAttribute('data-depth', '1');
});
