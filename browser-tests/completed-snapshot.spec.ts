import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AgentId, SessionDetailResponse, SnapshotMessage } from '@webdcc/protocol';
import { createSourceTestApp } from './helpers.js';

it.each(['codex', 'claude-code', 'dsh'] as const)('%s actual SIGKILL/SQLite/HTTP/WS/source UI retains original completed outputs and lost hot across refresh', async agent => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-completed-browser-'));
  const child = fork(join(import.meta.dirname, '../packages/server/test/fixtures/completed-snapshot-crash.ts'), [directory, agent], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', value => { stderr += String(value); }); let browser: Browser | undefined; let ctx: Awaited<ReturnType<typeof createSourceTestApp>> | undefined;
  try {
    const [value] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`worker exited ${code}: ${stderr}`); })]);
    const message = value as { agent: AgentId; sessions: { sessionId: string; turnId: string; queuedTurnId: string; commandId: string; kind: string; data: unknown; native: unknown; rawId: number }[] };
    const exited = once(child, 'exit'); child.kill('SIGKILL'); const exit = await exited; expect(exit[1]).toBe('SIGKILL');
    ctx = await createSourceTestApp({ dbPath: join(directory, 'source.sqlite') }); await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener'); const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const snapshots: SnapshotMessage[] = [];
    page.on('websocket', socket => socket.on('framereceived', frame => { const event = JSON.parse(String(frame.payload)) as SnapshotMessage; if (event.op === 'snapshot') snapshots.push(event); }));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]); const results = [];
    for (const source of message.sessions) {
      const rawBefore = ctx.store.nativeEvents.list(source.sessionId, 0, 500).map(row => ctx!.store.nativeEvents.get(row.id)); const eventsBefore = ctx.store.allEvents(source.sessionId); const queueBefore = ctx.store.journal.queue(source.sessionId); const ownerBefore = ctx.store.nativeOwners.get(source.sessionId);
      const response = await fetch(`${base}/api/sessions/${source.sessionId}`, { headers: { cookie: ctx.cookie } }); expect(response.status).toBe(200); const detail = await response.json() as SessionDetailResponse;
      expect(detail.completed).toHaveLength(1); const output = detail.completed![0]!;
      expect(output).toMatchObject({ sessionId: source.sessionId, turnId: source.turnId, kind: source.kind, data: source.data, native: source.native, origins: [{ id: source.rawId }] });
      expect(output.origins[0]?.nativeTurnId).toBeNull(); expect(detail.snapshot[0]).toMatchObject({ observation: { state: 'lost' }, data: { status: 'running', outputTail: 'original unfinished output' } });
      await page.goto(`${base}/s/${source.sessionId}`);
      for (let refresh = 0; refresh < 2; refresh++) {
        if (refresh > 0) await page.reload();
        await expect.poll(() => page.getByTestId('recovered-completion').count()).toBe(1);
        await expect.poll(() => page.getByTestId('recovered-hot-item').count()).toBe(1);
        await expect.poll(() => page.getByTestId('turn-observation-lost').count()).toBe(1);
        expect(await page.getByTestId('timeline').locator('.spin, .shimmer').count()).toBe(0);
        const expected = source.kind === 'assistant.message' ? 'original completed answer' : source.kind === 'command' ? 'original command output' : 'original tool output';
        expect(await page.getByTestId('recovered-completion').textContent()).toContain(expected);
        expect(await page.getByTestId('recovered-completion').getByRole('button').count()).toBe(0);
      }
      const received = snapshots.filter(snapshot => snapshot.sessionId === source.sessionId); expect(received.length).toBeGreaterThanOrEqual(2);
      expect(received.every(snapshot => JSON.stringify(snapshot.completed) === JSON.stringify(detail.completed))).toBe(true);
      expect(received.every(snapshot => snapshot.throughSeq === detail.lastSeq)).toBe(true); expect(detail.lastSeq).toBe(eventsBefore.at(-1)!.seq);
      expect(ctx.store.allEvents(source.sessionId)).toEqual(eventsBefore); expect(ctx.store.nativeEvents.list(source.sessionId, 0, 500).map(row => ctx!.store.nativeEvents.get(row.id))).toEqual(rawBefore);
      expect(ctx.store.journal.queue(source.sessionId)).toEqual(queueBefore); expect(ctx.store.nativeOwners.get(source.sessionId)).toEqual(ownerBefore); expect(ctx.manager.getRuntime(source.sessionId)).toBeUndefined();
      expect(queueBefore).toEqual([expect.objectContaining({ turnId: source.turnId, state: 'uncertain' }), expect.objectContaining({ turnId: source.queuedTurnId, state: 'queued', input: { text: 'keep queued' } })]);
      expect(eventsBefore.some(event => event.itemKey === 'target-completion' || event.kind === 'turn.completed')).toBe(false);
      results.push({ source, detail, received, rawBefore, eventsBefore, queueBefore, ownerBefore });
      const evidence = process.env['WDCC_COMPLETED_SNAPSHOT_EVIDENCE_DIR']; if (evidence !== undefined) await page.screenshot({ path: join(evidence, `${agent}-${source.kind}.png`), fullPage: true });
      if (agent === 'claude-code' && source.kind === 'assistant.message') {
        const db = (await import('../packages/server/src/db.js')).openDb(join(directory, 'source.sqlite'));
        try { db.prepare('DELETE FROM app_settings WHERE key = ?').run(`native-projection-context:${source.rawId}`); } finally { db.close(); }
        await page.reload(); await expect.poll(() => page.getByTestId('completed-recovery-incomplete').count()).toBe(1);
        await expect.poll(() => page.getByTestId('recovered-completion').count()).toBe(0);
        expect(await page.getByTestId('timeline').locator('.spin, .shimmer').count()).toBe(0);
        const unavailable = ctx.manager.hotSnapshot(source.sessionId); expect(unavailable.completedRecovery?.coverage).toBe('partial');
        expect(ctx.store.journal.queue(source.sessionId)).toEqual(queueBefore); expect(ctx.store.allEvents(source.sessionId)).toEqual(eventsBefore);
        if (evidence !== undefined) { await writeFile(join(evidence, 'missing-completion-context-ui.json'), JSON.stringify(unavailable, null, 2)); await page.screenshot({ path: join(evidence, 'missing-completion-context-ui.png'), fullPage: true }); }
      }
    }
    const evidence = process.env['WDCC_COMPLETED_SNAPSHOT_EVIDENCE_DIR']; if (evidence !== undefined) {
      await writeFile(join(evidence, `${agent}.json`), JSON.stringify({ message, exit, stderr, results, officialNativeCalls: 0, providerCalls: 0 }, null, 2));
      // A SQLite backup preserves the actual recovered database for review.
      const db = (await import('../packages/server/src/db.js')).openDb(join(directory, 'source.sqlite'));
      try { await db.backup(join(evidence, `${agent}-source.sqlite`)); } finally { db.close(); }
    }
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await browser?.close(); await ctx?.close(); await rm(directory, { recursive: true, force: true }); }
});
