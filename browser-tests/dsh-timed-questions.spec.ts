import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { createSourceTestApp } from './helpers.js';
import { bindDshTimedPeer } from '../packages/server/test/fixtures/dsh-timed-peer.js';

const mutations = (calls: { endpoint: string; args: Record<string, unknown> }[]) => calls.filter(call => ![
  'session/projections', 'session/state', 'commands/list', 'session/modelCatalog', 'agentPresets/list', 'permissionPresets/catalog', 'skills/list',
  'pluginInventory/list', 'llm/listProviders', 'settings/describe', 'goals/get', 'schedule/list', 'schedule/catalog',
].includes(call.endpoint));

async function sourcePage(ctx: Awaited<ReturnType<typeof createSourceTestApp>>, sessionId: string, width: number) {
  await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('timed source listener missing');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width, height: 960 } });
  page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000);
  try {
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.clock.install({ time: Date.now() });
    await page.goto(`${base}/s/${sessionId}`);
    await expect.poll(() => page.getByTestId('question-card').getAttribute('data-sync')).toBe('ready');
    return { browser, page };
  } catch (error) { await browser.close(); throw error; }
}

for (const width of [1280, 390]) it(`timed question at ${width}px pauses for focus, expires while hidden and sends a native late answer once`, async () => {
  const ctx = await createSourceTestApp(); const peer = await bindDshTimedPeer(ctx); peer.ask();
  let browser: Browser | undefined;
  try {
    expect(peer.waits.size).toBe(0);
    const opened = await sourcePage(ctx, peer.session.id, width); browser = opened.browser; const page = opened.page;
    const card = page.getByTestId('question-card'); const timer = page.getByTestId('dsh-question-wait');
    await expect.poll(() => peer.waits.size).toBe(1);
    await expect.poll(() => timer.getAttribute('data-wait-state')).toBe('counting');
    await card.getByRole('textbox', { name: '其他回答' }).click();
    await expect.poll(() => card.getByRole('textbox', { name: '其他回答' }).evaluate(element => element === document.activeElement)).toBe(true);
    await expect.poll(() => timer.getAttribute('data-wait-state')).toBe('focused');
    await page.clock.runFor(20000);
    expect(mutations(peer.calls)).toHaveLength(0);
    await card.getByRole('button', { name: '收起回答', exact: true }).click();
    await expect.poll(() => timer.getAttribute('data-wait-state')).toBe('counting');
    await page.clock.runFor(6000);
    await expect.poll(() => peer.calls.filter(call => call.endpoint === '$events/result').length).toBe(1);
    expect(peer.calls.find(call => call.endpoint === '$events/result')!.args).toMatchObject({ eventId: 'timed-waterfall', clientId: 'timed-native-client', outcome: { kind: 'rejected', error: { name: 'UserQuestionError', code: 'ASK_TIMED_OUT' } } });
    expect(peer.waits.size).toBe(1); // HTTP ACK alone must not release the Host claim.
    peer.continued();
    await expect.poll(() => timer.getAttribute('data-wait-state')).toBe('continued');
    expect(await card.count()).toBe(1);
    await card.getByRole('button', { name: '展开回答', exact: true }).click();
    await card.getByRole('textbox', { name: '其他回答' }).fill('  native late answer\nsecond line  ');
    await card.getByRole('button', { name: '提交', exact: true }).click();
    await expect.poll(() => peer.calls.filter(call => call.endpoint === 'userQuestions/answer').length).toBe(1);
    expect(peer.calls.find(call => call.endpoint === 'userQuestions/answer')!.args).toEqual({ agentId: 'native-question-root', callId: 'timed-call', answer: { answers: [{ id: 'one', selected: [], custom: '  native late answer\nsecond line  ' }] } });
    await expect.poll(() => card.textContent()).toContain('已提交，等待原生结果');
    peer.answered([], '  native late answer\nsecond line  ');
    await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    await page.reload(); await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    expect(mutations(peer.calls)).toHaveLength(2);
  } finally { await browser?.close(); await peer.closePeer(); await ctx.close(); }
}, 60000);

it('first edit and an explicit indefinite hold preserve their draft and wait choice across refresh without submitting', async () => {
  const ctx = await createSourceTestApp(); const peer = await bindDshTimedPeer(ctx); peer.ask();
  let browser: Browser | undefined;
  try {
    const opened = await sourcePage(ctx, peer.session.id, 1280); browser = opened.browser; const page = opened.page;
    const card = page.getByTestId('question-card'); const timer = page.getByTestId('dsh-question-wait');
    await expect.poll(() => timer.getAttribute('data-channel')).toBe('waterfall');
    await card.getByRole('textbox', { name: '其他回答' }).fill('edited native draft');
    await expect.poll(() => timer.getAttribute('data-wait-state')).toBe('editing');
    await card.getByRole('button', { name: '收起回答', exact: true }).click();
    await page.clock.runFor(20000); expect(mutations(peer.calls)).toHaveLength(0);
    await page.reload();
    await expect.poll(() => timer.getAttribute('data-wait-state')).toBe('editing');
    expect(await card.getByRole('textbox', { name: '其他回答' }).inputValue()).toBe('edited native draft');
    await page.clock.runFor(20000); expect(mutations(peer.calls)).toHaveLength(0);
    peer.answered([], 'external answer');
    await expect.poll(() => card.getAttribute('data-state')).toBe('resolved');
    peer.ask('held-call', 'held-waterfall');
    const held = page.getByTestId('question-card').filter({ has: page.getByRole('button', { name: '多给我一些时间', exact: true }) });
    await expect.poll(() => held.count()).toBe(1);
    await held.getByRole('button', { name: '多给我一些时间', exact: true }).click();
    await page.reload();
    await expect.poll(() => page.getByTestId('dsh-question-wait').getAttribute('data-wait-state')).toBe('waiting');
    await page.clock.runFor(20000); expect(mutations(peer.calls)).toHaveLength(0);
  } finally { await browser?.close(); await peer.closePeer(); await ctx.close(); }
}, 60000);
