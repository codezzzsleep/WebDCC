import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';
import type { AgentAdapter, EventData } from '@webdcc/protocol';
import { createSourceTestApp } from './helpers.js';
import { encodeClaudeInput } from '../packages/adapters/claude/src/input.js';
import { encodeCodexInput } from '../packages/adapters/codex/src/input.js';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n1sAAAAASUVORK5CYII=', 'base64');

async function transferFiles(page: Page, selector: string, kind: 'drop' | 'paste', files: { name: string; mime: string; bytes: number[] }[]): Promise<boolean> {
  return page.locator(selector).evaluate((target, { kind, files }) => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.mime }));
    if (kind === 'drop') target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const event = kind === 'drop' ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
      : new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
    target.dispatchEvent(event); return event.defaultPrevented;
  }, { kind, files });
}

it.each(['new', 'session'] as const)('%s Composer drops images and files through durable upload with original bytes and text', async kind => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    ctx.manager.registerAdapter(declaredAdapter());
    const { sessionId, workspaceId } = await seedWorkspaceAndSession(ctx);
    browser = await chromium.launch({ headless: true }); const { page, base } = await listener(ctx, browser);
    await page.goto(kind === 'new' ? `${base}/new?w=${workspaceId}&agent=dsh` : `${base}/s/${sessionId}`);
    const input = page.getByTestId(kind === 'new' ? 'new-session-input' : 'composer-input');
    await input.fill('  original\n正文  '); const body = await input.inputValue();
    const fileBytes = Buffer.from('original\r\nfile bytes');
    expect(await transferFiles(page, `[data-testid="${kind === 'new' ? 'new-session-input' : 'composer-input'}"]`, 'drop', [
      { name: 'dropped.png', mime: 'image/png', bytes: [...pixel] },
      { name: 'dropped.txt', mime: 'text/plain', bytes: [...fileBytes] },
    ])).toBe(true);
    const send = page.getByTestId(kind === 'new' ? 'new-session-send' : 'send-button');
    await expect.poll(() => page.getByTestId('composer-attachments').locator('.attachment-chip').count()).toBe(2);
    await expect.poll(() => send.isEnabled()).toBe(true); await send.click();
    if (kind === 'new') await page.waitForURL('**/s/**');
    const targetId = kind === 'new' ? page.url().split('/s/')[1]!.split('?')[0]! : sessionId;
    await expect.poll(() => ctx.store.allEvents(targetId).filter(event => event.kind === 'user.message').length).toBe(1);
    const data = ctx.store.allEvents(targetId).find(event => event.kind === 'user.message')!.data as EventData['user.message'];
    expect(data.text).toBe(body);
    const parts = data.contentParts!.parts.filter(part => part.type === 'file' || part.type === 'image');
    expect(parts.map(part => [part.type, part.name])).toEqual([['image', 'dropped.png'], ['file', 'dropped.txt']]);
    for (const [index, part] of parts.entries()) {
      const expected = index === 0 ? pixel : fileBytes;
      const found = await ctx.files.readAll(part.fileId);
      expect(found!.buffer.equals(expected)).toBe(true);
      expect(found!.file.sha256).toBe(createHash('sha256').update(expected).digest('hex'));
    }
    await page.reload();
    await page.getByTestId('message-attachments').getByRole('link', { name: 'dropped.txt' }).waitFor();
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it.each(['picker', 'paste', 'provider'] as const)('Claude %s images reach SDK encoding without model modality metadata after refresh', async kind => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter = new FakeAdapter({ id: 'claude-code' });
    adapter.listModels = async () => [{ id: 'fixture', label: 'SDK model without modalities', isDefault: true }];
    let encoded: Awaited<ReturnType<typeof encodeClaudeInput>> | undefined;
    const checked = Object.assign(adapter, { validateInput: async (_sessionId: string, input: Parameters<typeof encodeClaudeInput>[0]) => { encoded = await encodeClaudeInput(input); } });
    ctx.manager.registerAdapter(checked);
    const seeded = await seedWorkspaceAndSession(ctx, 'claude-code');
    let sessionId = seeded.sessionId;
    if (kind === 'provider') {
      const provider = await ctx.app.inject({ method: 'POST', url: '/api/providers', headers: { cookie: ctx.cookie }, payload: {
        name: 'Fixture image provider', baseUrl: 'https://fixture.invalid/v1', protocols: ['anthropic'], models: ['fixture'], apiKey: 'fixture-only',
      } });
      expect(provider.statusCode).toBe(200);
      const created = await ctx.manager.createSession({ workspaceId: seeded.workspaceId, agent: 'claude-code', providerId: (provider.json() as { id: string }).id, model: 'fixture' });
      sessionId = created.id;
    }
    browser = await chromium.launch({ headless: true }); const { page, base } = await listener(ctx, browser);
    await page.goto(`${base}/s/${sessionId}`); await page.getByTestId('composer-input').fill(kind === 'paste' ? '' : '  with picture  ');
    if (kind !== 'paste') await page.getByTestId('add-image-input').setInputFiles({ name: 'sdk.png', mimeType: 'image/png', buffer: pixel });
    else expect(await transferFiles(page, '[data-testid="composer-input"]', 'paste', [{ name: 'sdk.png', mime: 'image/png', bytes: [...pixel] }])).toBe(true);
    await expect.poll(() => page.getByTestId('composer-attachments').getByRole('img', { name: 'sdk.png' }).count()).toBe(1);
    await expect.poll(() => page.getByTestId('send-button').isEnabled()).toBe(true);
    await expect.poll(() => ctx.store.getDraft(sessionId).fileIds.length).toBe(1);
    await page.reload(); await expect.poll(() => page.getByTestId('send-button').isEnabled()).toBe(true);
    await page.getByTestId('composer-input').press('Enter');
    await expect.poll(() => ctx.store.allEvents(sessionId).filter(event => event.kind === 'user.message').length).toBe(1);
    const blocks = encoded as { type: string; source?: { data: string } }[];
    expect(Buffer.from(blocks.find(block => block.type === 'image')!.source!.data, 'base64').equals(pixel)).toBe(true);
    const data = ctx.store.allEvents(sessionId).find(event => event.kind === 'user.message')!.data as EventData['user.message'];
    expect(data.text).toBe(kind === 'paste' ? '' : '  with picture  ');
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it('Codex mixed drops automatically prepare file paths while preserving native images', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter = declaredAdapter('codex');
    let encoded: Awaited<ReturnType<typeof encodeCodexInput>> | undefined;
    ctx.manager.registerAdapter(Object.assign(adapter, { validateInput: async (_sessionId: string, input: Parameters<typeof encodeCodexInput>[0]) => { encoded = await encodeCodexInput(input, ['text', 'image']); } }));
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    browser = await chromium.launch({ headless: true }); const { page, base } = await listener(ctx, browser);
    await page.goto(`${base}/s/${sessionId}`); await page.getByTestId('composer-input').fill('image body');
    const uploadedNames: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/uploads')) uploadedNames.push((request.postDataJSON() as { name: string }).name); });
    expect(await transferFiles(page, '[data-testid="composer-input"]', 'drop', [
      { name: 'unsupported.pdf', mime: 'application/pdf', bytes: [1, 2, 3] },
      { name: 'codex.png', mime: 'image/png', bytes: [...pixel] },
    ])).toBe(true);
    await expect.poll(() => page.getByTestId('send-button').isEnabled()).toBe(true);
    expect(uploadedNames).toEqual(['unsupported.pdf', 'codex.png']);
    await page.getByTestId('send-button').click();
    await expect.poll(() => encoded?.some(part => part.type === 'localImage')).toBe(true);
    expect(encoded!.map(part => part.type)).toEqual(['text', 'localImage']);
    const path = encoded!.find(part => part.type === 'localImage')!;
    if (path.type !== 'localImage') throw new Error('Missing native image');
    expect((await readFile(path.path)).equals(pixel)).toBe(true);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it.each(['codex', 'dsh'] as const)('%s still requires native image modalities and leaves text-only paste/drop to the browser', async agent => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    ctx.manager.registerAdapter(new FakeAdapter({ id: agent }));
    const { sessionId } = await seedWorkspaceAndSession(ctx, agent);
    browser = await chromium.launch({ headless: true }); const { page, base } = await listener(ctx, browser);
    await page.goto(`${base}/s/${sessionId}`); await page.getByTestId('composer-input').fill('unchanged text');
    expect(await page.getByTestId('composer-input').evaluate(target => {
      const transfer = new DataTransfer(); transfer.setData('text/plain', 'normal text');
      const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
      const drag = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(paste); target.dispatchEvent(drag);
      return { paste: paste.defaultPrevented, drag: drag.defaultPrevented };
    })).toEqual({ paste: false, drag: false });
    expect(await page.getByTestId('composer-attachments').count()).toBe(0);
    await page.getByTestId('add-image-input').setInputFiles({ name: 'unknown-model.png', mimeType: 'image/png', buffer: pixel });
    await expect.poll(() => ctx.store.getDraft(sessionId).fileIds.length).toBe(1);
    await page.getByTestId('input-blocked-reason').filter({ hasText: '未声明支持 image' }).waitFor();
    expect(await page.getByTestId('send-button').isDisabled()).toBe(true);
    await page.getByTestId('composer-input').press('Enter');
    expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'user.message')).toHaveLength(0);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it('a dropped batch hashing in A cannot append its remaining files into B', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    ctx.manager.registerAdapter(declaredAdapter());
    const a = await seedWorkspaceAndSession(ctx);
    const b = await ctx.manager.createSession({ workspaceId: a.workspaceId, agent: 'dsh' });
    browser = await chromium.launch({ headless: true }); const { page, base } = await listener(ctx, browser);
    await page.goto(`${base}/s/${a.sessionId}`); await page.getByTestId('composer-input').fill('A draft');
    await page.evaluate(() => {
      const original = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function () {
        if (!(this instanceof File) || this.name !== 'slow-first.txt') return original.call(this);
        const read = original.bind(this);
        return new Promise<ArrayBuffer>(resolve => {
          (window as unknown as { releaseAttachmentDigest: () => Promise<void> }).releaseAttachmentDigest = async () => resolve(await read());
        });
      };
    });
    expect(await transferFiles(page, '[data-testid="composer-input"]', 'drop', [
      { name: 'slow-first.txt', mime: 'text/plain', bytes: [1] },
      { name: 'remaining.txt', mime: 'text/plain', bytes: [2] },
    ])).toBe(true);
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseAttachmentDigest?: unknown }).releaseAttachmentDigest)).toBe('function');
    await page.locator(`[data-testid="session-row"][href="/s/${b.id}"]`).click();
    await page.waitForURL(`**/s/${b.id}`); await page.getByTestId('composer-input').fill('B draft');
    await page.evaluate(() => (window as unknown as { releaseAttachmentDigest: () => Promise<void> }).releaseAttachmentDigest());
    // Wait for the original async selection to finish; the attach button is
    // disabled while a selection is still preparing.
    await expect.poll(() => page.getByTestId('attach-button').isEnabled()).toBe(true);
    expect(await page.getByTestId('composer-input').inputValue()).toBe('B draft');
    expect(await page.getByTestId('composer-attachments').count()).toBe(0);
    expect(ctx.store.getDraft(b.id).fileIds).toEqual([]);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

async function listener(ctx: Awaited<ReturnType<typeof createSourceTestApp>>, browser: Browser): Promise<{ page: Page; base: string }> {
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
  const base = `http://127.0.0.1:${address.port}`; const context = await browser.newContext(); const page = await context.newPage();
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
  return { page, base };
}
function declaredAdapter(id: 'dsh' | 'codex' = 'dsh') {
  const adapter = new FakeAdapter({ id });
  adapter.listModels = async () => [{ id: 'fixture', label: 'Fixture input model', isDefault: true, inputModalities: ['text', 'image'] }];
  return adapter;
}

it('Codex mode persists through sending, empty-draft clearing and refresh before Session metadata has loaded', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter: AgentAdapter = declaredAdapter('codex');
    adapter.inputModes = async () => ({ modes: [{ id: 'plan', label: '计划' }, { id: 'default', label: '默认' }], observedMode: 'plan' });
    ctx.manager.registerAdapter(adapter);
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'codex');
    browser = await chromium.launch({ headless: true }); const { page, base } = await listener(ctx, browser);
    await page.goto(`${base}/s/${sessionId}`);
    const mode = page.getByTestId('codex-input-mode');
    await expect.poll(() => mode.locator('option[value="plan"]').isEnabled()).toBe(true);
    await mode.selectOption('plan');
    await page.getByTestId('composer-input').fill('  原文  ');
    await page.getByTestId('send-button').click();
    await expect.poll(() => ctx.store.allEvents(sessionId).filter(event => event.kind === 'user.message').length).toBe(1);
    expect((ctx.store.allEvents(sessionId).find(event => event.kind === 'user.message')!.data as EventData['user.message']).contentParts?.collaborationMode).toBe('plan');
    await expect.poll(() => page.getByTestId('composer-input').inputValue()).toBe('');
    await expect.poll(() => page.getByTestId('draft-sync-state').getAttribute('data-pending')).toBe('false');
    await page.reload();
    await expect.poll(() => mode.inputValue()).toBe('plan');
    expect(await page.getByTestId('composer-input').inputValue()).toBe('');
    expect(ctx.store.getDraft(sessionId).contentParts?.collaborationMode).toBe('plan');
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
it('product Composer keeps failed uploads in A across B/refresh, resumes exact bytes and renders sent attachments', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  const fixture = Buffer.alloc(2 * 1024 * 1024 + 37); for (let index = 0; index < fixture.length; index++) fixture[index] = index * 31 % 251;
  const digest = createHash('sha256').update(fixture).digest('hex');
  try {
    ctx.manager.registerAdapter(declaredAdapter());
    const a = await seedWorkspaceAndSession(ctx); const b = await ctx.manager.createSession({ workspaceId: a.workspaceId, agent: 'dsh' });
    browser = await chromium.launch({ headless: true }); const { page, base } = await listener(ctx, browser);
    await page.goto(`${base}/s/${a.sessionId}`);
    const input = page.getByTestId('composer-input'); await input.waitFor();
    await input.fill('  exact\n正文  '); const editor = await input.inputValue();
    let interruptedUploadId: string | undefined;
    let acceptedBeforeOffline: number[] = [];
    await page.route('**/chunks/1', async route => {
      await page.context().setOffline(true);
      await route.abort('internetdisconnected');
      const id = new URL(route.request().url()).pathname.split('/')[3]!;
      acceptedBeforeOffline = ctx.files.uploadStatus(id).received;
      interruptedUploadId = id;
    });
    await page.getByTestId('add-file-input').setInputFiles({ name: 'proof.bin', mimeType: 'application/octet-stream', buffer: fixture });
    // The button is also visible while queued; require the actual network cut.
    await expect.poll(() => interruptedUploadId).toBeDefined();
    expect(acceptedBeforeOffline).toEqual([0]);
    await page.getByTestId('composer-attachments').getByRole('button', { name: '继续上传' }).waitFor();
    await input.press('Enter');
    expect(ctx.store.allEvents(a.sessionId).filter(event => event.kind === 'user.message')).toHaveLength(0);
    expect(await page.getByTestId('send-button').isDisabled()).toBe(true);
    await page.context().setOffline(false); await page.unroute('**/chunks/1');
    await page.goto(`${base}/s/${b.id}`); await page.getByTestId('composer-input').waitFor();
    expect(await page.getByTestId('composer-input').inputValue()).toBe('');
    expect(await page.getByTestId('composer-attachments').count()).toBe(0);
    await page.goto(`${base}/s/${a.sessionId}`);
    await expect.poll(() => page.getByTestId('composer-input').inputValue()).toBe(editor);
    let repeatedChunk = 0;
    const resumedUploads: string[] = [];
    page.on('request', request => {
      if (request.url().endsWith('/chunks/0')) repeatedChunk++;
      const match = new URL(request.url()).pathname.match(/^\/api\/uploads\/([^/]+)\/chunks\/[0-9]+$/);
      if (match) resumedUploads.push(match[1]!);
    });
    await page.getByTestId('composer-attachments').getByRole('button', { name: '继续上传' }).click();
    await expect.poll(() => page.getByTestId('send-button').isEnabled()).toBe(true);
    expect(repeatedChunk).toBe(0);
    expect(resumedUploads).toHaveLength(2);
    expect(resumedUploads.every(id => id === interruptedUploadId)).toBe(true);
    console.log('upload recovery cut', JSON.stringify({ interruptedUploadId, acceptedBeforeOffline, resumedUploads, repeatedChunk }));
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n1sAAAAASUVORK5CYII=', 'base64');
    await page.getByTestId('add-image-input').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: image });
    await expect.poll(() => page.getByTestId('send-button').isEnabled()).toBe(true);
    await page.getByTestId('composer-input').press('Enter');
    await expect.poll(() => ctx.store.allEvents(a.sessionId).filter(event => event.kind === 'user.message').length).toBe(1);
    const event = ctx.store.allEvents(a.sessionId).find(event => event.kind === 'user.message')!;
    const data = event.data as EventData['user.message']; expect(data.text).toBe(editor);
    const file = data.contentParts?.parts.find(part => part.type === 'file');
    if (file?.type !== 'file') throw new Error('Missing native file reference');
    const stored = await ctx.files.readAll(file.fileId); expect(stored?.buffer.equals(fixture)).toBe(true); expect(stored?.file.sha256).toBe(digest);
    await page.getByTestId('message-attachments').getByRole('link', { name: 'proof.bin' }).waitFor();
    await expect.poll(() => page.getByTestId('message-attachments').getByRole('img', { name: 'pixel.png' }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
    await page.reload();
    await expect.poll(() => page.getByTestId('composer-input').inputValue()).toBe('');
    await page.getByTestId('message-attachments').getByRole('link', { name: 'proof.bin' }).waitFor();
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it('new-session Composer explicitly grants its uploaded file after creation before durable send', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    ctx.manager.registerAdapter(declaredAdapter());
    const workspace = ctx.store.createWorkspace('new input', ctx.dataDir);
    browser = await chromium.launch({ headless: true }); const { page, base } = await listener(ctx, browser);
    const grants: string[] = []; const starts: Record<string, unknown>[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/attachments')) grants.push(request.url());
      if (request.method() === 'POST' && request.url().endsWith('/api/uploads')) starts.push(request.postDataJSON() as Record<string, unknown>);
    });
    await page.goto(`${base}/new?w=${workspace.id}&agent=dsh`);
    const input = page.getByTestId('new-session-input'); await input.waitFor(); await input.fill('  new original\n  ');
    const editor = await input.inputValue();
    await page.getByTestId('add-file-input').setInputFiles({ name: 'new.txt', mimeType: 'text/plain', buffer: Buffer.from('new exact\r\nbytes') });
    await expect.poll(() => page.getByTestId('new-session-send').isEnabled()).toBe(true);
    await page.getByTestId('new-session-send').click();
    await page.waitForURL('**/s/**'); const sessionId = page.url().split('/s/')[1]!.split('?')[0]!;
    expect(starts).toHaveLength(1); expect(starts[0]?.['sessionId']).toBeUndefined();
    expect(grants).toEqual([`${base}/api/sessions/${sessionId}/attachments`]);
    await expect.poll(() => ctx.store.allEvents(sessionId).filter(event => event.kind === 'user.message').length).toBe(1);
    expect((ctx.store.allEvents(sessionId).find(event => event.kind === 'user.message')!.data as EventData['user.message']).text).toBe(editor);
    await page.getByTestId('message-attachments').getByRole('link', { name: 'new.txt' }).waitFor();
    await page.reload(); await expect.poll(() => page.getByTestId('composer-input').inputValue()).toBe('');
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it.each(['lost creation response', 'failed attachment grant'])('reuses the first session after a %s across refresh', async failure => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    ctx.manager.registerAdapter(declaredAdapter());
    const workspace = ctx.store.createWorkspace('first-send recovery', ctx.dataDir);
    browser = await chromium.launch({ headless: true });
    const { page, base } = await listener(ctx, browser);
    const creationIds: string[] = [];
    let lostResponse = false; let deniedGrant = false;
    await page.route(`${base}/api/commands`, async route => {
      const { command } = route.request().postDataJSON() as { command: { op: string; clientCommandId: string } };
      if (command.op === 'create-session') creationIds.push(command.clientCommandId);
      if (command.op === 'create-session' && failure === 'lost creation response' && !lostResponse) {
        lostResponse = true;
        const response = await route.fetch();
        expect((await response.json() as { ok: boolean }).ok).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    });
    if (failure === 'failed attachment grant') await page.route('**/api/sessions/*/attachments', async route => {
      if (deniedGrant) await route.continue();
      else {
        deniedGrant = true;
        await route.fulfill({ status: 503, json: { error: 'Temporary attachment grant failure' } });
      }
    });
    await page.goto(`${base}/new?w=${workspace.id}&agent=dsh`);
    const input = page.getByTestId('new-session-input');
    const text = '  first message retained🐈\n  ';
    await input.fill(text);
    if (failure === 'failed attachment grant') await page.getByTestId('add-file-input').setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('retry bytes') });
    const send = page.getByTestId('new-session-send');
    await expect.poll(() => send.isEnabled()).toBe(true);
    await send.click();
    await page.getByText(failure === 'lost creation response' ? /Failed to fetch/ : /Temporary attachment grant failure/).waitFor();
    const original = ctx.store.listSessions()[0]!;
    expect(ctx.store.listSessions()).toHaveLength(1);
    expect(ctx.store.allEvents(original.id).filter(event => event.kind === 'user.message')).toHaveLength(0);

    await page.reload();
    await expect.poll(() => input.inputValue()).toBe(text);
    const retriedText = deniedGrant ? `${text}edited before retry` : text;
    if (deniedGrant) await input.fill(retriedText);
    await send.click();
    await page.waitForURL('**/s/**');
    expect(ctx.store.listSessions()).toHaveLength(1);
    expect(creationIds).toEqual([creationIds[0], creationIds[0]]);
    expect(new URL(page.url()).pathname).toBe(`/s/${original.id}`);
    await expect.poll(() => ctx.store.allEvents(original.id).filter(event => event.kind === 'user.message').length).toBe(1);
    expect(ctx.store.allEvents(original.id).find(event => event.kind === 'user.message')?.data).toMatchObject({ text: retriedText });
    if (deniedGrant) await page.getByTestId('message-attachments').getByRole('link', { name: 'retry.txt' }).waitFor();
    else {
      await page.goto(`${base}/new?w=${workspace.id}&agent=dsh`);
      await input.fill(text);
      await send.click();
      await page.waitForURL('**/s/**');
      expect(ctx.store.listSessions()).toHaveLength(2);
      expect(creationIds[2]).not.toBe(creationIds[0]);
    }
  } finally { await browser?.close(); await ctx.close(); }
}, 40_000);

it('can retry a definite creation rejection using the same draft', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter = declaredAdapter();
    const create = adapter.create.bind(adapter);
    let attempts = 0;
    adapter.create = async options => {
      if (++attempts === 1) throw Object.assign(new Error('Fixture rejected creation'), { statusCode: 400 });
      return create(options);
    };
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('retry rejected creation', ctx.dataDir);
    browser = await chromium.launch({ headless: true });
    const { page, base } = await listener(ctx, browser);
    await page.goto(`${base}/new?w=${workspace.id}&agent=dsh`);
    const input = page.getByTestId('new-session-input');
    const send = page.getByTestId('new-session-send');
    const text = 'Reuse the same draft after rejection';
    await input.fill(text);
    await send.click();
    await page.getByText('Fixture rejected creation').waitFor();
    expect(ctx.store.listSessions()).toHaveLength(0);
    expect(await input.inputValue()).toBe(text);
    await send.click();
    await page.waitForURL('**/s/**');
    expect(attempts).toBe(2);
    expect(ctx.store.listSessions()).toHaveLength(1);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it('product handoff saves through draft CAS and both cloud conflict choices remain actionable', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    ctx.manager.registerAdapter(declaredAdapter());
    const source = await seedWorkspaceAndSession(ctx);
    const target = await ctx.manager.createSession({ workspaceId: source.workspaceId, agent: 'dsh' });
    ctx.store.updateSession(target.id, { title: 'Handoff target' });
    browser = await chromium.launch({ headless: true }); const { page, base } = await listener(ctx, browser);
    page.setDefaultTimeout(5000);
    await page.goto(`${base}/s/${source.sessionId}`);
    const input = page.getByTestId('composer-input'); await input.fill('source input'); await input.press('Enter');
    await page.getByRole('button', { name: '带到…', exact: true }).waitFor();
    const answer = ctx.store.allEvents(source.sessionId).filter(event => event.kind === 'assistant.message').at(-1)!.data as EventData['assistant.message'];
    await page.getByRole('button', { name: '带到…', exact: true }).click();
    await page.getByTestId(`handoff-target-${target.id}`).click();
    await page.waitForURL(url => url.pathname.endsWith(`+${target.id}`));
    await page.getByRole('button', { name: '移到主栏', exact: true }).click();
    await page.waitForURL(url => url.pathname.startsWith(`/s/${target.id}+`));
    const targetInput = page.locator(`#composer-${target.id}`);
    await expect.poll(() => targetInput.inputValue()).toBe(answer.text);
    expect(ctx.store.getDraft(target.id).text).toBe(answer.text);
    expect(ctx.store.allEvents(target.id).filter(event => event.kind === 'user.message')).toHaveLength(0);
    const changeRemote = async (text: string) => {
      const revision = ctx.store.getDraft(target.id).revision;
      const response = await ctx.app.inject({ method: 'PUT', url: `/api/sessions/${target.id}/draft`, headers: { cookie: ctx.cookie },
        payload: { expectedRevision: revision, text, fileIds: [], contentParts: { version: 1, parts: [{ type: 'text', text }] } } });
      expect(response.statusCode).toBe(200);
    };
    await changeRemote('other device'); await targetInput.fill('my local draft');
    await page.getByRole('button', { name: '使用本机草稿', exact: true }).waitFor();
    expect(await targetInput.inputValue()).toBe('my local draft');
    await page.getByRole('button', { name: '使用本机草稿', exact: true }).click();
    await expect.poll(() => ctx.store.getDraft(target.id).text).toBe('my local draft');
    await changeRemote('chosen remote draft'); await targetInput.fill('temporary local draft');
    await page.getByRole('button', { name: '使用云端草稿', exact: true }).click();
    await expect.poll(() => targetInput.inputValue()).toBe('chosen remote draft');
    await targetInput.press('Enter');
    await expect.poll(() => ctx.store.allEvents(target.id).filter(event => event.kind === 'user.message').length).toBe(1);
    await page.waitForFunction(id => (document.getElementById(`composer-${id}`) as HTMLTextAreaElement | null)?.value === ''
      && document.querySelector('[data-testid="draft-sync-state"]')?.getAttribute('data-pending') === 'false', target.id);
    expect(ctx.store.getDraft(target.id).text).toBe('');
    await page.reload(); await expect.poll(() => page.getByTestId('composer-input').inputValue()).toBe('');
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it('Codex Composer explains its native file boundary and Enter cannot submit a recovered unsupported attachment', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    ctx.manager.registerAdapter(declaredAdapter('codex'));
    const session = await seedWorkspaceAndSession(ctx, 'codex');
    browser = await chromium.launch({ headless: true }); const { page, base } = await listener(ctx, browser);
    await page.goto(`${base}/s/${session.sessionId}`);
    for (const width of [1280, 420]) {
      await page.setViewportSize({ width, height: 720 });
      await page.getByTestId('attach-button').click();
      await expect.poll(() => page.getByTestId('attach-button').getAttribute('aria-expanded')).toBe('true');
      expect(await page.getByTestId('add-file').isEnabled()).toBe(true);
      // Mobile menus are bottom sheets; dismiss by tapping outside the sheet.
      await page.getByTestId('composer-input').click();
      await expect.poll(() => page.getByTestId('attach-button').getAttribute('aria-expanded')).toBe('false');
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByTestId('attach-button').click();
    expect(await page.getByTestId('add-file').isEnabled()).toBe(true);
    await page.route('**/api/workspaces/*/attach', route => route.fulfill({ status: 500, json: { error: 'workspace unavailable' } }));
    await page.getByTestId('add-file-input').setInputFiles({ name: 'unsupported.txt', mimeType: 'text/plain', buffer: Buffer.from('original bytes') });
    await expect.poll(() => page.getByTestId('input-blocked-reason').textContent()).toContain('文件尚未准备完成');
    await page.getByRole('button', { name: '重试文件准备' }).waitFor();
    await page.getByTestId('composer-input').press('Enter');
    expect(ctx.store.allEvents(session.sessionId).filter(event => event.kind === 'user.message')).toHaveLength(0);
    expect(await page.getByTestId('send-button').isDisabled()).toBe(true);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it('a failed native admission can restore exact text and attachment references into the product Composer', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    ctx.manager.registerAdapter(declaredAdapter());
    const session = await seedWorkspaceAndSession(ctx);
    browser = await chromium.launch({ headless: true }); const { page, base } = await listener(ctx, browser);
    await page.goto(`${base}/s/${session.sessionId}`);
    const input = page.getByTestId('composer-input'); await input.fill('  rejected original\n ');
    const editor = await input.inputValue();
    await page.getByTestId('add-file-input').setInputFiles({ name: 'recover.txt', mimeType: 'text/plain', buffer: Buffer.from('exact selected bytes') });
    await expect.poll(() => page.getByTestId('send-button').isEnabled()).toBe(true);
    const url = await page.getByTestId('composer-attachments').getByRole('link', { name: 'recover.txt' }).getAttribute('href');
    const fileId = url?.split('/files/')[1]; if (fileId === undefined) throw new Error('Missing completed attachment');
    await writeFile(ctx.files.resolvePath(fileId)!, 'damaged after upload');
    await input.press('Enter');
    await page.getByRole('button', { name: '放回输入框', exact: true }).waitFor();
    expect(await input.inputValue()).toBe('');
    expect(ctx.store.allEvents(session.sessionId).filter(event => event.kind === 'user.message')).toHaveLength(0);
    await page.getByRole('button', { name: '放回输入框', exact: true }).click();
    await expect.poll(() => input.inputValue()).toBe(editor);
    await page.getByTestId('composer-attachments').getByRole('link', { name: 'recover.txt' }).waitFor();
    expect(await page.getByTestId('composer-attachments').getByRole('link', { name: 'recover.txt' }).getAttribute('href')).toBe(url);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it('two same-origin pages reject an old cloud baseline without partially adopting its local draft', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const session = await seedWorkspaceAndSession(ctx);
    browser = await chromium.launch({ headless: true }); const { page, base } = await listener(ctx, browser);
    const other = await page.context().newPage();
    await page.goto(`${base}/s/${session.sessionId}`); await other.goto(`${base}/s/${session.sessionId}`);
    const bundle = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'atomic-preparation.ts', loader: 'ts', contents:
      `import { InputPreparationStore } from './packages/web/src/lib/input-preparation-store.ts'; Object.assign(window,{atomicPreparation:new InputPreparationStore('atomic-baseline-race')});` },
      bundle: true, platform: 'browser', format: 'iife', write: false });
    const script = bundle.outputFiles[0]!.text;
    await page.addScriptTag({ content: script }); await other.addScriptTag({ content: script });
    const original = await page.evaluate(async () => {
      const store = (window as unknown as { atomicPreparation: { putDraft(draft: unknown, expected: number): Promise<void>; putRemoteDraft(baseline: unknown): Promise<void>; getRemoteDraft(id: string): Promise<unknown> } }).atomicPreparation;
      await store.putDraft({ sessionId: 'A', revision: 3, text: 'keep local', contentParts: { version: 1, parts: [] }, updatedAt: 1 }, 0);
      await store.putRemoteDraft({ sessionId: 'A', revision: 4, text: 'old cloud', contentParts: { version: 1, parts: [{ type: 'text', text: 'old cloud' }] } });
      return store.getRemoteDraft('A');
    });
    await other.evaluate(async expected => {
      const store = (window as unknown as { atomicPreparation: { compareRemoteDraft(baseline: unknown, expected: unknown): Promise<void> } }).atomicPreparation;
      await store.compareRemoteDraft({ sessionId: 'A', revision: 5, text: 'new cloud', contentParts: { version: 1, parts: [{ type: 'text', text: 'new cloud' }] } }, expected);
    }, original);
    const result = await page.evaluate(async original => {
      const store = (window as unknown as { atomicPreparation: {
        getRemoteDraft(id: string): Promise<{ revision: number }>; getDraft(id: string): Promise<{ revision: number; text: string }>;
        adoptRemoteDraft(baseline: unknown, expectedLocal: number, expectedRemote: unknown): Promise<unknown>; compareRemoteDraft(baseline: unknown, expected: unknown): Promise<void>;
      } }).atomicPreparation;
      const newest = await store.getRemoteDraft('A'); const errors: number[] = [];
      for (const expected of [original, newest]) {
        try { await store.adoptRemoteDraft(original, 3, expected); } catch (error) { errors.push((error as { status: number }).status); }
      }
      try { await store.compareRemoteDraft(original, newest); } catch (error) { errors.push((error as { status: number }).status); }
      return { errors, local: await store.getDraft('A'), baseline: await store.getRemoteDraft('A') };
    }, original);
    expect(result.errors).toEqual([409, 409, 409]);
    expect(result.local).toMatchObject({ revision: 3, text: 'keep local' });
    expect(result.baseline).toMatchObject({ revision: 5, text: 'new cloud' });
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
