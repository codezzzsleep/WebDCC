import { readFile, writeFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { createSession, login, waitForTurnComplete } from './helpers.js';

async function setup(page: Page) {
  await login(page);
  const { sessionId } = await createSession(page, 'codex'); await waitForTurnComplete(page);
  const session = await (await page.request.get(`/api/sessions/${sessionId}`)).json();
  const endpoint = `/api/workspaces/${session.workspaceId}/fs`;
  const directory = `html-preview-${Date.now()}`;
  for (const path of [directory, `${directory}/assets`]) expect((await page.request.post(endpoint, { data: { path, kind: 'dir' } })).status()).toBe(200);
  const file = async (name: string, content: string) => { expect((await page.request.post(endpoint, { data: { path: `${directory}/${name}`, kind: 'file', content } })).status()).toBe(200); };
  const open = async (name: string) => {
    await page.goto(`/s/${sessionId}?dock=files`);
    await page.getByTestId('dock').getByRole('button', { name: directory, exact: true }).click();
    await page.getByTestId('dock').getByRole('button', { name, exact: true }).click();
    await page.getByTestId('file-preview').waitFor();
  };
  return { directory, endpoint, file, open };
}

test('HTML renders styles, root and relative assets, modules, fetch, interactions and nested navigation', async ({ page }) => {
  const { directory, file, open } = await setup(page);
  await file('assets/style.css', `h1 { color: rgb(24,104,177); background-image: url('/${directory}/assets/icon.svg'); }`);
  await file('assets/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
  await file('assets/label.js', 'export const label = "relative";');
  await file('assets/root.js', 'export const root = "root";');
  await file('data.json', '{"value":"local-data"}');
  await file('next.html', '<h1>第二页</h1>');
  await file('assets/app.js', `import {label} from './label.js'; import {root} from '/${directory}/assets/root.js'; document.querySelector('#modules').textContent=label+'-'+root; document.querySelector('#button').onclick=()=>document.querySelector('#counter').textContent='clicked'; fetch('/${directory}/data.json').then(r=>r.json()).then(x=>document.querySelector('#data').textContent=x.value); try{parent.document.body;document.body.dataset.parentBlocked='no'}catch{document.body.dataset.parentBlocked='yes'};try{localStorage.getItem('wdcc');document.body.dataset.storageBlocked='no'}catch{document.body.dataset.storageBlocked='yes'};`);
  await file('index.html', `<meta charset="utf-8"><link rel="stylesheet" href="assets/style.css"><h1>页面效果</h1><img src="/${directory}/assets/icon.svg" alt="local"><span id="modules"></span><span id="data"></span><button id="button">运行</button><span id="counter"></span><a href="next.html">下一页</a><script type="module" src="assets/app.js"></script>`);
  await open('index.html'); const frame = page.frameLocator('[data-testid="html-preview"] iframe');
  await expect(frame.getByRole('heading', { name: '页面效果' })).toHaveCSS('color', 'rgb(24, 104, 177)');
  await expect(frame.locator('#modules')).toHaveText('relative-root'); await expect(frame.locator('#data')).toHaveText('local-data');
  await expect.poll(() => frame.getByAltText('local').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(10);
  await frame.getByRole('button', { name: '运行' }).click(); await expect(frame.locator('#counter')).toHaveText('clicked');
  await expect(frame.locator('body')).toHaveAttribute('data-parent-blocked', 'yes'); await expect(frame.locator('body')).toHaveAttribute('data-storage-blocked', 'yes');
  await frame.getByRole('link', { name: '下一页' }).click(); await expect(frame.getByRole('heading')).toHaveText('第二页');
  await page.getByRole('button', { name: '刷新预览', exact: true }).click(); await expect(frame.getByRole('heading')).toHaveText('页面效果');
});

test('HTML source edits can be previewed unsaved, downloaded unchanged, saved and reopened', async ({ page }) => {
  const { directory, endpoint, file, open } = await setup(page);
  const original = '<h1>已保存内容</h1>'; await file('index.htm', original);
  await open('index.htm'); await expect(page.frameLocator('iframe').getByRole('heading')).toHaveText('已保存内容');
  await page.getByTestId('file-preview').getByRole('button', { name: '源码', exact: true }).click();
  await expect(page.getByTestId('file-preview')).toContainText(original);
  await page.getByTestId('file-preview').getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: `编辑 ${directory}/index.htm` }); await editor.fill('<h1>未保存效果</h1>');
  await page.getByRole('button', { name: '页面', exact: true }).click();
  await expect(page.frameLocator('iframe').getByRole('heading')).toHaveText('未保存效果');
  expect((await (await page.request.get(endpoint, { params: { path: `${directory}/index.htm` } })).json()).content).toBe(original);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('file-preview').getByRole('link', { name: '下载', exact: true }).click()]);
  expect(download.suggestedFilename()).toBe('index.htm'); expect(await readFile((await download.path())!,'utf8')).toBe(original);
  await page.getByRole('button', { name: '保存', exact: true }).click(); await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await open('index.htm'); await expect(page.frameLocator('iframe').getByRole('heading')).toHaveText('未保存效果');
});

test('file panel downloads text, HTML, raster, binary and oversized files as original bytes', async ({ page }) => {
  const { directory, file, open } = await setup(page);
  await file('notes.txt', '下载中文\r\n'); await file('index.html', '<h1>原始 HTML</h1>'); await file('large.txt', 'x'.repeat(1024 * 1024 + 8));
  await writeFile(`/tmp/wdcc-e2e-workspace/${directory}/binary.bin`, Buffer.from([0, 1, 255, 128]));
  await writeFile(`/tmp/wdcc-e2e-workspace/${directory}/picture.png`, await page.screenshot());
  for (const name of ['notes.txt', 'index.html', 'picture.png', 'binary.bin', 'large.txt']) {
    await open(name);
    if (name === 'picture.png') await expect.poll(() => page.getByTestId('file-preview').locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    if (name === 'binary.bin') { await expect(page.getByTestId('file-preview')).toContainText('可直接下载'); await expect(page.getByTestId('file-preview')).not.toContainText('undefined'); }
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('file-preview').getByRole('link', { name: '下载', exact: true }).click()]);
    expect(download.suggestedFilename()).toBe(name); expect(await readFile((await download.path())!)).toEqual(await readFile(`/tmp/wdcc-e2e-workspace/${directory}/${name}`));
  }
});

test('missing HTML resources report a visible error and service-worker-controlled previews stay HTML', async ({ page }) => {
  const { file, open } = await setup(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await file('index.html', '<h1>离线缓存边界</h1><script src="missing.js"></script>');
  await open('index.html'); await expect(page.frameLocator('iframe').getByRole('heading')).toHaveText('离线缓存边界');
  await expect(page.getByTestId('html-preview').getByRole('status')).toContainText('missing.js');
});

test('external page resources require the visible network option and stay in the isolated frame', async ({ page }) => {
  const { file, open } = await setup(page);
  let requests = 0;
  await page.route('https://preview-fixture.invalid/library.js', async route => { requests++; await route.fulfill({ contentType: 'text/javascript', body: 'document.body.dataset.external="loaded"' }); });
  await file('index.html', '<h1>外部资源</h1><script src="https://preview-fixture.invalid/library.js"></script>');
  await open('index.html'); await expect(page.getByTestId('html-preview').getByRole('status')).toContainText('preview-fixture.invalid');
  expect(requests).toBe(0);
  await page.getByLabel('允许页面联网').check();
  await expect(page.frameLocator('iframe').locator('body')).toHaveAttribute('data-external', 'loaded');
  expect(requests).toBe(1);
  expect(await page.locator('body').getAttribute('data-external')).toBeNull();
});

test('the same rendered file and download controls are reachable from all three Harness session pages', async ({ page }) => {
  const { directory, file } = await setup(page);
  const html = '<h1>三个入口的文件预览</h1>'; await file('shared.html', html);
  for (const agent of ['codex', 'dsh', 'claude-code'] as const) {
    // A waiting fake turn is intentional: file viewing must not require a turn
    // to complete, nor send another prompt to any native Harness.
    const { sessionId } = await createSession(page, agent, '查看工作区文件');
    await page.goto(`/s/${sessionId}?dock=files`);
    await page.getByTestId('dock').getByRole('button', { name: directory, exact: true }).click();
    await page.getByTestId('dock').getByRole('button', { name: 'shared.html', exact: true }).click();
    await expect(page.frameLocator('iframe').getByRole('heading')).toHaveText('三个入口的文件预览');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('file-preview').getByRole('link', { name: '下载', exact: true }).click()]);
    expect(await readFile((await download.path())!, 'utf8')).toBe(html);
  }
});
