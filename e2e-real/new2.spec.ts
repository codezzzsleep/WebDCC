import { expect, test } from './fixtures.js';
import { waitTurnDone } from './helpers.js';

test.describe('7.3 新会话（续）', () => {
  test('NEW-07 手动 Provider 的 Key 不被 settings.json 覆盖', async ({ app }) => {
    await app.login();
    const key = `sk-wdcc-test-manual-claude-${app.run.runId}`;
    const providerName = `手动 Claude Provider ${key.slice(-6)}`;
    const created = await app.page.evaluate(async ({ apiKey, baseUrl }: { apiKey: string; baseUrl: string }) => {
      const response = await fetch('/api/providers', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          baseUrl,
          protocols: ['anthropic-messages'],
          models: ['mock-claude-a'],
          apiKey,
        }),
      });
      return (await response.json()) as { id: string };
    }, { apiKey: key, baseUrl: app.run.mocks.anthClaude, name: providerName });
    expect(created.id).toBeTruthy();
    await app.planFor('claude', 'full');
    await app.page.goto(`${app.run.baseURL}/new`);
    await app.page.getByTestId('agent-card-claude-code').click();
    await app.page.getByTestId('provider-select').selectOption({ label: providerName });
    await app.page.getByTestId('new-session-input').fill('Claude 手动 Provider');
    await app.page.getByTestId('new-session-send').click();
    await app.page.waitForURL(/\/s\/[0-9A-Z]+/, { timeout: 60_000 });
    await waitTurnDone(app.page);
    const requests = await app.mockClaude.requests();
    const auth = requests.map((request) => request.headers['authorization'] ?? request.headers['x-api-key'] ?? '');
    console.log(`NEW-07：请求 ${requests.length}，授权头示例 ${JSON.stringify(auth.slice(0, 2))}`);
    expect(requests.length).toBeGreaterThan(0);
    expect(auth.every((value) => value.includes(key))).toBe(true);
  });
});
