import { expect, it } from 'vitest';
import { parseSlashInput, slashCommandFor } from '@webdcc/protocol';
import { codexSlashCommands, executeCodexSlash } from '../src/slash.js';
import type { JsonRpcStdio } from '../src/rpc.js';
import type { ThreadGoal } from '../src/schema/v2/ThreadGoal.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

function native() {
  let goal: ThreadGoal | null = null;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const files = new Map<string, Buffer>();
  const rpc = { request: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === 'fs/createDirectory') return {};
    if (method === 'fs/writeFile') { files.set(String(params['path']), Buffer.from(String(params['dataBase64']), 'base64')); return {}; }
    if (method === 'fs/readFile') return { dataBase64: files.get(String(params['path']))!.toString('base64') };
    if (method === 'fs/remove') return {};
    if (method === 'thread/goal/get') return { goal };
    if (method === 'thread/goal/clear') { const cleared = goal !== null; goal = null; return { cleared }; }
    if (method === 'thread/goal/set') {
      goal = { threadId: 'native', objective: '', status: 'active', tokensUsed: 0, tokenBudget: null, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2, ...goal,
        ...Object.fromEntries(Object.entries(params).filter(([key]) => ['objective', 'status', 'tokenBudget'].includes(key))) } as ThreadGoal;
      return { goal };
    }
    throw new Error('Unexpected native method ' + method);
  } } as unknown as JsonRpcStdio;
  return { rpc, calls, files, goal: () => goal };
}
it('exports every pinned native command and alias with an explicit execution route', () => {
  expect(codexSlashCommands).toHaveLength(65);
  expect(codexSlashCommands.every(command => command.route && command.source)).toBe(true);
  expect(slashCommandFor(codexSlashCommands, '/goal pause')?.route).toBe('native-control');
  expect(slashCommandFor(codexSlashCommands, '/theme')?.route).toBe('native-terminal');
  expect(slashCommandFor(codexSlashCommands, '/cwd')?.name).toBe('/pwd');
  expect(slashCommandFor(codexSlashCommands, '/clean')?.name).toBe('/stop');
  expect(parseSlashInput('/goal\n  原文\n next')).toEqual({ name: '/goal', rawArguments: '\n  原文\n next', line: '/goal\n  原文\n next' });
  expect(parseSlashInput(' /goal')).toBeUndefined();
});
it('oversized Unicode goals and image/file attachments preserve native bytes and recover full objectives for editing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-goal-files-')); const ctx = native();
  try {
    const bytes = Buffer.from('\ufeff中文\r\noriginal'); const path = join(root, 'reference.md'); await writeFile(path, bytes);
    const contentParts = { version: 1 as const, parts: [{ type: 'file' as const, fileId: 'reference', name: 'reference.md', mime: 'text/markdown', size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), path }] };
    const objective = '🐈'.repeat(4001);
    await executeCodexSlash(ctx.rpc, 'native', root, '/goal ' + objective, { codexHome: root, contentParts });
    expect([...ctx.goal()!.objective].length).toBeLessThanOrEqual(4000);
    const copied = [...ctx.files].find(([path]) => path.endsWith('file-1.md')); expect(copied?.[1].equals(bytes)).toBe(true);
    const edited = await executeCodexSlash(ctx.rpc, 'native', root, '/goal edit', { codexHome: root });
    expect(edited.objective).toContain(objective); expect(edited.objective).toContain(copied![0]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('changed attachment bytes and attachments on pause reject before any native write or replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-goal-changed-')); const ctx = native();
  try {
    const path = join(root, 'image.png'); await writeFile(path, 'changed');
    const options = { codexHome: root, replaceGoal: true, contentParts: { version: 1 as const, parts: [{ type: 'image' as const, fileId: 'image', name: 'image.png', mime: 'image/png', size: 7, sha256: '0'.repeat(64), path }] } };
    await executeCodexSlash(ctx.rpc, 'native', root, '/goal old'); const before = ctx.calls.length;
    await expect(executeCodexSlash(ctx.rpc, 'native', root, '/goal new', options)).rejects.toThrow('内容已变化');
    await expect(executeCodexSlash(ctx.rpc, 'native', root, '/goal pause', options)).rejects.toThrow('设置或编辑');
    expect(ctx.goal()?.objective).toBe('old'); expect(ctx.calls.slice(before).every(call => call.method === 'thread/goal/get')).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('goal show/set/pause/resume/clear use the fixed native APIs and never turn the command into a model prompt', async () => {
  const ctx = native();
  expect((await executeCodexSlash(ctx.rpc, 'native', '/work', '/goal')).text).toContain('没有原生目标');
  await executeCodexSlash(ctx.rpc, 'native', '/work', '/goal  目标\n第二行  ');
  expect(ctx.goal()?.objective).toBe('目标\n第二行');
  expect(ctx.calls.at(-1)).toEqual({ method: 'thread/goal/set', params: { threadId: 'native', origin: 'user', objective: '目标\n第二行', status: 'active' } });
  await executeCodexSlash(ctx.rpc, 'native', '/work', '/goal PAUSE'); expect(ctx.goal()?.status).toBe('paused');
  await executeCodexSlash(ctx.rpc, 'native', '/work', '/goal resume'); expect(ctx.goal()?.status).toBe('active');
  await executeCodexSlash(ctx.rpc, 'native', '/work', '/goal clear'); expect(ctx.goal()).toBeNull();
  expect(ctx.calls.every(call => !['turn/start', 'turn/steer'].includes(call.method))).toBe(true);
});
it('existing goals require a concrete replacement decision; editing preserves native status and budget', async () => {
  const ctx = native(); await executeCodexSlash(ctx.rpc, 'native', '/work', '/goal old');
  const before = ctx.calls.length;
  expect(await executeCodexSlash(ctx.rpc, 'native', '/work', '/goal replacement')).toMatchObject({ form: 'goal-replace', objective: 'replacement' });
  expect(ctx.calls.slice(before).map(call => call.method)).toEqual(['thread/goal/get']);
  await executeCodexSlash(ctx.rpc, 'native', '/work', '/goal replacement', { replaceGoal: true });
  await executeCodexSlash(ctx.rpc, 'native', '/work', '/goal pause');
  expect(await executeCodexSlash(ctx.rpc, 'native', '/work', '/goal edit')).toMatchObject({ form: 'goal-edit', objective: 'replacement' });
  await executeCodexSlash(ctx.rpc, 'native', '/work', '/goal edited', { editGoal: true });
  expect(ctx.goal()).toMatchObject({ objective: 'edited', status: 'paused', tokenBudget: null });
  // In the pinned TUI only the exact word "edit" is a control; this text is an objective.
  expect(await executeCodexSlash(ctx.rpc, 'native', '/work', '/goal edit my goal')).toMatchObject({ form: 'goal-replace', objective: 'edit my goal' });
});
