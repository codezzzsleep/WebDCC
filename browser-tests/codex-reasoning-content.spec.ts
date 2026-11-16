import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { AdapterEvent, CreateOpts } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from './helpers.js';

it('keeps native body separate from summary, reads legacy rows and restores interrupted content after refresh', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter = new FakeAdapter({ id: 'codex' }); let emit!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    adapter.onEvent = value => { emit = value; }; const create = adapter.create.bind(adapter);
    adapter.create = async value => { opts = value; return create(value); }; adapter.send = async () => undefined;
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Native reasoning content', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    await ctx.manager.send(session.id, { text: 'Controlled reasoning source fixture' }, 'reasoning-source-fixture');
    const replay = CodexAdapter.replay(session.id, session.nativeId); let seq = 0;
    const feed = (method: string, params: Record<string, unknown>) => {
      const frame = { i: ++seq, t: seq, dir: 'in' as const, ch: 'rpc', frame: { method, params: { threadId: session.nativeId, ...params } } };
      const receipt = opts.nativeEvents!.record(frame);
      for (const event of replay.feed(frame)) emit(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    };
    feed('turn/started', { turn: { id: 'a' } });
    feed('item/started', { turnId: 'a', item: { type: 'reasoning', id: 'new', summary: ['Visible summary'], content: [] } });
    feed('item/reasoning/textDelta', { turnId: 'a', itemId: 'new', contentIndex: 0, delta: '\t原生正文 😀\n' });
    feed('item/reasoning/textDelta', { turnId: 'a', itemId: 'new', contentIndex: 2, delta: 'Third native part\n' });
    feed('turn/completed', { turn: { id: 'a', status: 'interrupted' } });
    // An existing row without the additive field reads its original native item.
    ctx.store.appendEvent({ sessionId: session.id, turnId: ctx.store.allEvents(session.id).find(event => event.itemKey === 'new')!.turnId,
      itemKey: 'legacy', kind: 'reasoning', data: { text: '' }, native: { type: 'reasoning', id: 'legacy', summary: [], content: ['Legacy native body\n'] } });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener'); const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(base + '/s/' + session.id);
    const verify = async () => {
      await page.locator('.turn-title').first().click();
      const thinking = page.getByRole('button', { name: '思考', exact: true });
      await expect.poll(() => thinking.count()).toBe(2);
      await thinking.first().click(); await thinking.last().click();
      const contents = page.getByTestId('native-reasoning-content');
      await expect.poll(() => contents.count()).toBe(2);
      await contents.first().locator('summary').click(); await contents.last().locator('summary').click();
      const parts = page.getByTestId('native-reasoning-part');
      expect(await parts.evaluateAll(elements => elements.map(element => [element.getAttribute('data-native-index'), element.getAttribute('data-raw-text')]))).toEqual([
        ['0', '\t原生正文 😀\n'], ['2', 'Third native part\n'], ['0', 'Legacy native body\n'],
      ]);
      expect(await page.locator('.turn').textContent()).toContain('Visible summary');
      expect(await page.locator('.turn').textContent()).toContain('原生正文未取得完整终稿');
    };
    await verify(); await page.reload(); await verify();
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
