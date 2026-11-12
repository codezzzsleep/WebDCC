import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';

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
