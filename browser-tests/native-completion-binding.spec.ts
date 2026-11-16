import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import type { AdapterEvent } from '@webdcc/protocol';
import { createSourceTestApp } from './helpers.js';

it('a completion emitted before and after native binding remains one inspectable event after reload', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter = new FakeAdapter({ id: 'claude-code' }); let receive!: (id: string, event: AdapterEvent) => void;
    const original: AdapterEvent = { type: 'item.complete', itemKey: 'binding-item', kind: 'assistant.message', data: { text: 'Original binding completion' },
      native: { type: 'assistant', session_id: 'native-binding', uuid: '00000000-0000-4000-8000-000000000002', parent_tool_use_id: null,
        message: { id: 'binding-item', content: [{ type: 'text', text: 'Original binding completion' }] } } };
    adapter.onEvent = callback => { receive = callback; };
    adapter.create = async opts => { receive(opts.sessionId, { ...original, runtime: opts.runtime }); return { nativeId: 'native-binding' }; };
    ctx.manager.registerAdapter(adapter); const workspace = ctx.store.createWorkspace('binding inspector', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code' });
    receive(session.id, original);
    const events = ctx.store.allEvents(session.id); const records = ctx.store.nativeEvents.list(session.id);
    expect(events).toHaveLength(1); expect(records).toHaveLength(2); expect(records[1]!.disposition).toBe('duplicate-projection');
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const inspect = async () => {
      await page.getByRole('button', { name: String(records[1]!.id), exact: true }).click();
      await expect.poll(async () => JSON.parse(await page.getByRole('region', { name: '记录详情' }).locator('pre').innerText()) as unknown)
        .toEqual(ctx.store.nativeEvents.get(records[1]!.id));
      await page.getByRole('textbox', { name: 'Web 事件序号' }).fill('1'); await page.getByRole('button', { name: '定位事件', exact: true }).click();
      await browserExpect(page.getByRole('region', { name: 'Web 事件详情' })).toBeVisible();
      await expect.poll(() => page.getByRole('region', { name: 'Web 事件详情' }).locator('pre').innerText()).toContain('Original binding completion');
    };
    await page.goto(`${base}/settings/native-events?sessionId=${session.id}`); await inspect();
    await page.reload(); await inspect();
    const response = await page.request.get(`${base}/api/sessions/${session.id}/events?limit=200`);
    expect((await response.json() as { events: unknown }).events).toEqual(events); expect(errors).toEqual([]);
    const evidence = process.env['WDCC_BINDING_DEDUPE_EVIDENCE_DIR'];
    if (evidence !== undefined) {
      await page.screenshot({ path: join(evidence, 'binding-inspector.png'), fullPage: true });
      await writeFile(join(evidence, 'binding-inspector.json'), JSON.stringify({ source: 'controlled FakeAdapter callback/actual HTTP+Chromium',
        events, observations: records.map(row => ctx.store.nativeEvents.get(row.id)), pageErrors: errors, newOfficialNativeCalls: 0, newProviderCalls: 0 }, null, 2));
    }
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
