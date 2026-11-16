import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

const git = promisify(execFile);

it.each(['info-directory', 'exclude-file'] as const)('attachment copy does not silently edit a linked %s Git configuration', async kind => {
  const ctx = await createTestApp();
  try {
    const root = join(ctx.dataDir, 'workspace'), outside = join(ctx.dataDir, 'outside-git');
    await mkdir(root); await mkdir(outside); await git('git', ['init', '--quiet', root]);
    const info = join(root, '.git/info'), victim = join(outside, 'exclude'); await writeFile(victim, 'ORIGINAL\n');
    if (kind === 'info-directory') { await rm(info, { recursive: true }); await symlink(outside, info); }
    else { await rm(join(info, 'exclude')); await symlink(victim, join(info, 'exclude')); }
    const workspace = ctx.store.createWorkspace('Git attachment', root), file = await ctx.files.putBuffer(Buffer.from('PAYLOAD'), 'file.txt', 'text/plain');
    const response = await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/attach`, headers: { cookie: ctx.cookie }, payload: { fileId: file.id } });
    const content = await readFile(victim, 'utf8');
    console.info('controlled linked Git exclude', JSON.stringify({ kind, status: response.statusCode, outsideContent: content }));
    expect(response.statusCode).toBe(200); expect(content).toBe('ORIGINAL\n');
  } finally { await ctx.close(); }
});

it('copying an attachment in a real Git worktree succeeds without altering shared Git configuration', async () => {
  const ctx = await createTestApp();
  try {
    const main = join(ctx.dataDir, 'repo'), worktree = join(ctx.dataDir, 'worktree');
    await git('git', ['init', '--quiet', main]);
    await git('git', ['-C', main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
    await git('git', ['-C', main, 'worktree', 'add', '--quiet', '--detach', worktree]);
    const exclude = join(main, '.git/info/exclude'), before = await readFile(exclude);
    const workspace = ctx.store.createWorkspace('real worktree', worktree), file = await ctx.files.putBuffer(Buffer.from('PAYLOAD'), 'file.txt', 'text/plain');
    const response = await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/attach`, headers: { cookie: ctx.cookie }, payload: { fileId: file.id } });
    console.info('controlled real Git worktree copy', JSON.stringify({ status: response.statusCode, response: response.json(), gitFile: (await readFile(join(worktree, '.git'), 'utf8')).startsWith('gitdir:') }));
    expect(response.statusCode).toBe(200); expect((await readFile(exclude)).equals(before)).toBe(true);
    expect(await readFile(join(worktree, response.json().path), 'utf8')).toBe('PAYLOAD');
  } finally { await ctx.close(); }
});

it('a regular repository preserves both existing exclude bytes and permissions while copying the attachment', async () => {
  const ctx = await createTestApp();
  try {
    const root = join(ctx.dataDir, 'repo'); await git('git', ['init', '--quiet', root]);
    const exclude = join(root, '.git/info/exclude'); await writeFile(exclude, 'user-owned-rule\r\n'); await chmod(exclude, 0o640);
    const before = await readFile(exclude), info = await lstat(exclude);
    const workspace = ctx.store.createWorkspace('normal Git repo', root), file = await ctx.files.putBuffer(Buffer.from('PAYLOAD'), 'file.txt', 'text/plain');
    const response = await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/attach`, headers: { cookie: ctx.cookie }, payload: { fileId: file.id } });
    expect(response.statusCode).toBe(200); expect((await readFile(exclude)).equals(before)).toBe(true);
    expect((await lstat(exclude)).mode).toBe(info.mode); expect(await readFile(join(root, response.json().path), 'utf8')).toBe('PAYLOAD');
  } finally { await ctx.close(); }
});
