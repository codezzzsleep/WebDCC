import { chromium, type Browser, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { seedWorkspaceAndSession } from '../packages/server/test/helpers.js';
import type { EventData } from '@webdcc/protocol';
import { createSourceTestApp } from './helpers.js';

async function listener(ctx: Awaited<ReturnType<typeof createSourceTestApp>>, browser: Browser): Promise<{ page: Page; base: string }> {
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
  const base = `http://127.0.0.1:${address.port}`; const page = await browser.newPage();
  await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
  return { page, base };
}
function declaredAdapter(id: 'dsh' | 'codex' = 'dsh') {
  const adapter = new FakeAdapter({ id });
  adapter.listModels = async () => [{ id: 'fixture', label: 'Fixture input model', isDefault: true, inputModalities: ['text', 'image'] }];
  return adapter;
}
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
    await page.route('**/chunks/1', async route => { await page.context().setOffline(true); await route.abort('internetdisconnected'); });
    await page.getByTestId('add-file-input').setInputFiles({ name: 'proof.bin', mimeType: 'application/octet-stream', buffer: fixture });
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
    let repeatedChunk = 0; page.on('request', request => { if (request.url().endsWith('/chunks/0')) repeatedChunk++; });
    await page.getByTestId('composer-attachments').getByRole('button', { name: '继续上传' }).click();
    await expect.poll(() => page.getByTestId('send-button').isEnabled()).toBe(true);
    expect(repeatedChunk).toBe(0);
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
    await expect.poll(() => ctx.store.getDraft(target.id).text).toBe('');
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
    await page.getByTestId('attach-button').click();
    expect(await page.getByTestId('add-file').isDisabled()).toBe(true);
    await page.getByTestId('add-file-input').setInputFiles({ name: 'unsupported.txt', mimeType: 'text/plain', buffer: Buffer.from('original bytes') });
    await expect.poll(() => page.getByTestId('input-blocked-reason').textContent()).toContain('不支持 file');
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
