import { chromium, type Browser } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentAdapter, EventData, UserInput } from '@webdcc/protocol';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import { createSourceTestApp } from './helpers.js';

it('selects an actual native Skill before creation and sends its original reference in the first message', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const workspace = ctx.store.createWorkspace('First native Skill', ctx.dataDir);
    const fake = new FakeAdapter({ id: 'codex' });
    const adapter: AgentAdapter = fake;
    const create = fake.create.bind(fake); const send = fake.send.bind(fake);
    const created: string[] = []; const sent: UserInput[] = []; const reads: unknown[][] = [];
    const option = { skillId: 'native-skill-identity', name: 'fixture-skill', description: 'Real native directory reference', enabled: true };
    adapter.create = async options => { created.push(options.sessionId); return create(options); };
    adapter.send = async (id, input) => { sent.push(structuredClone(input)); await send(id, input); };
    adapter.listModels = async () => [{ id: 'fixture', label: 'Fixture model', isDefault: true, inputModalities: ['text', 'image'] }];
    adapter.inputSkills = async (...args) => { reads.push(args); return [option, { ...option, skillId: 'disabled-skill', name: 'disabled-skill', enabled: false }]; };
    adapter.resolveInputSkill = async (_id, selected) => {
      if (selected.skillId !== option.skillId || selected.name !== option.name) throw new Error('Unrecognized native Skill');
      return { path: `${workspace.path}/.agents/skills/fixture-skill/SKILL.md` };
    };
    ctx.manager.registerAdapter(adapter);
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/new?w=${workspace.id}&agent=codex`);
    const input = page.getByTestId('new-session-input'); await input.waitFor();
    const text = '  first native Skill🐈\nsecond line  '; await input.fill(text);
    await page.getByTestId('attach-button').click();
    await page.getByRole('menuitem', { name: '添加原生技能', exact: true }).click();
    const menu = page.getByTestId('input-skill-menu');
    await expect.poll(() => menu.getByRole('menuitem', { name: /fixture-skill/ }).count()).toBe(1);
    expect(await menu.getByRole('menuitem', { name: /disabled-skill/ }).isDisabled()).toBe(true);
    expect(reads).toEqual([[undefined, workspace.path]]); expect(created).toEqual([]);
    await menu.getByRole('menuitem', { name: /fixture-skill/ }).click();
    expect(created).toEqual([]);
    await input.press('Enter');
    await expect.poll(() => sent.length).toBe(1);
    expect(created).toHaveLength(1);
    expect(sent[0]).toMatchObject({ text, contentParts: { version: 1, parts: [
      { type: 'text', text }, { type: 'skill', skillId: option.skillId, name: option.name, path: `${workspace.path}/.agents/skills/fixture-skill/SKILL.md` },
    ] } });
    const event = ctx.store.allEvents(created[0]!).find(event => event.kind === 'user.message');
    expect((event?.data as EventData['user.message']).contentParts?.parts).toContainEqual({ type: 'skill', skillId: option.skillId, name: option.name });
    expect(JSON.stringify(event?.data)).not.toContain('/SKILL.md');
  } finally { await browser?.close(); await ctx.close(); }
}, 40_000);

it('ignores a late Skill catalog from the previous workspace and keeps the first input bound to the selected project', async () => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  try {
    const first = ctx.store.createWorkspace('First skill project', ctx.dataDir);
    const secondPath = join(ctx.dataDir, 'second'); await mkdir(secondPath);
    const second = ctx.store.createWorkspace('Second skill project', secondPath);
    const fake = new FakeAdapter({ id: 'codex' }); const adapter: AgentAdapter = fake;
    const reads: string[] = []; const created: string[] = []; const sends: UserInput[] = [];
    const create = fake.create.bind(fake); const send = fake.send.bind(fake);
    adapter.listModels = async () => [{ id: 'fixture', label: 'Fixture', isDefault: true, inputModalities: ['text'] }];
    adapter.inputSkills = async (_id, cwd) => {
      reads.push(cwd!);
      if (cwd === first.path) await pending;
      return [{ skillId: cwd === first.path ? 'old-skill' : 'current-skill', name: cwd === first.path ? 'old-skill' : 'current-skill', description: 'Controlled native directory', enabled: true }];
    };
    adapter.create = async opts => { created.push(opts.cwd); return create(opts); };
    adapter.send = async (id, input) => { sends.push(structuredClone(input)); await send(id, input); };
    adapter.resolveInputSkill = async (_id, selection) => {
      if (selection.skillId !== 'current-skill') throw new Error('Old workspace skill cannot be sent');
      return { path: join(second.path, '.agents/skills/current-skill/SKILL.md') };
    };
    ctx.manager.registerAdapter(adapter);
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(`${base}/new?w=${first.id}&agent=codex`);
    await page.getByTestId('attach-button').click(); await page.getByRole('menuitem', { name: '添加原生技能', exact: true }).click();
    await expect.poll(() => reads).toEqual([first.path]);
    await page.getByTestId('workspace-chip').click();
    await page.getByRole('menuitemradio', { name: /Second skill project/ }).click();
    await page.getByTestId('attach-button').click(); await page.getByRole('menuitem', { name: '添加原生技能', exact: true }).click();
    const menu = page.getByTestId('input-skill-menu');
    await menu.getByRole('menuitem', { name: /current-skill/ }).waitFor();
    finish();
    await expect.poll(() => reads).toEqual([first.path, second.path]);
    expect(await menu.getByRole('menuitem', { name: /old-skill/ }).count()).toBe(0);
    expect(created).toHaveLength(0);
    await menu.getByRole('menuitem', { name: /current-skill/ }).click();
    await page.getByTestId('new-session-input').fill('Use this project skill'); await page.getByTestId('new-session-input').press('Enter');
    await expect.poll(() => sends.length).toBe(1);
    expect(created).toEqual([second.path]);
    expect(sends[0]?.contentParts?.parts).toContainEqual({ type: 'skill', skillId: 'current-skill', name: 'current-skill', path: join(second.path, '.agents/skills/current-skill/SKILL.md') });
  } finally { finish(); await browser?.close(); await ctx.close(); }
}, 40_000);
