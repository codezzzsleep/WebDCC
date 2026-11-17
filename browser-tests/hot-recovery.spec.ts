import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { SessionDetailResponse, SnapshotMessage } from '@webdcc/protocol';
import { createSourceTestApp } from './helpers.js';

it.each(['codex', 'claude-code', 'dsh'] as const)('%s source UI restores SIGKILL output through REST/WS and refresh, with observation loss and no native resend', async agent => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-browser-hot-kill-'));
  const child = fork(join(import.meta.dirname, '../packages/server/test/fixtures/hot-recovery-crash.ts'), [directory, agent], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', value => { stderr += String(value); }); let browser: Browser | undefined; let ctx: Awaited<ReturnType<typeof createSourceTestApp>> | undefined;
  try {
    const [value] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`worker exited ${code}: ${stderr}`); })]);
    const message = value as { sessionId: string; publicTurnId: string; queuedTurnId: string; rawId: number }; const exited = once(child, 'exit'); child.kill('SIGKILL'); const exit = await exited;
    ctx = await createSourceTestApp({ dbPath: join(directory, 'source.sqlite') }); await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener'); const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/sessions/${message.sessionId}`, { headers: { cookie: ctx.cookie } }); expect(response.status).toBe(200); const detail = await response.json() as SessionDetailResponse;
    expect(detail.snapshot).toHaveLength(4); expect(detail.snapshot[0]).toMatchObject({ turnId: message.publicTurnId, data: { text: 'original partial\n' }, observation: { state: 'lost' } });
    const originalRows = ctx.store.nativeEvents.list(message.sessionId, 0, 500).map(row => ctx!.store.nativeEvents.get(row.id)); const queue = ctx.store.journal.queue(message.sessionId);
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const snapshots: SnapshotMessage[] = [];
    page.on('websocket', socket => socket.on('framereceived', frame => { const event = JSON.parse(String(frame.payload)) as SnapshotMessage; if (event.op === 'snapshot' && event.sessionId === message.sessionId) snapshots.push(event); }));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]); await page.goto(`${base}/s/${message.sessionId}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await page.reload();
      await expect.poll(() => page.getByTestId('recovered-hot-item').count()).toBe(4);
      await expect.poll(() => page.getByTestId('turn-observation-lost').textContent()).toContain('原生结果待核对');
      expect(await page.getByTestId('timeline').getByText('运行中…', { exact: true }).count()).toBe(0);
      expect(await page.getByTestId('timeline').getByText('思考中…', { exact: true }).count()).toBe(0);
      expect(await page.getByTestId('timeline').locator('.spin, .shimmer').count()).toBe(0);
      expect(await page.getByTestId('recovered-hot-item').filter({ hasText: 'original partial' }).count()).toBe(1);
      expect(await page.getByTestId('recovered-hot-item').filter({ hasText: 'original native output' }).count()).toBe(1);
      expect(await page.getByTestId('recovered-hot-item').filter({ hasText: 'original reasoning' }).count()).toBe(1);
      expect(await page.getByTestId('recovered-hot-item').filter({ hasText: 'original session output' }).count()).toBe(1);
    }
    expect(snapshots.length).toBeGreaterThanOrEqual(2); expect(snapshots.every(snapshot => JSON.stringify(snapshot.items) === JSON.stringify(detail.snapshot))).toBe(true);
    expect(ctx.store.nativeEvents.list(message.sessionId, 0, 500).map(row => ctx!.store.nativeEvents.get(row.id))).toEqual(originalRows); expect(ctx.store.journal.queue(message.sessionId)).toEqual(queue);
    expect(queue).toEqual([expect.objectContaining({ turnId: message.publicTurnId, state: 'uncertain' }), expect.objectContaining({ turnId: message.queuedTurnId, state: 'queued', input: { text: 'keep queued' } })]);
    expect(ctx.manager.getRuntime(message.sessionId)).toBeUndefined(); expect(ctx.store.allEvents(message.sessionId).some(event => event.kind === 'turn.completed')).toBe(false);
    const evidence = process.env['WDCC_HOT_RECOVERY_EVIDENCE_DIR']; if (evidence !== undefined) { await writeFile(join(evidence, `${agent}.json`), JSON.stringify({ agent, exit, stderr, message, detail, snapshots, queue, originalRows }, null, 2)); await page.screenshot({ path: join(evidence, `${agent}.png`), fullPage: true }); }
    if (agent === 'claude-code') {
      const delta = originalRows.find(row => row?.channel === 'item.delta')!;
      // An actual missing stored context is an explicit recovery failure, not
      // permission to display an unverifiable prefix as a still-open item.
      const db = (await import('../packages/server/src/db.js')).openDb(join(directory, 'source.sqlite'));
      try { db.prepare('DELETE FROM app_settings WHERE key = ?').run(`native-projection-context:${delta.id}`); } finally { db.close(); }
      await page.reload(); await expect.poll(() => page.getByTestId('hot-recovery-incomplete').count()).toBe(1);
      await expect.poll(() => page.getByTestId('recovered-hot-item').count()).toBe(0);
      expect(await page.getByTestId('timeline').locator('.spin, .shimmer').count()).toBe(0);
      const unavailable = ctx.manager.hotSnapshot(message.sessionId); expect(unavailable.recovery?.coverage).toBe('partial'); expect(unavailable.items).toEqual([]);
      expect(ctx.store.journal.queue(message.sessionId)).toEqual(queue); expect(ctx.manager.getRuntime(message.sessionId)).toBeUndefined();
      if (evidence !== undefined) { await writeFile(join(evidence, 'missing-context-ui.json'), JSON.stringify(unavailable, null, 2)); await page.screenshot({ path: join(evidence, 'missing-context-ui.png'), fullPage: true }); }
    }
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await browser?.close(); await ctx?.close(); await rm(directory, { recursive: true, force: true }); }
});
