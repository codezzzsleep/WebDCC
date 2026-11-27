import { chromium, type Browser, type Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSourceTestApp } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

async function geometry(page: Page) {
  return page.getByTestId('timeline').evaluate(element => {
    const turns = [...element.querySelectorAll<HTMLElement>('.timeline-inner > [data-index]')].map(row => {
      const box = row.getBoundingClientRect();
      return { index: Number(row.dataset.index), top: box.top, bottom: box.bottom, height: box.height, transform: row.style.transform };
    }).sort((a, b) => a.index - b.index);
    return { turns, overlaps: turns.slice(1).filter((row, i) => row.top < turns[i]!.bottom - 2).map(row => row.index), scrollTop: element.scrollTop };
  });
}
it.each([1280, 420])('expanding historical execution and tool details keeps neighboring turns apart at %spx', async width => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { sessionId, workspaceId } = await seedWorkspaceAndSession(ctx, 'codex');
    for (let turn = 0; turn < 7; turn++) {
      const common = { sessionId, turnId: `layout-turn-${turn}` };
      ctx.store.appendEvent({ ...common, itemKey: `start-${turn}`, kind: 'turn.started', data: {} });
      ctx.store.appendEvent({ ...common, itemKey: `user-${turn}`, kind: 'user.message', data: { text: `历史请求 ${turn}\n\n` + (turn === 3 ? '# 文档更新\n\n' + '请保留原始文档内容，检查兼容性并处理所有要求。\n\n'.repeat(35) + '```python\n' + 'print("历史内容")\n'.repeat(20) + '```' : '请检查这个任务。'), clientCommandId: `layout-input-${turn}` } });
      for (let step = 0; step < 20; step++) {
        ctx.store.appendEvent({ ...common, itemKey: `tool-${turn}-${step}`, kind: 'tool.call', data: { name: 'subAgentActivity', status: 'completed', input: { task: `核对历史任务 ${turn}-${step}`, detail: '原生工具说明\n'.repeat(40) } } });
        ctx.store.appendEvent({ ...common, itemKey: `command-${turn}-${step}`, kind: 'command', data: { command: `/bin/bash check-${turn}-${step}`, status: 'completed', exitCode: 0, outputTail: '命令原始输出\n'.repeat(35) } });
      }
      ctx.store.appendEvent({ ...common, itemKey: `answer-${turn}`, kind: 'assistant.message', data: { text: `历史回答 ${turn}\n\n已完成核对。\n\n` + '```python\nprint("保留完整结果")\n```' } });
      ctx.store.appendEvent({ ...common, itemKey: `end-${turn}`, kind: 'turn.completed', data: { status: 'completed' } });
    }
    const events = ctx.store.allEvents(sessionId);
    const other = await ctx.manager.createSession({ workspaceId, agent: 'codex' });
    for (let turn = 0; turn < 7; turn++) {
      const common = { sessionId: other.id, turnId: `layout-turn-${turn}` };
      ctx.store.appendEvent({ ...common, itemKey: `other-user-${turn}`, kind: 'user.message', data: { text: `另一会话 ${turn}\n\n` + '独立正文\n\n'.repeat(turn === 3 ? 45 : 2), clientCommandId: `other-input-${turn}` } });
      ctx.store.appendEvent({ ...common, itemKey: `other-end-${turn}`, kind: 'turn.completed', data: { status: 'completed' } });
    }
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`); const timeline = page.getByTestId('timeline');
    await page.getByText('历史回答 6', { exact: true }).waitFor();
    await timeline.evaluate(el => { el.scrollTop = 0; });
    await page.getByText('历史请求 0', { exact: false }).first().waitFor();
    await page.waitForTimeout(300);
    const initial = await geometry(page);
    const evidence = process.env['WDCC_HISTORY_LAYOUT_EVIDENCE_DIR'];
    if (evidence !== undefined) {
      await page.screenshot({ path: join(evidence, `history-${width}-prepended.png`), fullPage: true });
      await writeFile(join(evidence, `history-${width}-prepended.json`), JSON.stringify(initial, null, 2));
    }
    expect(initial.overlaps).toEqual([]);
    for (const turn of [0, 1, 2, 3]) {
      const row = timeline.locator(`section#e-${events.find(e => e.turnId === `layout-turn-${turn}` && e.kind === 'user.message')!.seq}`);
      await row.locator('.turn-summary').click();
      await row.getByRole('button', { name: /subAgentActivity/ }).first().click();
      await row.getByRole('button', { name: /运行命令/ }).first().click();
      await page.waitForTimeout(250);
      const measured = await geometry(page);
      const evidence = process.env['WDCC_HISTORY_LAYOUT_EVIDENCE_DIR'];
      if (evidence !== undefined) {
        await page.screenshot({ path: join(evidence, `history-${width}-expanded-${turn}.png`), fullPage: true });
        await writeFile(join(evidence, `history-${width}-expanded-${turn}.json`), JSON.stringify(measured, null, 2));
      }
      expect(measured.overlaps).toEqual([]);
      await row.locator('.turn-title').click();
      await expect.poll(async () => (await geometry(page)).overlaps).toEqual([]);
      await row.locator('.turn-summary').waitFor();
    }
    await page.setViewportSize({ width: width === 1280 ? 420 : 1280, height: 1000 });
    await expect.poll(async () => (await geometry(page)).overlaps).toEqual([]);
    await page.reload();
    await page.getByText('历史回答 6', { exact: true }).waitFor();
    await timeline.evaluate(el => { el.scrollTop = 0; });
    await page.getByText('历史请求 0', { exact: false }).first().waitFor();
    await expect.poll(async () => (await geometry(page)).overlaps).toEqual([]);
    if (page.viewportSize()!.width < 1024) await page.getByTestId('drawer-toggle').click();
    await page.locator(`[data-testid="session-row"][href="/s/${other.id}"]`).click();
    await page.getByText('另一会话 6', { exact: false }).first().waitFor();
    await expect.poll(async () => (await geometry(page)).overlaps).toEqual([]);
    if (page.viewportSize()!.width < 1024) await page.getByTestId('drawer-toggle').click();
    await page.locator(`[data-testid="session-row"][href="/s/${sessionId}"]`).click();
    await page.getByText('历史回答 6', { exact: true }).waitFor();
    await expect.poll(async () => (await geometry(page)).overlaps).toEqual([]);
    expect(errors).toEqual([]); expect(ctx.store.allEvents(sessionId)).toEqual(events);
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);
