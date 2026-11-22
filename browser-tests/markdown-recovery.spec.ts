import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { NativeEnvelopeDetail, SessionDetailResponse } from '@webdcc/protocol';
import { createSourceTestApp } from './helpers.js';

it.each(['codex', 'claude-code', 'dsh'] as const)('%s source UI recovers complete Markdown after SQL abort and SIGKILL while refusing masked and unknown legacy content', async agent => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-markdown-browser-'));
  const child = fork(join(import.meta.dirname, '../packages/server/test/fixtures/markdown-recovery-crash.ts'), [directory, agent],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', value => { stderr += String(value); });
  let browser: Browser | undefined; let ctx: Awaited<ReturnType<typeof createSourceTestApp>> | undefined;
  const evidence = process.env['WDCC_MARKDOWN_EVIDENCE_DIR']; const reports = [];
  try {
    const [value] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`worker exited ${code}: ${stderr}`); })]);
    const message = value as { sessions: { name: string; sessionId: string; turnId: string; commandId: string; rawId: number; available: boolean; data: { text: string }; raw: NativeEnvelopeDetail }[] };
    const exited = once(child, 'exit'); child.kill('SIGKILL'); expect((await exited)[1]).toBe('SIGKILL');
    ctx = await createSourceTestApp({ dbPath: join(directory, 'source.sqlite') });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    for (const original of message.sessions) {
      const rawBefore = ctx.store.nativeEvents.get(original.rawId); const eventsBefore = ctx.store.allEvents(original.sessionId);
      const queueBefore = ctx.store.journal.queue(original.sessionId); const commandBefore = ctx.store.journal.get(original.commandId);
      const response = await fetch(`${base}/api/sessions/${original.sessionId}`, { headers: { cookie: ctx.cookie } });
      const detail = await response.json() as SessionDetailResponse;
      reports.push({ original, rawBefore, status: response.status, detail });
      if (evidence !== undefined) await writeFile(join(evidence, `${agent}-${original.name}-http.json`), JSON.stringify(reports.at(-1), null, 2));
      expect(response.status).toBe(200); expect(rawBefore).toEqual(original.raw);
      expect(detail.completed).toHaveLength(original.available ? 1 : 0);
      if (original.available) expect(detail.completed![0]).toMatchObject({ sessionId: original.sessionId, turnId: original.turnId, data: original.data, origins: [{ id: original.rawId, payloadRedacted: false }] });
      else expect(detail.completedRecovery?.coverage).toBe('partial');
      await page.goto(`${base}/s/${original.sessionId}`);
      for (let refresh = 0; refresh < 2; refresh++) {
        if (refresh > 0) await page.reload();
        await expect.poll(() => page.getByTestId(original.available ? 'recovered-completion' : 'completed-recovery-incomplete').count()).toBe(1);
        if (original.available) {
          // The recovery card preserves the saved text in its existing output
          // view; it does not run the normal published-message renderer.
          expect(await page.getByTestId('recovered-completion').locator('pre.output').first().textContent()).toBe(original.data.text);
        } else expect(await page.getByTestId('recovered-completion').count()).toBe(0);
      }
      if (evidence !== undefined) await page.screenshot({ path: join(evidence, `${agent}-${original.name}.png`), fullPage: true });
      expect(ctx.store.allEvents(original.sessionId)).toEqual(eventsBefore);
      expect(ctx.store.nativeEvents.get(original.rawId)).toEqual(rawBefore);
      expect(ctx.store.journal.queue(original.sessionId)).toEqual(queueBefore);
      expect(ctx.store.journal.get(original.commandId)).toEqual(commandBefore);
      expect(ctx.manager.getRuntime(original.sessionId)).toBeUndefined();
    }
    expect(errors).toEqual([]);
  } finally {
    if (evidence !== undefined) await writeFile(join(evidence, `${agent}.json`), JSON.stringify({ reports, stderr,
      evidenceKind: 'controlled Adapter events, actual SQL abort/SIGKILL/HTTP/source Chromium UI; not official-native or provider acceptance',
      officialNativeBusinessCalls: 0, providerCalls: 0 }, null, 2));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await browser?.close(); await ctx?.close(); await rm(directory, { recursive: true, force: true });
  }
});
