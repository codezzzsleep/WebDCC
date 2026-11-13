import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

describe('原生思考强度回填', () => {
  it('从 Codex、Claude 和 DSH 原生帧回填空记录', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wdcc-db-effort-'));
    const file = join(dir, 'webdcc.db');
    const first = openDb(file);
    first.prepare('INSERT INTO workspaces (id,name,path,created_at) VALUES (?,?,?,?)').run('w', 'w', dir, new Date().toISOString());
    const insert = first.prepare('INSERT INTO sessions (id,workspace_id,agent,reasoning_effort,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
    for (const [id, agent] of [['codex', 'codex'], ['claude', 'claude-code'], ['dsh', 'dsh']]) insert.run(id, 'w', agent, null, 'idle', new Date().toISOString(), new Date().toISOString());
    const event = first.prepare('INSERT INTO events (session_id,seq,turn_id,item_key,kind,data,native,at) VALUES (?,?,?,?,?,?,?,?)');
    const at = new Date().toISOString();
    event.run('codex', 1, '', 'i', 'internal', '{}', JSON.stringify({ thread: { reasoningEffort: 'xhigh' } }), at);
    event.run('claude', 1, '', 'i', 'internal', '{}', JSON.stringify({ type: 'system', subtype: 'init', effort: 'high' }), at);
    event.run('dsh', 1, '', 'i', 'internal', '{}', JSON.stringify({ type: 'request/header', data: { header: { config: { reasoningEffort: 'low' } } } }), at);
    first.close();
    const second = openDb(file);
    expect(second.prepare('SELECT id,reasoning_effort FROM sessions ORDER BY id').all()).toEqual([
      { id: 'claude', reasoning_effort: 'high' },
      { id: 'codex', reasoning_effort: 'xhigh' },
      { id: 'dsh', reasoning_effort: 'low' },
    ]);
    second.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('历史转交类型迁移', () => {
  it('保留手动多级关系，用作业或来源命令识别 Watchdog，并推送缓存更新', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wdcc-db-handoff-'));
    const file = join(dir, 'webdcc.db');
    const first = openDb(file);
    const store = new Store(first);
    const workspace = store.createWorkspace('w', dir);
    const root = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const child = store.createSession({ workspaceId: workspace.id, agent: 'codex', parentId: root.id });
    const grandchild = store.createSession({ workspaceId: workspace.id, agent: 'codex', parentId: child.id });
    const byJob = store.createSession({ workspaceId: workspace.id, agent: 'codex', parentId: child.id });
    const byCommand = store.createSession({ workspaceId: workspace.id, agent: 'codex', parentId: child.id });
    const untouched = store.createSession({ workspaceId: workspace.id, agent: 'codex', parentId: child.id });
    // A same-session retry must not turn a manual child into a recovery peer.
    store.appendEvent({ sessionId: grandchild.id, turnId: 'retry', itemKey: 'retry', kind: 'user.message', data: { text: '继续', clientCommandId: `watchdog:${grandchild.id}:old:1` } });
    store.appendEvent({ sessionId: byCommand.id, turnId: 'handoff', itemKey: 'handoff', kind: 'user.message', data: { text: '旧会话上下文', clientCommandId: `watchdog:${child.id}:old:2` } });
    first.prepare('INSERT INTO watchdog_jobs (session_id,data) VALUES (?,?)').run(child.id, JSON.stringify({ targetSessionId: byJob.id }));
    const oldCursor = store.appendFeed(root.id, { created: true, agent: 'codex', workspaceId: workspace.id });
    first.exec('ALTER TABLE sessions DROP COLUMN handoff_kind');
    first.close();
    const second = openDb(file);
    try {
      const migrated = new Store(second);
      expect(migrated.getSession(root.id)?.handoffKind).toBeUndefined();
      expect(migrated.getSession(child.id)).toMatchObject({ parentId: root.id, handoffKind: 'manual' });
      expect(migrated.getSession(grandchild.id)).toMatchObject({ parentId: child.id, handoffKind: 'manual' });
      expect(migrated.getSession(byJob.id)).toMatchObject({ parentId: child.id, handoffKind: 'watchdog' });
      expect(migrated.getSession(byCommand.id)).toMatchObject({ parentId: child.id, handoffKind: 'watchdog' });
      expect(migrated.getSession(untouched.id)?.handoffKind).toBe('manual');
      const patches = migrated.feedSince(oldCursor);
      expect(patches).toHaveLength(5);
      expect(patches.find(patch => patch.sessionId === byCommand.id)?.patch.handoffKind).toBe('watchdog');
      const cursor = patches.at(-1)?.feedSeq as number;
      second.close();
      const third = openDb(file);
      try {
        expect(new Store(third).feedSince(cursor)).toHaveLength(0);
        expect(new Store(third).getSession(byCommand.id)?.handoffKind).toBe('watchdog');
      } finally { third.close(); }
    } finally {
      if (second.open) second.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
