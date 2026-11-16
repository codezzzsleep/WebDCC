import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from './helpers.js';

it('native file failures stay visible after refresh without successful edit/read summaries', async () => {
  const ctx = await createSourceTestApp();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  ctx.manager.registerAdapter(new FakeAdapter({ id: 'dsh' }));
  try {
    const workspace = ctx.store.createWorkspace('failed native file replay', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'dsh' });
    const turnId = 'failed-native-files';
    ctx.store.appendEvent({ sessionId: session.id, turnId, itemKey: 'input', kind: 'user.message', data: { text: 'read and write' } });
    ctx.store.appendEvent({ sessionId: session.id, turnId, itemKey: 'start', kind: 'turn.started', data: {} });
    ctx.store.appendEvent({ sessionId: session.id, turnId, itemKey: 'good-read', kind: 'file.read', data: { path: 'fixture.txt' } });
    ctx.store.appendEvent({ sessionId: session.id, turnId, itemKey: 'tool-missing', kind: 'file.read', data: { path: 'missing.txt' },
      native: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'missing', is_error: true, content: 'File does not exist' }] } } });
    ctx.store.appendEvent({ sessionId: session.id, turnId, itemKey: 'failed-write', kind: 'file.change',
      data: { status: 'failed', changes: [{ path: 'guarded.txt', kind: 'add', added: 1, removed: 0, diffFileId: 'not-an-applied-diff' }] },
      native: { type: 'tool/result', data: { message: { isError: true, content: [{ type: 'text', text: 'native sandbox refused this operation' }] } } } });
    ctx.store.appendEvent({ sessionId: session.id, turnId, itemKey: 'end', kind: 'turn.completed', data: { status: 'completed', durationMs: 100, answerItemKeys: [] } });
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const split = ctx.cookie.indexOf('=');
    await page.context().addCookies([{ name: ctx.cookie.slice(0, split), value: ctx.cookie.slice(split + 1), url: base }]);
    await page.goto(`${base}/s/${session.id}`);
    await page.getByText('File does not exist', { exact: true }).waitFor();
    await page.getByText('native sandbox refused this operation', { exact: true }).waitFor();
    await expect.poll(() => page.getByTestId('timeline').innerText()).toContain('读取了 1 个文件');
    expect(await page.getByTestId('changes-card').count()).toBe(0);
    expect(await page.getByTestId('timeline').innerText()).not.toContain('已编辑');
    await page.reload(); await page.getByText('File does not exist', { exact: true }).waitFor();
    expect(await page.getByTestId('changes-card').count()).toBe(0);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
