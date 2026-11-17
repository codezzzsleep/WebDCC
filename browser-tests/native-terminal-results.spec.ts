import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { SnapshotMessage } from '@webdcc/protocol';
import { createRequire } from 'node:module';
const Database = createRequire(new URL('../packages/server/src/db.ts', import.meta.url))('better-sqlite3') as new (path: string, options: { readonly: boolean; fileMustExist: boolean }) => { backup(path: string): Promise<unknown>; close(): void };
import { createSourceTestApp } from './helpers.js';
// Scoped browser globals keep DOM overloads out of transitive Node helpers.
type Window = { fetch: typeof fetch };
declare const window: Window;
declare function requestAnimationFrame(callback: (timestamp: number) => void): number;

it.each(['codex', 'claude-code', 'dsh'] as const)('%s displays original native terminal results after actual callback/timer SQL abort and SIGKILL without changing Web receipts', async agent => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-native-terminal-ui-'));
  const child = fork(join(import.meta.dirname, '../packages/server/test/fixtures/contextual-turn-crash.ts'), [directory, agent], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', value => { stderr += String(value); }); let browser: Browser | undefined; let ctx: Awaited<ReturnType<typeof createSourceTestApp>> | undefined;
  try {
    const [value] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`worker exited ${code}: ${stderr}`); })]);
    const message = value as { sends: number; cases: { sessionId: string; turnId: string; status: 'completed' | 'failed' | 'interrupted'; commandId: string }[] };
    const exited = once(child, 'exit'); child.kill('SIGKILL'); const exit = await exited; expect(exit[1]).toBe('SIGKILL'); expect(message.sends).toBe(3);
    ctx = await createSourceTestApp({ dbPath: join(directory, 'source.sqlite') }); await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener'); const base = `http://127.0.0.1:${address.port}`;
    const reports = []; const evidence = process.env['WDCC_NATIVE_TERMINAL_EVIDENCE_DIR'];
    if (evidence !== undefined) { const original = new Database(join(directory, 'source.sqlite'), { readonly: true, fileMustExist: true }); try { await original.backup(join(evidence, `${agent}-original-source.sqlite`)); } finally { original.close(); } }
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const snapshots: SnapshotMessage[] = [];
    page.on('websocket', socket => socket.on('framereceived', frame => { const item = JSON.parse(String(frame.payload)) as SnapshotMessage; if (item.op === 'snapshot') snapshots.push(item); }));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    for (const original of message.cases) {
      const before = { events: ctx.store.allEvents(original.sessionId), queue: ctx.store.journal.queue(original.sessionId), command: ctx.store.journal.get(original.commandId), owner: ctx.store.nativeOwners.get(original.sessionId),
        raw: ctx.store.nativeEvents.list(original.sessionId, 0, 500).map(row => ctx!.store.nativeEvents.get(row.id)) };
      const response = await fetch(`${base}/api/sessions/${original.sessionId}/native-terminal-results`, { headers: { cookie: ctx.cookie } }); const text = await response.text();
      if (evidence !== undefined) await writeFile(join(evidence, `${agent}-${original.status}-http.json`), JSON.stringify({ original, before, status: response.status, text }, null, 2));
      expect(response.status).toBe(200); const result = JSON.parse(text) as { outcomes: { publicTurnId: string; nativeTurnId: string | null; status: string }[] };
      expect(result.outcomes).toHaveLength(1); expect(result.outcomes[0]).toMatchObject({ publicTurnId: original.turnId, nativeTurnId: null, status: original.status });
      await page.goto(`${base}/s/${original.sessionId}`);
      for (let refresh = 0; refresh < 2; refresh++) {
        if (refresh > 0) await page.reload(); await expect.poll(() => page.getByTestId('native-terminal-result').count()).toBe(1);
        await expect.poll(() => snapshots.filter(item => item.sessionId === original.sessionId).length).toBeGreaterThanOrEqual(refresh + 1);
        const status = { completed: '完成', failed: '失败', interrupted: '中断' }[original.status];
        expect(await page.getByTestId('native-terminal-result').textContent()).toContain(`原生已报告${status}`);
        expect(await page.getByTestId('native-terminal-result').getByRole('button').count()).toBe(0);
      }
      const received = snapshots.filter(item => item.sessionId === original.sessionId); expect(received.length).toBeGreaterThanOrEqual(2);
      expect(received.every(item => item.throughSeq === before.events.at(-1)?.seq)).toBe(true);
      expect(ctx.store.allEvents(original.sessionId)).toEqual(before.events); expect(ctx.store.journal.queue(original.sessionId)).toEqual(before.queue); expect(ctx.store.journal.get(original.commandId)).toEqual(before.command);
      expect(ctx.store.nativeOwners.get(original.sessionId)).toEqual(before.owner); expect(ctx.store.nativeEvents.list(original.sessionId, 0, 500).map(row => ctx!.store.nativeEvents.get(row.id))).toEqual(before.raw);
      expect(ctx.manager.getRuntime(original.sessionId)).toBeUndefined(); expect(before.command?.state).toBe('uncertain'); expect(before.events.some(item => item.kind === 'turn.completed')).toBe(false);
      if (evidence !== undefined) await page.screenshot({ path: join(evidence, `${agent}-${original.status}.png`), fullPage: true }); reports.push({ original, before, result, snapshots: received });
    }
    // Controlled fetch delays an actual HTTP body and ignores Abort only for
    // this one race. It verifies the current-request fence, separately from
    // the unmodified browser/network refresh scenarios above.
    const previous = message.cases[0]!; const current = message.cases[1]!;
    await page.addInitScript(({ previousId }) => {
      const originalFetch = window.fetch.bind(window); let delayed = false;
      const fixtureWindow = window as Window & { releaseTerminalBody?: () => void; terminalBodyWaiting?: boolean; terminalBodyParsed?: boolean };
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
        if (!delayed && url.includes(`/api/sessions/${previousId}/native-terminal-results`)) {
          delayed = true; const response = await originalFetch(input, { ...init, signal: undefined });
          const originalJson = response.json.bind(response); (response as { json: () => Promise<unknown> }).json = async () => { const body = await originalJson(); fixtureWindow.terminalBodyParsed = true; return body; };
          await new Promise<void>(resolve => { fixtureWindow.releaseTerminalBody = resolve; fixtureWindow.terminalBodyWaiting = true; }); return response;
        }
        return originalFetch(input, init);
      };
    }, { previousId: previous.sessionId });
    await page.goto(`${base}/s/${previous.sessionId}`);
    await expect.poll(() => page.evaluate(() => (window as Window & { terminalBodyWaiting?: boolean }).terminalBodyWaiting)).toBe(true);
    const currentLink = page.locator(`a[href="/s/${current.sessionId}"]`).first(); await expect.poll(() => currentLink.count()).toBe(1); await currentLink.click();
    await expect.poll(() => page.getByTestId('native-terminal-result').count()).toBe(1);
    await expect.poll(() => page.getByTestId('native-terminal-result').textContent()).toContain('原生已报告失败');
    const currentOutcome = await page.getByTestId('native-terminal-result').getAttribute('data-outcome-id');
    // A fresh snapshot/native binding can retire the current GET while its
    // replacement is pending. Observe every displayed identity across the
    // delayed old response, then require the current read to settle.
    await page.evaluate(`(() => {
      window.terminalOutcomeObservations = [];
      const observe = () => window.terminalOutcomeObservations.push(Array.from(
        document.querySelectorAll('[data-testid="native-terminal-result"]'), item => item.getAttribute('data-outcome-id')));
      window.terminalOutcomeObserver = new MutationObserver(observe);
      window.terminalOutcomeObserver.observe(document.querySelector('[data-testid="timeline"]'),
        { childList: true, subtree: true, attributes: true, attributeFilter: ['data-outcome-id'] });
      observe();
    })()`);
    await page.evaluate(() => (window as Window & { releaseTerminalBody?: () => void }).releaseTerminalBody?.());
    await expect.poll(() => page.evaluate(() => (window as Window & { terminalBodyParsed?: boolean }).terminalBodyParsed)).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect.poll(() => page.getByTestId('native-terminal-result').evaluateAll(items => items.map(item => item.getAttribute('data-outcome-id')))).toEqual([currentOutcome]);
    const observedOutcomes = await page.evaluate('window.terminalOutcomeObservations') as (string | null)[][];
    expect(observedOutcomes.every(ids => ids.length === 0 || ids.length === 1 && ids[0] === currentOutcome)).toBe(true);
    await page.evaluate('window.terminalOutcomeObserver.disconnect()');
    if (evidence !== undefined) await writeFile(join(evidence, `${agent}-late-controlled-response.json`), JSON.stringify({ evidenceKind: 'controlled browser fetch ignoring Abort for one actual HTTP response; not official-native behavior', previous, current, currentOutcome, previousBodyParsed: true, currentResultRetained: true }, null, 2));
    // Missing recovery context cannot become a native success after refresh.
    const target = message.cases[2]!; const rows = ctx.store.nativeEvents.list(target.sessionId, 0, 500); const terminal = rows.find(row => row.channel === 'turn.end')!;
    const db = (await import('../packages/server/src/db.js')).openDb(join(directory, 'source.sqlite'));
    try { db.prepare('DELETE FROM app_settings WHERE key = ?').run(`native-projection-context:${terminal.id}`); } finally { db.close(); }
    await page.goto(`${base}/s/${target.sessionId}`); await expect.poll(() => page.getByTestId('native-terminal-recovery-incomplete').count()).toBe(1);
    expect(await page.getByTestId('native-terminal-result').count()).toBe(0); expect(ctx.store.journal.get(target.commandId)?.state).toBe('uncertain');
    if (evidence !== undefined) { await page.screenshot({ path: join(evidence, `${agent}-missing-context.png`), fullPage: true }); await writeFile(join(evidence, `${agent}-missing-context.json`), JSON.stringify(ctx.store.nativeTerminalResults(target.sessionId), null, 2)); }
    if (evidence !== undefined) { await writeFile(join(evidence, `${agent}.json`), JSON.stringify({ message, exit, stderr, reports, childBefore: JSON.parse(await readFile(join(directory, 'before.json'), 'utf8')), newNativeBusinessCalls: 0, providerCalls: 0 }, null, 2));
      const db = (await import('../packages/server/src/db.js')).openDb(join(directory, 'source.sqlite')); try { await db.backup(join(evidence, `${agent}-source.sqlite`)); } finally { db.close(); }
    }
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await browser?.close(); await ctx?.close(); await rm(directory, { recursive: true, force: true }); }
});
