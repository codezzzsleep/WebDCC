import { expect, test } from './fixtures.js';
import { chooseModel, currentModel, waitTurnDone } from './helpers.js';

test.describe('7.3 新会话', () => {
  test('NEW-02 默认 Provider 与模型传给 Agent', async ({ app }) => {
    await app.login();
    await app.planFor('codex', 'full');
    await app.page.goto(`${app.run.baseURL}/new`);
    await app.page.getByTestId('agent-card-codex').click();
    await expect.poll(async () => (await currentModel(app.page)).provider, { timeout: 20_000 }).not.toBe('');
    const selected = await currentModel(app.page);
    expect(selected.provider).toContain('Mock Responses');
    expect(selected.model).toBe(app.run.slugs.a);
    await app.page.getByTestId('new-session-input').fill('默认模型');
    await app.page.getByTestId('new-session-send').click();
    await app.page.waitForURL(/\/s\/[0-9A-Z]+/, { timeout: 60_000 });
    await waitTurnDone(app.page);
    const mock = await app.mockResponses.requests();
    const models = mock.map((request) => (request.body as { model?: string } | undefined)?.model).filter((model): model is string => model !== undefined);
    expect(models.every((model) => model === app.run.slugs.a), `mock 收到的模型：${models.join(',')}`).toBe(true);
    const sessionId = /\/s\/([0-9A-Z]+)/.exec(app.page.url())?.[1] ?? '';
    const session = await app.page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}`, { credentials: 'same-origin' })).json()) as { model?: string }, sessionId);
    expect(session.model).toBe(app.run.slugs.a);
  });

  test('NEW-03 只有一个模型的 Provider 直接发送也能带上模型', async ({ app }) => {
    await app.login();
    const created = await app.page.evaluate(async () => {
      const response = await fetch('/api/providers', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '单模型 Provider', baseUrl: 'http://127.0.0.1:1/v1', protocols: ['openai-responses'], models: ['gpt-5'], apiKey: 'sk-wdcc-test-single' }),
      });
      return (await response.json()) as { id: string };
    });
    expect(created.id).toBeTruthy();
    await app.planFor('codex', 'full');
    await app.page.goto(`${app.run.baseURL}/new`);
    await app.page.getByTestId('agent-card-codex').click();
    await chooseModel(app.page, '单模型 Provider');
    await expect.poll(async () => (await currentModel(app.page)).model).toBe('gpt-5');
    await app.page.getByTestId('new-session-input').fill('单模型');
    await app.page.getByTestId('new-session-send').click();
    await app.page.waitForURL(/\/s\/[0-9A-Z]+/, { timeout: 60_000 });
    const sessionId = /\/s\/([0-9A-Z]+)/.exec(app.page.url())?.[1] ?? '';
    const session = await app.page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}`, { credentials: 'same-origin' })).json()) as { model?: string }, sessionId);
    expect(session.model).toBe('gpt-5');
  });
});
