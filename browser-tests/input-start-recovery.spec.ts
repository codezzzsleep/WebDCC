import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../packages/server/src/db.js';
import { createSourceTestApp } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

it('a failed start remains queued in the real UI and retries the original input once after recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-start-browser-'));
  const dbPath = join(directory, 'state.db');
  const ctx = await createSourceTestApp({ dbPath }); const second = openDb(dbPath);
  let browser: Browser | undefined;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    let sends = 0; ctx.manager.adapter('codex')!.send = async () => { sends++; };
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`);
    second.exec("CREATE TRIGGER fail_start BEFORE INSERT ON events WHEN NEW.kind = 'turn.started' BEGIN SELECT RAISE(ABORT, 'controlled-start-failure'); END");
    const command = { op: 'send', clientCommandId: 'browser-original', sessionId, text: 'Original input after DB recovery' };
    const result = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    expect(result.json()).toMatchObject({ ok: false, code: 'failed' });
    const pending = page.getByTestId('user-message').filter({ hasText: command.text });
    const retry = pending.getByRole('button', { name: '重新核对附件并发送' });
    await browserExpect(retry).toBeVisible();
    expect(sends).toBe(0); expect(ctx.store.allEvents(sessionId)).toEqual([]);
    expect(ctx.manager.getRuntime(sessionId)?.turnId).toBeNull();
    const admission = ctx.store.journal.queue(sessionId)[0]!;
    const evidenceDir = process.env['WDCC_ADMISSION_EVIDENCE_DIR'];
    if (evidenceDir !== undefined) await page.screenshot({ path: join(evidenceDir, 'start-browser-blocked.png'), fullPage: true });
    second.exec('DROP TRIGGER fail_start'); await retry.click();
    await expect.poll(() => sends).toBe(1);
    await expect.poll(() => ctx.store.allEvents(sessionId).map(event => event.kind)).toEqual(['user.message', 'turn.started']);
    expect(ctx.store.journal.get(command.clientCommandId)).toMatchObject({ state: 'native-accepted', turnId: admission.turnId });
    const nativeRequestId = ctx.store.journal.nativeRequestId(admission.turnId);
    await page.reload(); await browserExpect(pending).toHaveCount(1);
    await browserExpect(pending.getByText(command.text, { exact: true })).toBeVisible();
    expect(sends).toBe(1); expect(ctx.store.journal.nativeRequestId(admission.turnId)).toBe(nativeRequestId);
    expect(errors).toEqual([]);
    if (evidenceDir !== undefined) {
      await page.screenshot({ path: join(evidenceDir, 'start-browser-recovered.png'), fullPage: true });
      await writeFile(join(evidenceDir, 'start-browser-recovery.json'), JSON.stringify({ command, admission, nativeRequestId, sends,
        events: ctx.store.allEvents(sessionId), record: ctx.store.journal.get(command.clientCommandId), pageErrors: errors }, null, 2));
    }
  } finally { await browser?.close(); second.close(); await ctx.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
