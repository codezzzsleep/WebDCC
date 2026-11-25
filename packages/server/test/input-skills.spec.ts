import { expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentAdapter, InputSkillOption } from '@webdcc/protocol';
import { FakeAdapter } from '@webdcc/fake-adapter';
import { createTestApp } from './helpers.js';

it('reads native Skill metadata for a new draft without activating a writer, and binds Agent/workspace/session', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('Skill directory', ctx.dataDir);
    const otherPath = join(ctx.dataDir, 'other');
    await mkdir(otherPath);
    const other = ctx.store.createWorkspace('Other directory', otherPath);
    const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const adapter = ctx.manager.adapter('codex')!;
    const calls: unknown[][] = [];
    const skills: InputSkillOption[] = [{ skillId: 'original-skill', name: 'source-skill', description: 'Native skill', enabled: true }];
    adapter.inputSkills = async (...args) => { calls.push(args); return skills; };
    adapter.create = async () => { throw new Error('metadata must not create'); };
    adapter.resume = async () => { throw new Error('metadata must not resume'); };
    const url = `/api/agents/codex/input-skills?workspaceId=${workspace.id}`;
    expect((await ctx.app.inject({ url })).statusCode).toBe(401);
    const response = await ctx.app.inject({ url, headers: { cookie: ctx.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ agent: 'codex', workspaceId: workspace.id, scope: 'workspace-preview', status: 'ready', skills });
    expect(calls).toEqual([[undefined, workspace.path]]);
    expect(ctx.manager.getRuntime(session.id)).toBeUndefined();
    expect((await ctx.app.inject({ url: `${url}&sessionId=${session.id}`, headers: { cookie: ctx.cookie } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ url: `/api/agents/dsh/input-skills?workspaceId=${workspace.id}&sessionId=${session.id}`, headers: { cookie: ctx.cookie } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ url: `/api/agents/codex/input-skills?workspaceId=${other.id}&sessionId=${session.id}`, headers: { cookie: ctx.cookie } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ url: '/api/agents/codex/input-skills', headers: { cookie: ctx.cookie } })).statusCode).toBe(400);
  } finally { await ctx.close(); }
});

it('a replaced directory adapter cannot publish a stale native skill result', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('Stale skill', ctx.dataDir);
    const adapter: AgentAdapter = ctx.manager.adapter('codex')!;
    let finish!: (skills: InputSkillOption[]) => void;
    const held = new Promise<InputSkillOption[]>(resolve => { finish = resolve; });
    adapter.inputSkills = async () => held;
    const reading = ctx.manager.inputSkillCatalog('codex', workspace.id);
    const replacement = new FakeAdapter({ id: 'codex' }) as AgentAdapter;
    replacement.inputSkills = async () => [];
    ctx.manager.registerAdapter(replacement);
    finish([{ skillId: 'stale', name: 'stale', description: 'stale', enabled: true }]);
    expect(await reading).toMatchObject({ status: 'error', skills: [] });
  } finally { await ctx.close(); }
});
