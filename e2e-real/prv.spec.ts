import { expect, test } from './fixtures.js';

test.describe('7.2 Provider', () => {
  test('PRV-01 首次打开 Provider 页即可看到本机导入的 Provider', async ({ app }) => {
    await app.login();
    await app.page.goto(`${app.run.baseURL}/settings/providers`);
    const list = app.page.getByTestId('provider-list');
    await expect(list).toContainText('Mock Responses');
    await expect(list).toContainText('Codex 配置');
    await expect(list).toContainText('Mock Responses 2');
    await expect(list).toContainText('WDCC_TEST_MOCKR2_KEY_MISSING');
    await expect(list).toContainText('Claude 设置');
  });

  test('PRV-02 重启服务后 Provider 不重复', async ({ app }) => {
    await app.login();
    await app.page.goto(`${app.run.baseURL}/settings/providers`);
    // 首次打开会触发一次扫描：先等列表稳定
    await expect(app.page.getByTestId('provider-list').locator('tbody tr').first()).toBeVisible();
    await expect.poll(async () => app.page.getByTestId('provider-list').locator('tbody tr').count()).toBeGreaterThanOrEqual(3);
    const count = await app.page.getByTestId('provider-list').locator('tbody tr').count();
    await app.page.getByTestId('provider-scan').click();
    await expect(app.page.getByTestId('scan-info')).toContainText('导入了 0 个');
    const after = await app.page.getByTestId('provider-list').locator('tbody tr').count();
    expect(after).toBe(count);
  });
});
