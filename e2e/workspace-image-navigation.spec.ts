import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { login } from './helpers.js';
test('a controlled browser opens an absolute workspace image as image bytes', async ({ page }) => {
  await login(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload(); await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  const path = `/tmp/wdcc-e2e-workspace/navigation-${Date.now()}.png`;
  await writeFile(path, await page.screenshot());
  const response = await page.goto(path);
  expect(response?.status()).toBe(200); expect(response?.headers()['content-type']).toBe('image/png');
  await expect.poll(() => page.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
});
