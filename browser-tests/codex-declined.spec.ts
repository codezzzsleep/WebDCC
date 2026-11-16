import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, CreateOpts } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from './helpers.js';

it('native declined commands and patches stay visibly refused and never become successful edits, including legacy rows after refresh', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    let receive!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    const adapter = new FakeAdapter({ id: 'codex' }); adapter.onEvent = callback => { receive = callback; };
    const create = adapter.create.bind(adapter); adapter.create = async value => { opts = value; return create(value); };
    adapter.send = async () => undefined; ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Declined operations', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    await ctx.manager.send(session.id, { text: 'Controlled native declined operation evidence' }, 'declined-input');
    const replay = CodexAdapter.replay(session.id, session.nativeId); let seq = 0;
    const feed = (method: string, params: Record<string, unknown>) => {
      const frame = { i: ++seq, t: seq, dir: 'in' as const, ch: 'rpc', frame: { method, params: { threadId: session.nativeId, ...params } } };
      const receipt = opts.nativeEvents!.record(frame);
      for (const event of replay.feed(frame)) receive(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    };
    const command = { type: 'commandExecution', id: 'native-command', command: 'Native refused command', cwd: ctx.dataDir,
      processId: null, source: 'agent', commandActions: [], status: 'declined', aggregatedOutput: 'Rejected by the native user', exitCode: null, durationMs: null };
    const patch = { type: 'fileChange', id: 'native-patch', status: 'declined',
      changes: [{ path: 'guarded.txt', kind: { type: 'add' }, diff: 'Not applied\n' }] };
    feed('turn/started', { turn: { id: 'native-turn' } });
    feed('item/completed', { turnId: 'native-turn', item: command });
    feed('item/completed', { turnId: 'native-turn', item: patch });
    // Retain the shape of rows written by an older adapter; the original
    // native item is the evidence which can correct their successful status.
    receive(session.id, { type: 'item.complete', nativeTurnId: 'native-turn', itemKey: 'legacy-command', kind: 'command',
      data: { command: 'Legacy refused command', status: 'completed' }, native: { ...command, id: 'legacy-command' }, runtime: opts.runtime });
    receive(session.id, { type: 'item.complete', nativeTurnId: 'native-turn', itemKey: 'legacy-patch', kind: 'file.change',
      data: { status: 'completed', changes: [{ path: 'legacy-guarded.txt', kind: 'add', added: 1, removed: 0, diffFileId: 'proposed-only' }] },
      native: { ...patch, id: 'legacy-patch' }, runtime: opts.runtime });
    feed('turn/completed', { turn: { id: 'native-turn', status: 'completed' } });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(base + '/s/' + session.id);
    const check = async () => {
      const summary = page.locator('.turn-summary').first();
      const summaryText = await summary.textContent();
      expect(summaryText).not.toContain('执行了');
      expect(summaryText).not.toContain('编辑了');
      await summary.click();
      await expect.poll(() => page.getByText('命令已拒绝', { exact: true }).count()).toBe(2);
      await expect.poll(() => page.getByText('改动已拒绝', { exact: true }).count()).toBe(2);
      expect(await page.getByTestId('changes-card').count()).toBe(0);
      expect(await page.locator('.step-line .status-failed').count()).toBe(4);
      expect(await page.getByTestId('timeline').getByText('guarded.txt', { exact: true }).count()).toBe(1);
    };
    await check(); await page.reload(); await check();
    const events = ctx.store.allEvents(session.id);
    expect(events.find(event => event.itemKey === command.id)?.data).toMatchObject({ status: 'failed' });
    expect(events.find(event => event.itemKey === command.id)?.native).toEqual(command);
    expect(events.find(event => event.itemKey === patch.id)?.native).toEqual(patch);
    expect(events.find(event => event.itemKey === 'legacy-command')?.data).toMatchObject({ status: 'completed' });
    expect(errors).toEqual([]);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
