import { expect, test } from './fixtures.js';
import { waitTurnDone } from './helpers.js';

test.describe('7.2 Provider（续）', () => {
  test('PRV-06 表单手动新增 Provider（来源=手动，Key 不外泄）', async ({ app }) => {
    await app.login();
    await app.page.goto(`${app.run.baseURL}/settings/providers`);
    await app.page.getByTestId('provider-name').fill(`手动 Provider ${app.run.runId.slice(-4)}`);
    await app.page.getByTestId('provider-baseurl').fill('http://127.0.0.1:1/v1');
    await app.page.getByTestId('provider-key').fill(`sk-wdcc-test-manual-${app.run.runId}`);
    await app.page.getByTestId('provider-models').fill('gpt-5');
    await app.page.getByText('OpenAI Responses（Codex 用）').click();
    await app.page.getByTestId('provider-create').click();
    const row = app.page.getByTestId('provider-list').locator('tr', { hasText: `手动 Provider ${app.run.runId.slice(-4)}` });
    await expect(row).toContainText('手动');
    await expect(row).toContainText(`…${app.run.runId.slice(-4)}`);
    const raw = await app.page.evaluate(async () => (await fetch('/api/providers', { credentials: 'same-origin' })).text());
    expect(raw).not.toContain('sk-wdcc-test-manual');
  });

  test('PRV-07 给 mockr2 补 Key 后用 /v2 跑一轮', async ({ app }) => {
    await app.login();
    await app.page.goto(`${app.run.baseURL}/settings/providers`);
    await app.page.getByTestId('provider-key-edit-Mock Responses 2').click();
    const key = `sk-wdcc-test-mockr2-${app.run.runId}`;
    await app.page.getByTestId('provider-key-edit').fill(key);
    await app.page.getByTestId('provider-key-save').click();
    await expect(app.page.getByTestId('provider-list')).toContainText(`…${key.slice(-4)}`);

    await app.planFor('codex', 'full');
    await app.page.goto(`${app.run.baseURL}/new`);
    await app.page.getByTestId('agent-card-codex').click();
    await app.page.getByTestId('provider-select').selectOption({ label: 'Mock Responses 2' });
    await app.page.getByTestId('model-input').fill(app.run.slugs.a);
    await app.page.getByTestId('new-session-input').fill('mockr2 跑一轮');
    await app.page.getByTestId('new-session-send').click();
    await app.page.waitForURL(/\/s\/[0-9A-Z]+/, { timeout: 60_000 });
    await waitTurnDone(app.page);
    const requests = await app.mockResponses.requests();
    const withAuth = requests.filter((request) => (request.headers['authorization'] ?? '').includes(key));
    const v2 = requests.filter((request) => request.path.startsWith('/v2'));
    console.log(`PRV-07：请求 ${requests.length}，带补填 Key ${withAuth.length}，/v2 ${v2.length}`);
    expect(withAuth.length).toBeGreaterThan(0);
    expect(v2.length).toBeGreaterThan(0);
  });
});
