import { chromium, type Browser } from '@playwright/test';
import { expect, it } from 'vitest';
import type { CapabilitySnapshot, ProbeResult } from '@webdcc/protocol';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp } from './helpers.js';

it('capability diagnostics refresh reviewed versions, probe rejection and recovery without claiming verified functionality', async () => {
  const ctx = await createSourceTestApp();
  let browser: Browser | undefined;
  try {
    const adapter = new CodexAdapter();
    let probe: ProbeResult = { installed: true, version: '0.169.0', pinnedVersion: '0.167.0', compatible: true, auth: 'unknown', notes: [] };
    adapter.probe = async () => probe;
    ctx.manager.registerAdapter(adapter);
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('No test listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    const snapshots: CapabilitySnapshot[] = [];
    page.on('response', response => {
      if (new URL(response.url()).pathname === '/api/capabilities' && response.status() === 200) void response.json().then(value => snapshots.push(value as CapabilitySnapshot));
    });
    await page.goto(`${base}/settings/capabilities`);
    const runtime = page.locator('p').filter({ has: page.locator('strong', { hasText: 'Codex' }) });
    await expect.poll(() => runtime.textContent()).toContain('0.169.0 · 版本兼容');
    await expect.poll(() => snapshots.length).toBeGreaterThan(0);
    const first = snapshots.at(-1)!;
    expect(first.runtimes.find(value => value.agent === 'codex')?.compatibility).toBe('compatible');
    expect(await page.getByText('已验证', { exact: true }).count()).toBe(0);
    for (const version of ['0.168.0', '0.167.0']) {
      probe = { ...probe, version };
      await page.getByRole('button', { name: '重新检查' }).click();
      await expect.poll(() => runtime.textContent()).toContain(`${version} · 版本兼容`);
    }
    probe = { ...probe, compatible: false, notes: ['原生握手未通过审核合同'] };
    await page.getByRole('button', { name: '重新检查' }).click();
    await expect.poll(() => runtime.textContent()).toContain('0.167.0 · 版本不兼容');
    await expect.poll(() => snapshots.at(-1)?.runtimes.find(value => value.agent === 'codex')?.compatibility).toBe('incompatible');
    const rejected = snapshots.at(-1)!;
    expect(rejected.revision).not.toBe(first.revision);
    expect(rejected.capabilities.filter(value => value.agent === 'codex').every(value => value.reason.includes('原生握手未通过审核合同'))).toBe(true);
    const stale = await page.request.get(`${base}/api/capabilities?revision=${first.revision}`);
    expect(stale.status()).toBe(409);
    probe = { installed: true, pinnedVersion: '0.167.0', compatible: true, auth: 'unknown', notes: [] };
    await page.reload();
    await expect.poll(() => runtime.textContent()).toContain('版本未知 · 版本尚未确认');
    probe = { ...probe, version: '0.169.0' };
    await page.reload();
    await expect.poll(() => runtime.textContent()).toContain('0.169.0 · 版本兼容');
    expect(await page.getByText('已验证', { exact: true }).count()).toBe(0);
  } finally { await browser?.close(); await ctx.close(); }
}, 60_000);
