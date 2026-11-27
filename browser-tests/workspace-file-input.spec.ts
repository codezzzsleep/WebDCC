import { chromium, type Browser, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';
import type { EventData } from '@webdcc/protocol';
import { encodeCodexInput } from '../packages/adapters/codex/src/input.js';
import { createSourceTestApp } from './helpers.js';

const filename = 'Model-Agent-RAG-参赛推文.md';
const bytes = Buffer.from('\uFEFF# 参赛材料\r\n独立标记 FILE-413-ORIGINAL\r\n');
async function open(ctx: Awaited<ReturnType<typeof createSourceTestApp>>, browser: Browser) {
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw Error('Missing listener');
  const base = `http://127.0.0.1:${address.port}`;
  const page = await browser.newPage();
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
  return { page, base };
}
async function drop(page: Page, selector = '[data-testid="composer-input"]') {
  await page.locator(selector).evaluate((target, data) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(data)], 'Model-Agent-RAG-参赛推文.md', { type: 'text/markdown' }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, [...bytes]);
}

it.each(['new', 'session', 'claude'] as const)('%s prepares an uploaded Markdown file for native workspace reading', async mode => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const agent = mode === 'claude' ? 'claude-code' : 'codex';
    const adapter = new FakeAdapter({ id: agent });
    if (agent === 'codex') Object.assign(adapter, { validateInput: async (_id: string, input: Parameters<typeof encodeCodexInput>[0]) => { await encodeCodexInput(input); } });
    ctx.manager.registerAdapter(adapter);
    const seeded = await seedWorkspaceAndSession(ctx, agent);
    browser = await chromium.launch({ headless: true }); const { page, base } = await open(ctx, browser);
    await page.goto(mode === 'new' ? `${base}/new?w=${seeded.workspaceId}&agent=codex` : `${base}/s/${seeded.sessionId}`);
    const inputId = mode === 'new' ? 'new-session-input' : 'composer-input'; const sendId = mode === 'new' ? 'new-session-send' : 'send-button';
    await page.getByTestId(inputId).fill('  请读取这个文件\n原始正文  ');
    if (mode === 'session') await drop(page);
    else await page.getByTestId('add-file-input').setInputFiles({ name: filename, mimeType: 'text/markdown', buffer: bytes });
    const body = '  请读取这个文件\n原始正文  ';
    if (agent === 'claude-code') {
      const reference = page.getByRole('button', { name: '放入工作区并引用', exact: true });
      await expect.poll(() => reference.isEnabled()).toBe(true);
      await page.reload(); await expect.poll(() => reference.isEnabled()).toBe(true);
      expect(await page.getByTestId(inputId).inputValue()).toBe(body);
      await reference.click();
    }
    await expect.poll(() => page.getByTestId(inputId).inputValue()).toContain('.webdcc/uploads/');
    const text = await page.getByTestId(inputId).inputValue();
    expect(text.startsWith(body + '\n')).toBe(true);
    const path = JSON.parse(text.slice(body.length + 1)) as string;
    expect(path.endsWith(filename)).toBe(true);
    const copied = await readFile(join(ctx.store.getWorkspace(seeded.workspaceId)!.path, path));
    expect(copied.equals(bytes)).toBe(true);
    expect(createHash('sha256').update(copied).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await page.getByTestId('composer-attachments').count()).toBe(0);
    await page.reload(); await expect.poll(() => page.getByTestId(inputId).inputValue()).toBe(text);
    await page.getByTestId(sendId).click(); if (mode === 'new') await page.waitForURL('**/s/**');
    const sid = mode === 'new' ? page.url().split('/s/')[1]!.split('?')[0]! : seeded.sessionId;
    await expect.poll(() => ctx.store.allEvents(sid).filter(e => e.kind === 'user.message').length).toBe(1);
    const sent = ctx.store.allEvents(sid).find(e => e.kind === 'user.message')!.data as EventData['user.message'];
    expect(sent.text).toBe(text);
    expect(sent.contentParts?.parts).toEqual([{ type: 'text', text }]);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it('failed copy keeps the file and latest text, and a late successful copy cannot fill another session', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const a = await seedWorkspaceAndSession(ctx, 'codex');
    const b = await ctx.manager.createSession({ workspaceId: a.workspaceId, agent: 'codex' });
    browser = await chromium.launch({ headless: true }); const { page, base } = await open(ctx, browser);
    let attempts = 0;
    await page.route('**/api/workspaces/*/attach', route => { attempts++; return route.fulfill({ status: 500, json: { error: 'copy failed' } }); });
    await page.goto(`${base}/s/${a.sessionId}`); await page.getByTestId('composer-input').fill('A body'); await drop(page);
    const button = page.getByRole('button', { name: '重试文件准备', exact: true });
    await page.getByRole('alert').filter({ hasText: 'copy failed' }).waitFor();
    await expect.poll(() => button.isEnabled()).toBe(true);
    expect(await page.getByTestId('composer-input').inputValue()).toBe('A body');
    expect(await page.getByTestId('composer-attachments').locator('.attachment-chip').count()).toBe(1);
    await page.getByTestId('composer-input').fill('A edited body');
    await page.getByTestId('composer-input').press('Enter');
    expect(attempts).toBe(1);
    expect(ctx.store.allEvents(a.sessionId).filter(event => event.kind === 'user.message')).toHaveLength(0);
    await page.unroute('**/api/workspaces/*/attach');
    let finish!: () => void; let began!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; }); const started = new Promise<void>(resolve => { began = resolve; });
    await page.route('**/api/workspaces/*/attach', async route => { const response = await route.fetch(); began(); await gate; await route.fulfill({ response }); });
    await button.click(); await started;
    await page.locator(`[data-testid="session-row"][href="/s/${b.id}"]`).click();
    await page.getByTestId('composer-input').fill('B body'); finish();
    await expect.poll(() => page.getByTestId('attach-button').isEnabled()).toBe(true);
    expect(await page.getByTestId('composer-input').inputValue()).toBe('B body');
    await page.locator(`[data-testid="session-row"][href="/s/${a.sessionId}"]`).click();
    await expect.poll(() => page.getByTestId('composer-input').inputValue()).toContain('.webdcc/uploads/');
    expect((await page.getByTestId('composer-input').inputValue()).startsWith('A edited body\n')).toBe(true);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it('automatically prepares a batch serially, blocks Enter while copying and retains concurrent edits', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { sessionId, workspaceId } = await seedWorkspaceAndSession(ctx, 'codex');
    browser = await chromium.launch({ headless: true }); const { page, base } = await open(ctx, browser);
    let finish!: () => void; let started!: () => void; let active = 0; let maximum = 0;
    const gate = new Promise<void>(resolve => { finish = resolve; }); const began = new Promise<void>(resolve => { started = resolve; });
    let first = true;
    await page.route('**/api/workspaces/*/attach', async route => {
      active++; maximum = Math.max(maximum, active);
      if (first) { first = false; started(); await gate; }
      await route.continue(); active--;
    });
    await page.goto(`${base}/s/${sessionId}`); await page.getByTestId('composer-input').fill('original');
    await page.getByTestId('add-file-input').setInputFiles([
      { name: filename, mimeType: 'text/markdown', buffer: bytes },
      { name: 'second.md', mimeType: 'text/markdown', buffer: Buffer.from('second exact bytes') },
    ]);
    await began;
    expect(await page.getByTestId('send-button').isDisabled()).toBe(true);
    await page.getByTestId('composer-input').press('Enter');
    expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'user.message')).toHaveLength(0);
    await page.getByTestId('composer-input').fill('edited during preparation'); finish();
    await expect.poll(() => page.getByTestId('composer-attachments').count()).toBe(0);
    const text = await page.getByTestId('composer-input').inputValue();
    const paths = text.split('\n').slice(1).map(line => JSON.parse(line) as string);
    expect(paths).toHaveLength(2); expect(maximum).toBe(1);
    expect(text.startsWith('edited during preparation\n')).toBe(true);
    expect((await readFile(join(ctx.store.getWorkspace(workspaceId)!.path, paths[0]!))).equals(bytes)).toBe(true);
    expect(await readFile(join(ctx.store.getWorkspace(workspaceId)!.path, paths[1]!), 'utf8')).toBe('second exact bytes');
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it('refresh resumes automatic preparation from a completed upload without uploading it again', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    browser = await chromium.launch({ headless: true }); const { page, base } = await open(ctx, browser);
    let uploads = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/uploads')) uploads++; });
    await page.route('**/api/workspaces/*/attach', route => route.fulfill({ status: 503, json: { error: 'temporarily unavailable' } }));
    await page.goto(`${base}/s/${sessionId}`); await page.getByTestId('composer-input').fill('read restored file'); await drop(page);
    await page.getByRole('alert').filter({ hasText: 'temporarily unavailable' }).waitFor();
    await expect.poll(() => ctx.store.getDraft(sessionId).fileIds.length).toBe(1);
    expect(uploads).toBe(1);
    await page.unroute('**/api/workspaces/*/attach'); await page.reload();
    await expect.poll(() => page.getByTestId('composer-input').inputValue()).toContain('.webdcc/uploads/');
    expect(uploads).toBe(1);
    expect((await page.getByTestId('composer-input').inputValue()).startsWith('read restored file\n')).toBe(true);
    expect(await page.getByTestId('composer-attachments').count()).toBe(0);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
