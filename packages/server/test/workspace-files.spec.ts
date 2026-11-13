import { chmod, mkdir, readFile, symlink, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { WorkspaceFiles, type FileOperation } from '../src/workspace-files.js';

let ctx: TestApp; let root: string; let workspaceId: string;
beforeEach(async () => { ctx = await createTestApp(); root = join(ctx.dataDir, 'editing'); await mkdir(root); workspaceId = ctx.store.createWorkspace('编辑测试', root).id; });
afterEach(async () => ctx.close());
const url = (): string => `/api/workspaces/${workspaceId}/fs`;
async function load(path: string) { return ctx.app.inject({ url: `${url()}?path=${encodeURIComponent(path)}`, headers: { cookie: ctx.cookie } }); }
async function save(path: string, content: string, version: string) { return ctx.app.inject({ method: 'PUT', url: url(), headers: { cookie: ctx.cookie }, payload: { path, content, version } }); }

describe('Web 文件编辑真实磁盘边界', () => {
  it('保存中文、CRLF/BOM，保留权限，并返回磁盘内容版本', async () => {
    const path = join(root, 'notes.md');
    await writeFile(path, Buffer.from('\ufeff标题\r\n原文\r\n')); await chmod(path, 0o640);
    const read = await load('notes.md'); expect(read.statusCode).toBe(200);
    const before = read.json(); expect(before).toMatchObject({ editable: true, bom: true, newline: 'crlf' });
    const result = await save('notes.md', '标题\n修改后的中文\n', before.version);
    expect(result.statusCode).toBe(200);
    expect(await readFile(path, 'utf8')).toBe('\ufeff标题\r\n修改后的中文\r\n');
    expect((await lstat(path)).mode & 0o777).toBe(0o640);
    expect(result.json().version).not.toBe(before.version);
    expect((await load('notes.md')).json().version).toBe(result.json().version);
  });
  it('外部写入和并发 API 写入不会被旧版本静默覆盖', async () => {
    await writeFile(join(root, 'a.txt'), 'old');
    const before = (await load('a.txt')).json();
    await writeFile(join(root, 'a.txt'), 'agent update');
    expect((await save('a.txt', 'browser update', before.version)).statusCode).toBe(409);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('agent update');
    const current = (await load('a.txt')).json();
    const replies = await Promise.all([save('a.txt', 'one', current.version), save('a.txt', 'two', current.version)]);
    expect(replies.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect(['one', 'two']).toContain(await readFile(join(root, 'a.txt'), 'utf8'));
  });
  it('拒绝二进制、超限、只读以及无版本覆盖', async () => {
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 255, 0]));
    await writeFile(join(root, 'large.txt'), 'x'.repeat(1024 * 1024 + 4));
    await writeFile(join(root, 'readonly.txt'), 'read only'); await chmod(join(root, 'readonly.txt'), 0o444);
    expect((await load('binary.dat')).json().editable).toBe(false);
    expect((await load('large.txt')).json()).toMatchObject({ editable: false, truncated: true });
    const readonly = (await load('readonly.txt')).json(); expect(readonly.editable).toBe(false);
    expect((await save('readonly.txt', 'overwrite', readonly.version)).statusCode).toBe(403);
    const missingVersion = await ctx.app.inject({ method: 'PUT', url: url(), headers: { cookie: ctx.cookie }, payload: { path: 'readonly.txt', content: 'overwrite' } });
    expect(missingVersion.statusCode).toBe(428);
  });
  it('认证和符号链接边界有效，工作区内的链接仍保留为链接', async () => {
    const outside = join(ctx.dataDir, 'outside.txt'); await writeFile(outside, 'outside');
    await symlink(outside, join(root, 'escape.txt'));
    const denied = await save('escape.txt', 'bad', 'a'.repeat(64)); expect(denied.statusCode).toBe(400);
    expect(await readFile(outside, 'utf8')).toBe('outside');
    await writeFile(join(root, 'real.txt'), 'old'); await symlink('real.txt', join(root, 'alias.txt'));
    const original = (await load('alias.txt')).json();
    expect((await save('alias.txt', 'new', original.version)).statusCode).toBe(200);
    expect((await lstat(join(root, 'alias.txt'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(root, 'real.txt'), 'utf8')).toBe('new');
    expect((await ctx.app.inject({ method: 'PUT', url: url(), payload: { path: 'real.txt', content: 'bad', version: original.version } })).statusCode).toBe(401);
  });
  it('文件记录使用实际修改前后指纹并保留冲突结果', async () => {
    await writeFile(join(root, 'tracked.txt'), 'old');
    const operations: FileOperation[] = [];
    const files = new WorkspaceFiles(event => operations.push(event));
    const before = await files.read(workspaceId, root, 'tracked.txt');
    const after = await files.save(workspaceId, root, 'tracked.txt', 'new', before.version as string);
    await expect(files.save(workspaceId, root, 'tracked.txt', 'stale', before.version as string)).rejects.toMatchObject({ statusCode: 409 });
    expect(operations.find(event => event.operation === 'save' && event.outcome === 'completed')).toMatchObject({ source: 'user', before: before.version, after: after.version });
    expect(operations.at(-1)?.outcome).toBe('conflict');
  });
});
