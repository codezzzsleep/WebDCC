import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import { createTestApp, TEST_TOKEN } from '../packages/server/test/helpers.js';

/** Actual IndexedDB, browser disconnect and production FileStore boundary.
 * Dedicated controller view; product Composer integration is a separate check. */
it('restores accepted Blob/text/parts after a real browser disconnect and uploads only missing chunks', async () => {
  const webDist = await mkdtemp(join(tmpdir(), 'webdcc-input-browser-'));
  let browser: Browser | undefined;
  let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
  const fixture = Buffer.alloc(2 * 1024 * 1024 + 33);
  for (let index = 0; index < fixture.length; index++) fixture[index] = index * 31 % 251;
  const sha256 = createHash('sha256').update(fixture).digest('hex');
  try {
    await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'input-browser-fixture.ts', contents: `
      import { InputPreparationStore } from './packages/web/src/lib/input-preparation-store.ts';
      import { UploadController } from './packages/web/src/lib/upload-controller.ts';
      import { DraftController } from './packages/web/src/lib/draft-controller.ts';
      import { ComposerInputController } from './packages/web/src/lib/composer-input-controller.ts';
      const backend = new InputPreparationStore();
      const uploads = new UploadController({ store: backend });
      const drafts = new DraftController(backend);
      const composer = new ComposerInputController(drafts, uploads, () => ({ contentTypes: ['text','image','file'], inputModalities: ['text','image'], intents: ['send','queue'], running: false }));
      const received = [];
      const submit = () => composer.submit('send', async input => { received.push(input); return {commandId:'durable-fixture-command'}; });
      document.querySelector('#send').addEventListener('click', () => void submit());
      document.querySelector('#input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } });
      Object.assign(window, { preparation: { backend, uploads, drafts, composer, received, submit } });
    ` }, bundle: true, platform: 'browser', format: 'esm', outfile: join(webDist, 'fixture.js') });
    await writeFile(join(webDist, 'index.html'), '<html><body><textarea id="input"></textarea><button id="send">Send</button><script type="module" src="/fixture.js"></script></body></html>');
    ctx = await createTestApp({}, TEST_TOKEN, {}, { webDist });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (address === null || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(base);
    await page.waitForFunction(() => 'preparation' in window);
    const body = fixture.toString('base64');
    const taskId = await page.evaluate(async ({ body }) => {
      const preparation = (window as unknown as { preparation: {
        drafts: { open(id: string): Promise<unknown>; token(): { sessionId: string; generation: number }; flush(): Promise<void> };
        uploads: { create(id: string, file: File, kind: string): Promise<{ id: string }> };
        composer: { appendPart(token: unknown, part: unknown): boolean };
      } }).preparation;
      await preparation.drafts.open('A');
      const file = new File([Uint8Array.from(atob(body), char => char.charCodeAt(0))], 'proof.bin', { type: 'application/octet-stream' });
      const task = await preparation.uploads.create('A', file, 'file');
      preparation.composer.appendPart(preparation.drafts.token(), { type: 'file', uploadTaskId: task.id });
      await preparation.drafts.flush(); return task.id;
    }, { body });
    await page.evaluate(() => {
      const prep = (window as unknown as { preparation: { drafts: { update(text: string): void } } }).preparation;
      prep.drafts.update('  exact\r\n正文  ');
    });
    let disconnected = false;
    await page.route('**/chunks/1', async route => { disconnected = true; await page.context().setOffline(true); await route.abort('internetdisconnected'); });
    const failed = await page.evaluate(async id => {
      const prep = (window as unknown as { preparation: { uploads: { resume(id: string): Promise<unknown>; get(id: string): { state: string; received: number[]; blob?: Blob } } } }).preparation;
      try { await prep.uploads.resume(id); } catch { /* Explicitly retains failed upload. */ }
      const task = prep.uploads.get(id); return { state: task.state, received: task.received, blobBytes: task.blob?.size };
    }, taskId);
    expect(disconnected).toBe(true); expect(failed).toEqual({ state: 'failed', received: [0], blobBytes: fixture.length });
    await page.getByRole('button', { name: 'Send' }).click(); await page.locator('#input').press('Enter');
    expect(await page.evaluate(() => (window as unknown as { preparation: { received: unknown[] } }).preparation.received.length)).toBe(0);
    await page.context().setOffline(false); await page.unroute('**/chunks/1'); await page.reload(); await page.waitForFunction(() => 'preparation' in window);
    const restored = await page.evaluate(async id => {
      const prep = (window as unknown as { preparation: {
        drafts: { open(id: string): Promise<unknown>; snapshot(): { text: string; contentParts: unknown } };
        uploads: { restore(id: string): Promise<unknown>; get(id: string): { blob: Blob; received: number[]; sessionId: string } };
      } }).preparation;
      await prep.drafts.open('A'); await prep.uploads.restore('A'); const task = prep.uploads.get(id);
      const digest = await crypto.subtle.digest('SHA-256', await task.blob.arrayBuffer());
      return { draft: prep.drafts.snapshot(), received: task.received, sessionId: task.sessionId,
        sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
    }, taskId);
    expect(restored.draft).toMatchObject({ text: '  exact\r\n正文  ', contentParts: { version: 1, parts: [{ type: 'file', uploadTaskId: taskId }] } });
    expect(restored.received).toEqual([0]); expect(restored.sha256).toBe(sha256);
    let repeatedFirstChunk = 0;
    page.on('request', request => { if (request.url().endsWith('/chunks/0')) repeatedFirstChunk++; });
    const completed = await page.evaluate(async id => {
      const prep = (window as unknown as { preparation: { uploads: { resume(id: string): Promise<{ fileId: string }> } } }).preparation;
      return prep.uploads.resume(id);
    }, taskId);
    expect(repeatedFirstChunk).toBe(0);
    const stored = await ctx.files.readAll(completed.fileId); expect(stored?.buffer.equals(fixture)).toBe(true); expect(stored?.file.sha256).toBe(sha256);
    await page.locator('#input').press('Enter');
    await expect.poll(() => page.evaluate(() => (window as unknown as { preparation: { received: unknown[] } }).preparation.received.length)).toBe(1);
    const sent = await page.evaluate(() => (window as unknown as { preparation: { received: unknown[] } }).preparation.received[0]);
    expect(sent).toMatchObject({ sessionId: 'A', text: '  exact\r\n正文  ', contentParts: { parts: [{ type: 'text', text: '  exact\r\n正文  ' }, { type: 'file', fileId: completed.fileId }] } });
  } finally { await browser?.close(); await ctx?.close(); await rm(webDist, { recursive: true, force: true }); }
}, 30_000);
