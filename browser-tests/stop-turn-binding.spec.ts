import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, Command, CreateOpts } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from './helpers.js';

it.each(['codex', 'claude-code', 'dsh'] as const)('%s keeps a replayed Stop tied to the round that was visible when clicked', async agent => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter = new FakeAdapter({ id: agent });
    let receive!: (sessionId: string, event: AdapterEvent) => void;
    let options!: CreateOpts;
    adapter.onEvent = listener => { receive = listener; };
    const create = adapter.create.bind(adapter);
    adapter.create = async value => { options = value; return create(value); };
    const sent: string[] = [];
    adapter.send = async (_id, input) => { sent.push(input.text); };
    const interrupted: string[] = [];
    adapter.interrupt = async sessionId => {
      interrupted.push(ctx.manager.getRuntime(sessionId)!.turnId!);
      receive(sessionId, { type: 'turn.end', status: 'interrupted', runtime: options.runtime });
    };
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('stop replay', ctx.dataDir);
    const { id } = await ctx.manager.createSession({ workspaceId: workspace.id, agent });
    const first = await ctx.manager.send(id, { text: 'First visible round' });
    const queued = await ctx.manager.send(id, { text: 'Second queued round', delivery: 'queue' });
    expect(queued.queued).toBe(true);
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    let captured: Extract<Command, { op: 'interrupt' }> | undefined;
    let hold = true;
    const stopAcks = new Map<string, { ok: boolean; error?: string }>();
    await page.routeWebSocket('**/api/ws', route => {
      const server = route.connectToServer();
      route.onMessage(message => {
        const packet = JSON.parse(String(message)) as { op: string; command?: Command };
        if (hold && packet.op === 'command' && packet.command?.op === 'interrupt') {
          captured = packet.command;
          return;
        }
        server.send(message);
      });
      server.onMessage(message => {
        const packet = JSON.parse(String(message)) as { op: string; clientCommandId?: string; result?: { ok: boolean; error?: string } };
        if (packet.op === 'ack' && packet.clientCommandId && packet.result) stopAcks.set(packet.clientCommandId, packet.result);
        route.send(message);
      });
    });

    await page.goto(`${base}/s/${id}`);
    await page.getByTestId('timeline').getByText('First visible round', { exact: true }).waitFor();
    await page.getByTestId('stop-button').click();
    await expect.poll(() => captured?.clientCommandId).toBeDefined();
    expect(interrupted).toEqual([]);
    // A completed naturally while Stop had only been committed in the browser.
    receive(id, { type: 'item.complete', kind: 'turn.completed', itemKey: 'first-end', data: { status: 'completed' }, runtime: options.runtime });
    await expect.poll(() => ctx.manager.getRuntime(id)?.turnId).toBe(queued.turnId);
    expect(sent).toEqual(['First visible round', 'Second queued round']);

    hold = false;
    await page.reload();
    await expect.poll(() => ({ ack: stopAcks.get(captured!.clientCommandId)?.ok, interrupted }), { timeout: 5_000 })
      .toEqual({ ack: false, interrupted: [] });
    expect(ctx.manager.getRuntime(id)?.turnId).toBe(queued.turnId);
    expect(captured?.expectedTurnId).toBe(first.turnId);
    await page.getByRole('alert').filter({ hasText: '要停止的轮次已结束或已切换' }).waitFor();
    await page.getByTestId('stop-button').click();
    await expect.poll(() => interrupted).toEqual([queued.turnId]);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
