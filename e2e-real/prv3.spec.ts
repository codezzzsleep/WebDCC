import { expect, test } from './fixtures.js';
import { spawnServer } from './fixtures.js';

test.describe('7.2 Provider（三）', () => {
  test('PRV-08 缺模型目录时显示提示', async ({ app }) => {
    await app.login();
    const name = `无目录 Provider ${app.run.runId.slice(-4)}`;
    await app.page.evaluate(async (providerName: string) => {
      await fetch('/api/providers', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: providerName, baseUrl: 'http://127.0.0.1:1/v1', protocols: ['openai-responses'], models: ['custom-model-x'] }),
      });
    }, name);
    await app.page.goto(`${app.run.baseURL}/new`);
    await app.page.getByTestId('agent-card-codex').click();
    await app.page.getByTestId('provider-select').selectOption({ label: `无目录 Provider ${app.run.runId.slice(-4)}` });
    await expect(app.page.getByTestId('catalog-hint')).toBeVisible();
  });

  test('PRV-03 删除导入项后重扫不回来，恢复后回来', async ({ app }) => {
    await app.login();
    await app.page.goto(`${app.run.baseURL}/settings/providers`);
    const row = app.page.getByTestId('provider-list').locator('tr', { hasText: 'Mock Responses 2' });
    await row.getByRole('button', { name: '删除' }).click();
    await expect(app.page.getByTestId('provider-list')).not.toContainText('Mock Responses 2');
    await app.page.getByTestId('provider-scan').click();
    await expect(app.page.getByTestId('provider-list')).not.toContainText('Mock Responses 2');
    await app.page.getByTestId('provider-restore').click();
    await expect(app.page.getByTestId('provider-list')).toContainText('Mock Responses 2');
  });
});

test.describe('7.13 DSH 连接（续）', () => {
  test('DSHX-06 spawn 模式检测到同一 DSH_HOME 已有 DSH 时拒绝', async ({ app }) => {
    await app.login();
    const externalHome = app.run.externalDsh?.home ?? '';
    const extra = await spawnServer({ dshHome: externalHome, dshMode: 'spawn' });
    try {
      const meta = await (await fetch(`${extra.baseURL}/api/meta`, { headers: { cookie: `wdcc-auth=${(await (await fetch(`${extra.baseURL}/?token=${extra.token}`, { redirect: 'manual' })).headers.getSetCookie()[0])?.split(';')[0]?.split('=')[1] ?? ''}` } })).json() as { agents: Record<string, { installed: boolean; notes?: string[] }> };
      expect(meta.agents['dsh']?.installed).toBe(false);
      expect((meta.agents['dsh']?.notes ?? []).join(' ')).toContain('请改用 attach 模式');
    } finally {
      extra.stop();
    }
  });
});
