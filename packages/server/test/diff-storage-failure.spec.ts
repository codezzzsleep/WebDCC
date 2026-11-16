import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterEvent, EventData } from '@webdcc/protocol';
import { buildFileChanges, reduceTurn } from '@webdcc/protocol';

const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mock.query }));
import { ClaudeAdapter } from '../../adapters/claude/src/adapter.js';
import { FakeAdapter } from '@webdcc/fake-adapter';
import { SessionManager } from '../src/manager.js';
import { createTestApp } from './helpers.js';

afterEach(() => mock.query.mockReset());

function queryController() {
  const messages: (Record<string, unknown> | Error | 'end')[] = [{ type: 'system', subtype: 'init', session_id: 'native', permissionMode: 'default', slash_commands: [] }];
  let wake: (() => void) | undefined, ended = false;
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          const message = messages.shift();
          if (message === 'end') return;
          if (message instanceof Error) throw message;
          if (message !== undefined) yield message as unknown as SDKMessage;
          else await new Promise<void>(resolve => { wake = resolve; });
        }
      } finally { ended = true; }
    },
    close() { messages.push('end'); wake?.(); },
    push(message: Record<string, unknown> | Error) { messages.push(message); wake?.(); },
    ended: () => ended,
  };
}

it('a real diff-storage exception preserves the native SDK file result and lets later SDK output finish', async () => {
  const ctx = await createTestApp(), q = queryController();
  mock.query.mockReturnValue(q as unknown as Query);
  const saveDiff = vi.fn((name: string, diff: string) => ctx.files.putBufferSync(Buffer.from(diff), name, 'text/x-diff').id);
  const manager = new SessionManager(ctx.store, { idleDisposeMin: 0, saveDiff });
  const adapter = new ClaudeAdapter(), emitted: AdapterEvent[] = [];
  adapter.onEvent((_id, event) => emitted.push(event)); manager.registerAdapter(adapter);
  try {
    const input = { file_path: 'note.txt', old_string: 'before\n', new_string: 'after\n' };
    const original = buildFileChanges('Edit', input)[0]!;
    const hash = createHash('sha256').update(original.diff!).digest('hex');
    await writeFile(dirname(ctx.files.objectPath(hash)), 'controlled non-directory CAS prefix');
    const workspace = ctx.store.createWorkspace('diff failure', ctx.dataDir);
    const session = await manager.createSession({ workspaceId: workspace.id, agent: 'claude-code', accessMode: 'default' });
    await vi.waitFor(() => expect(ctx.store.getSession(session.id)?.nativeId).toBe('native'));
    await manager.send(session.id, { text: 'controlled original input' }, 'DIFF-STORAGE-INPUT');
    q.push({ type: 'assistant', session_id: 'native', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'edit-tool', name: 'Edit', input }] } });
    q.push({ type: 'user', session_id: 'native', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'edit-tool', content: 'controlled reported success' }] } });
    q.push({ type: 'assistant', session_id: 'native', parent_tool_use_id: null, message: { id: 'after-storage', content: [{ type: 'text', text: 'output after storage failure' }] } });
    q.push({ type: 'result', subtype: 'success', session_id: 'native', is_error: false, result: 'output after storage failure' });
    await vi.waitFor(() => expect(q.ended() || ctx.store.allEvents(session.id).some(event => event.kind === 'turn.completed')).toBe(true), { timeout: 5000 });
    const stored = ctx.store.allEvents(session.id), changes = stored.filter(event => event.kind === 'file.change');
    console.info('controlled SDK storage failure', JSON.stringify({ sdkQueryMock: true, actualFilesystemFailure: true, sdkEnded: q.ended(), emittedFileCompletions: emitted.filter(event => event.type === 'item.complete' && event.kind === 'file.change').length, storedFileChanges: changes.length, emittedSdkErrors: emitted.filter(event => event.type === 'item.complete' && event.kind === 'error').length, storedCompletions: stored.filter(event => event.kind === 'turn.completed').map(event => event.data), realNativeToolTriggered: false }));
    expect(saveDiff).toHaveBeenCalledOnce();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.data).toMatchObject({ status: 'completed', changes: [{ path: 'note.txt', diff: original.diff, note: expect.stringContaining('未保存') }] });
    expect((changes[0]!.data as EventData['file.change']).changes[0]!.diffFileId).toBeUndefined();
    expect(reduceTurn(stored.filter(event => event.turnId === changes[0]!.turnId)).changes).toMatchObject([{ path: 'note.txt', note: expect.stringContaining('未保存') }]);
    expect(emitted.some(event => event.type === 'item.complete' && event.kind === 'error')).toBe(false);
    expect(stored.some(event => event.kind === 'assistant.message' && (event.data as EventData['assistant.message']).text === 'output after storage failure')).toBe(true);
    expect(stored.some(event => event.kind === 'turn.completed' && (event.data as EventData['turn.completed']).status === 'completed')).toBe(true);
    expect(q.ended()).toBe(false);
  } finally { await manager.disposeAll(); await ctx.close(); }
});

it('one failed diff keeps its source and native note while other diffs and changes without diff still persist normally', async () => {
  const ctx = await createTestApp(), adapter = new FakeAdapter({ id: 'codex' });
  let feed!: (sessionId: string, event: AdapterEvent) => void;
  const register = adapter.onEvent.bind(adapter);
  vi.spyOn(adapter, 'onEvent').mockImplementation(callback => { feed = callback; register(callback); });
  const saveDiff = vi.fn((name: string, diff: string) => {
    if (name === 'failed.txt.diff') throw new Error('PRIVATE-DIAGNOSTIC-FIXTURE');
    return ctx.files.putBufferSync(Buffer.from(diff), name, 'text/x-diff').id;
  });
  const manager = new SessionManager(ctx.store, { idleDisposeMin: 0, saveDiff }); manager.registerAdapter(adapter);
  try {
    const workspace = ctx.store.createWorkspace('mixed diffs', ctx.dataDir), session = await manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const failed = { ...buildFileChanges('Edit', { file_path: 'failed.txt', old_string: 'old', new_string: 'new' })[0]!, note: 'Original native note' };
    const successful = buildFileChanges('Write', { file_path: 'saved.txt', content: 'new content' })[0]!;
    const noDiff = { path: 'without-diff.txt', kind: 'modify' as const, added: 0, removed: 0 };
    const source = { changes: [failed, successful, noDiff], status: 'completed' as const };
    expect(() => feed(session.id, { type: 'item.complete', scope: 'session', itemKey: 'mixed-native-result', kind: 'file.change', data: source })).not.toThrow();
    expect(saveDiff).toHaveBeenCalledTimes(2);
    const stored = ctx.store.allEvents(session.id).find(event => event.kind === 'file.change')!;
    const changes = (stored.data as EventData['file.change']).changes;
    expect(changes[0]).toMatchObject({ ...failed, note: 'Original native note\nWebDCC：差异文本未保存' });
    expect(changes[0]!.diffFileId).toBeUndefined();
    expect(changes[1]).toMatchObject({ path: successful.path, note: successful.note, diffFileId: expect.any(String) });
    expect(changes[1]!.diff).toBeUndefined();
    expect((await ctx.files.readAll(changes[1]!.diffFileId!))?.buffer.toString()).toBe(successful.diff);
    expect(changes[2]).toEqual(noDiff);
    expect(source.changes).toEqual([failed, successful, noDiff]);
    expect(JSON.stringify(stored)).not.toContain('PRIVATE-DIAGNOSTIC-FIXTURE');
  } finally { await manager.disposeAll(); await ctx.close(); }
});

it('a real SDK iterator error retains its original failure path and never calls diff storage', async () => {
  const ctx = await createTestApp(), q = queryController(); mock.query.mockReturnValue(q as unknown as Query);
  const saveDiff = vi.fn(() => 'unused');
  const manager = new SessionManager(ctx.store, { idleDisposeMin: 0, saveDiff }); manager.registerAdapter(new ClaudeAdapter());
  try {
    const workspace = ctx.store.createWorkspace('SDK error', ctx.dataDir), session = await manager.createSession({ workspaceId: workspace.id, agent: 'claude-code', accessMode: 'default' });
    q.push(new Error('controlled SDK transport failure'));
    await vi.waitFor(() => expect(ctx.store.allEvents(session.id).some(event => event.kind === 'error')).toBe(true));
    expect(saveDiff).not.toHaveBeenCalled(); expect(q.ended()).toBe(true);
    expect(ctx.store.allEvents(session.id).some(event => event.kind === 'error' && (event.data as EventData['error']).message === 'controlled SDK transport failure')).toBe(true);
    expect(ctx.store.allEvents(session.id).some(event => event.kind === 'turn.completed')).toBe(false);
  } finally { await manager.disposeAll(); await ctx.close(); }
});
