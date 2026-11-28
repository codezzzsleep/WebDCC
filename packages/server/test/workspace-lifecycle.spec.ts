import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it.each(['codex', 'claude-code', 'dsh'])('%s workspace archive preserves running sessions, native IDs, history, individual archives and drafts', async agent => {
  const ctx = await createTestApp(); cleanup.push(() => ctx.close());
  const { workspaceId, sessionId } = await seedWorkspaceAndSession(ctx, agent);
  const workspace = ctx.store.getWorkspace(workspaceId)!;
  const file = join(workspace.path, 'keep.md'); await writeFile(file, 'exact\r\n文件字节');
  const other = ctx.store.createSession({ workspaceId, agent: agent as 'codex' });
  ctx.store.updateSession(other.id, { archived: true });
  ctx.store.appendEvent({ sessionId, turnId: 'real-boundary', itemKey: 'text', kind: 'assistant.message', data: { text: '保留历史' } });
  ctx.store.updateSession(sessionId, { status: 'running' });
  const headers = { cookie: ctx.cookie };
  expect((await ctx.app.inject({ method: 'PUT', url: `/api/sessions/${sessionId}/draft`, headers, payload: {
    text: '保留草稿', fileIds: [], expectedRevision: 0, contentParts: { version: 1, parts: [{ type: 'text', text: '保留草稿' }] },
  } })).statusCode).toBe(200);
  const before = ctx.store.getSession(sessionId);
  const events = ctx.store.allEvents(sessionId);
  const patch = (archived: boolean) => ctx.app.inject({ method: 'PATCH', url: `/api/workspaces/${workspaceId}`, headers, payload: { archived } });
  expect((await patch(true)).json()).toMatchObject({ id: workspaceId, archived: true });
  expect(ctx.store.getSession(sessionId)).toEqual(before);
  expect(ctx.store.getSession(other.id)?.archived).toBe(true);
  expect(ctx.store.allEvents(sessionId)).toEqual(events);
  expect((await ctx.app.inject({ url: `/api/sessions/${sessionId}/draft`, headers })).json()).toMatchObject({ text: '保留草稿' });
  expect(await readFile(file, 'utf8')).toBe('exact\r\n文件字节');
  await expect(ctx.manager.createSession({ workspaceId, agent: agent as 'codex' })).rejects.toMatchObject({ statusCode: 409 });
  // Existing native work can still publish a newly observed child after its
  // local workspace group has been hidden.
  expect(ctx.store.createSession({ workspaceId, agent: agent as 'codex', parentId: sessionId }).parentId).toBe(sessionId);
  expect((await ctx.app.inject({ method: 'DELETE', url: `/api/workspaces/${workspaceId}`, headers })).statusCode).toBe(409);
  expect((await patch(false)).statusCode).toBe(200);
  expect(ctx.store.getWorkspace(workspaceId)?.archived).not.toBe(true);
  expect(ctx.store.getSession(sessionId)).toEqual(before);
});

it('removes an empty association idempotently, keeps the directory, and re-adding an archived directory restores its identity', async () => {
  const ctx = await createTestApp(); cleanup.push(() => ctx.close());
  const workspace = ctx.store.createWorkspace('项目', ctx.dataDir);
  const file = join(ctx.dataDir, 'project.txt'); await writeFile(file, 'keep');
  const headers = { cookie: ctx.cookie };
  ctx.store.archiveWorkspace(workspace.id, true);
  const readded = await ctx.app.inject({ method: 'POST', url: '/api/workspaces', headers, payload: { name: 'new name', path: workspace.path } });
  expect(readded.json()).toMatchObject({ id: workspace.id, name: '项目' });
  expect(ctx.store.getWorkspace(workspace.id)?.archived).not.toBe(true);
  for (let i = 0; i < 2; i++) expect((await ctx.app.inject({ method: 'DELETE', url: `/api/workspaces/${workspace.id}`, headers })).statusCode).toBe(204);
  expect(ctx.store.getWorkspace(workspace.id)).toBeUndefined();
  expect(await readFile(file, 'utf8')).toBe('keep');
});

it('counts archived sessions and refuses stale empty-workspace removal after a session is created', async () => {
  const ctx = await createTestApp(); cleanup.push(() => ctx.close());
  const workspace = ctx.store.createWorkspace('项目', ctx.dataDir);
  expect(ctx.store.listWorkspaces()[0]?.sessionCount).toBe(0);
  const session = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
  ctx.store.updateSession(session.id, { archived: true });
  expect(() => ctx.store.removeEmptyWorkspace(workspace.id)).toThrow('仍有会话');
  expect(ctx.store.listWorkspaces()[0]?.sessionCount).toBe(1);
  expect(ctx.store.getSession(session.id)).toBeDefined();
});

it('migrates existing v16 workspaces as active and retains archive state after reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-migrate-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'db');
  const before = openDb(file); const store = new Store(before);
  const workspace = store.createWorkspace('旧项目', dir);
  const session = store.createSession({ workspaceId: workspace.id, agent: 'dsh' });
  before.exec('ALTER TABLE workspaces DROP COLUMN archived'); before.pragma('user_version = 16'); before.close();
  const after = openDb(file);
  expect(new Store(after).getWorkspace(workspace.id)?.archived).not.toBe(true);
  new Store(after).archiveWorkspace(workspace.id, true); after.close();
  const reopened = openDb(file);
  try {
    expect(new Store(reopened).getWorkspace(workspace.id)).toMatchObject({ archived: true });
    expect(new Store(reopened).getSession(session.id)).toBeDefined();
  } finally { reopened.close(); }
});
