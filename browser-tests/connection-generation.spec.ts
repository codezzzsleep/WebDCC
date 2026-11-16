import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSourceTestApp, observeSessionSnapshots } from './helpers.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';

it('repeated focus during real reconnect leaves one WebSocket and preserves the existing native writer', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    const owner = ctx.store.nativeOwners.get(sessionId)!;
    let resumes = 0; ctx.manager.adapter('codex')!.resume = async () => { resumes++; };
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.addInitScript(() => {
      const state = window as typeof window & { burstOnConnect: boolean; burstConnecting: boolean };
      state.burstOnConnect = false; state.burstConnecting = false;
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (state.burstOnConnect) {
            state.burstOnConnect = false;
            queueMicrotask(() => {
              state.burstConnecting = this.readyState === NativeSocket.CONNECTING;
              for (let index = 0; index < 10; index++) window.dispatchEvent(new Event('focus'));
            });
          }
        }
      };
    });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const snapshot = observeSessionSnapshots(page, sessionId);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/s/${sessionId}`); await expect.poll(snapshot).toBe(0);
    await page.evaluate(() => { (window as typeof window & { burstOnConnect: boolean }).burstOnConnect = true; });
    for (const socket of ctx.app.websocketServer.clients) socket.terminate();
    await browserExpect(page.getByText('网络断开，正在重连', { exact: false })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as typeof window & { burstConnecting: boolean }).burstConnecting)).toBe(true);
    await expect.poll(snapshot).toBe(0);
    const evidenceDir = process.env['WDCC_CONNECTION_EVIDENCE_DIR'];
    if (evidenceDir !== undefined) await writeFile(join(evidenceDir, 'connection-browser-observed.json'), JSON.stringify({ sockets: ctx.app.websocketServer.clients.size,
      ownerBefore: owner, ownerAfter: ctx.store.nativeOwners.get(sessionId), resumes, snapshot: snapshot(), connectingRaceTriggered: true, pageErrors: errors }, null, 2));
    await expect.poll(() => ctx.app.websocketServer.clients.size).toBe(1);
    expect(ctx.store.nativeOwners.get(sessionId)).toMatchObject({ ownerId: owner.ownerId, generation: owner.generation, nativeId: owner.nativeId, state: 'active' });
    expect(resumes).toBe(0); expect(errors).toEqual([]);
    if (evidenceDir !== undefined) {
      await page.screenshot({ path: join(evidenceDir, 'connection-browser-recovered.png'), fullPage: true });
      await writeFile(join(evidenceDir, 'connection-browser-final.json'), JSON.stringify({ sockets: ctx.app.websocketServer.clients.size,
        ownerBefore: owner, ownerAfter: ctx.store.nativeOwners.get(sessionId), resumes, snapshot: snapshot(), connectingRaceTriggered: true, pageErrors: errors }, null, 2));
    }
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
