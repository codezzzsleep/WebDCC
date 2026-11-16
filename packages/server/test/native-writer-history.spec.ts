import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CreateOpts } from '@webdcc/protocol';
import { FakeAdapter } from '../../testing/fake-adapter/src/index.js';
import { createTestApp, type TestApp } from './helpers.js';
import { processState } from '../src/process-identity.js';

type Page = { data: { status: string; itemsView: string }[]; nextCursor: string | null };
const full = (count: number): Page['data'] => Array.from({ length: count }, () => ({ status: 'completed', itemsView: 'full' }));
class HistoryAdapter extends FakeAdapter {
  child?: ChildProcess;
  calls: { cursor?: string; limit: number }[] = [];
  pages: (Page | Error)[] = [{ data: full(100), nextCursor: null }];
  stateReads = 0;
  activeAfterHistory = false;
  constructor() { super({ id: 'codex' }); }
  override async create(opts: CreateOpts) {
    const result = await super.create(opts);
    this.child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(this.child, 'spawn');
    opts.onManagedProcess?.(this.child.pid!, opts.cwd, '0.169.0');
    return result;
  }
  async nativeState() {
    const active = this.activeAfterHistory && ++this.stateReads > 1;
    return { turnActive: active, thread: { status: { type: active ? 'active' : 'idle' } }, permissions: { effective: 'read-only' } };
  }
  async readNativeHistory(_sessionId: string, options: { cursor?: string; limit: number }) {
    this.calls.push(options);
    const page = this.pages[this.calls.length - 1];
    if (!page) throw new Error('Unexpected extra native history page');
    if (page instanceof Error) throw page;
    return page;
  }
  override async dispose(sessionId: string) {
    if (this.child?.exitCode === null && this.child.signalCode === null) {
      const exited = once(this.child, 'exit'); this.child.kill('SIGTERM'); await exited;
    }
    await super.dispose(sessionId);
  }
}
let ctx: TestApp;
let adapter: HistoryAdapter;
let sessionId: string;
beforeEach(async () => {
  adapter = new HistoryAdapter(); ctx = await createTestApp(); ctx.manager.registerAdapter(adapter);
  const workspace = ctx.store.createWorkspace('history fixture', ctx.dataDir);
  sessionId = (await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' })).id;
});
afterEach(async () => ctx.close());

it.each([100, 101, 201])('releases the actual managed process only after all %i historical turns are complete', async count => {
  adapter.pages = Array.from({ length: Math.ceil(count / 100) }, (_, index) => ({ data: full(Math.min(100, count - index * 100)), nextCursor: index + 1 < Math.ceil(count / 100) ? `opaque-page-${index + 1}` : null }));
  const result = await ctx.manager.releaseNativeWriter(sessionId);
  expect(adapter.calls.map(call => call.cursor ?? null)).toEqual(Array.from({ length: Math.ceil(count / 100) }, (_, index) => index === 0 ? null : `opaque-page-${index}`));
  expect(adapter.calls.every(call => call.limit === 200)).toBe(true);
  expect(processState(result.previousProcess)).toBe('exited');
  expect(ctx.manager.getRuntime(sessionId)).toBeUndefined();
});

it.each(['inProgress', 'partial', 'unreadable', 'cycle'])('preserves the running writer when a later native page is %s', async failure => {
  adapter.pages = [{ data: full(100), nextCursor: 'next' }, failure === 'unreadable' ? new Error('native page unavailable') : {
    data: [{ status: failure === 'inProgress' ? 'inProgress' : 'completed', itemsView: failure === 'partial' ? 'summary' : 'full' }], nextCursor: failure === 'cycle' ? 'next' : null,
  }];
  await expect(ctx.manager.releaseNativeWriter(sessionId)).rejects.toThrow();
  expect(adapter.calls).toHaveLength(2);
  expect(processState(ctx.store.nativeOwners.managedProcess(sessionId))).toBe('running');
  expect(ctx.manager.getRuntime(sessionId)).toBeDefined();
});

it('rechecks native idle state after pagination before disposing the current writer', async () => {
  adapter.pages = [{ data: full(100), nextCursor: 'next' }, { data: full(1), nextCursor: null }];
  adapter.activeAfterHistory = true;
  await expect(ctx.manager.releaseNativeWriter(sessionId)).rejects.toThrow('原生工作或权限状态未确认');
  expect(processState(ctx.store.nativeOwners.managedProcess(sessionId))).toBe('running');
});
