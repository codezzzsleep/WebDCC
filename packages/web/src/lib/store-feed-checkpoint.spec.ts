import { expect, it, vi } from 'vitest';
import type { SyncConnectionOptions } from './connection.js';
const mocks = vi.hoisted(() => ({ options: [] as SyncConnectionOptions[], putSession: vi.fn(), setMeta: vi.fn(), putFeedCheckpoint: vi.fn(), getSessions: vi.fn(), getMeta: vi.fn(), start: vi.fn() }));
vi.mock('./connection.js', () => ({ SyncConnection: class {
  constructor(options: SyncConnectionOptions) { mocks.options.push(options); } start = mocks.start; subscribe() {} unsubscribe() {} sendCommand() {}
} }));
vi.mock('./api.js', () => ({ api: {} }));
vi.mock('./db.js', () => ({ cache: { putSession: mocks.putSession, setMeta: mocks.setMeta, putFeedCheckpoint: mocks.putFeedCheckpoint, getSessions: mocks.getSessions, getMeta: mocks.getMeta } }));
import { AppStore } from './store.js';

it('a received feed patch cannot become the reconnect checkpoint before its session state commits', async () => {
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  mocks.putSession.mockReturnValue(pending); mocks.setMeta.mockResolvedValue(undefined); mocks.putFeedCheckpoint.mockReturnValue(pending);
  const store = new AppStore(); const connection = mocks.options.at(-1)!;
  try {
    connection.onMessage({ op: 'feed', feedSeq: 1, sessionId: 'original-session', patch: { created: true, agent: 'codex', workspaceId: 'original-workspace', title: 'original title' } });
    expect(store.getSession('original-session')?.title).toBe('original title');
    expect(connection.getFeedAfter()).toBe(0);
    release(); await new Promise(resolve => setTimeout(resolve, 0)); expect(connection.getFeedAfter()).toBe(1);
  } finally { release(); }
});

it.each(['legacy', 'valid', 'wrong-version', 'wrong-sequence', 'empty-cache', 'invalid-sequence'] as const)('%s cached checkpoint is trusted only with an atomic marker and available session state', async kind => {
  const sequence = kind === 'invalid-sequence' ? -10 : 10;
  const checkpoint = kind === 'legacy' ? undefined : { formatVersion: kind === 'wrong-version' ? 99 : 1, feedSeq: kind === 'wrong-sequence' ? 9 : sequence };
  mocks.getSessions.mockResolvedValue(kind === 'empty-cache' ? [] : [{ id: 'cached-session', workspaceId: 'original', agent: 'codex', title: 'original title', status: 'idle', updatedAt: '2026-11-17' }]);
  mocks.getMeta.mockImplementation(async key => key === 'feedSeq' ? sequence : checkpoint); mocks.putFeedCheckpoint.mockResolvedValue(undefined);
  vi.stubGlobal('document', { addEventListener: vi.fn(), visibilityState: 'visible' }); vi.stubGlobal('window', { addEventListener: vi.fn() });
  try {
    const store = new AppStore(); await store.init(); const connection = mocks.options.at(-1)!;
    expect(connection.getFeedAfter()).toBe(kind === 'valid' ? 10 : 0);
    if (kind !== 'empty-cache') expect(store.getSession('cached-session')?.title).toBe('original title');
  } finally { vi.unstubAllGlobals(); }
});

it('same-page replay after a failed checkpoint cannot roll back model/native identity and can persist the already received state', async () => {
  mocks.putFeedCheckpoint.mockRejectedValue(new Error('transaction failed'));
  const store = new AppStore(); const connection = mocks.options.at(-1)!;
  const first = { op: 'feed' as const, feedSeq: 1, sessionId: 'replay-session', patch: { created: true, agent: 'codex' as const, workspaceId: 'original', model: 'old-model', nativeId: 'old-native' } };
  connection.onMessage(first); await new Promise(resolve => setTimeout(resolve, 0));
  connection.onMessage({ ...first, feedSeq: 2, patch: { model: 'current-model', nativeId: 'current-native' } }); await new Promise(resolve => setTimeout(resolve, 0));
  expect(connection.getFeedAfter()).toBe(0); mocks.putFeedCheckpoint.mockResolvedValue(undefined);
  connection.onMessage(first); await new Promise(resolve => setTimeout(resolve, 0));
  expect(store.getSession('replay-session')).toMatchObject({ model: 'current-model', nativeId: 'current-native' });
  expect(connection.getFeedAfter()).toBe(2);
});

it.each(['codex', 'claude-code', 'dsh'] as const)('%s replay preserves current permissions and unread state while repairing its failed checkpoint', async agent => {
  mocks.putFeedCheckpoint.mockRejectedValue(new Error('transaction failed'));
  const store = new AppStore(); const connection = mocks.options.at(-1)!;
  const originalPermissions = { requested: null, effective: null, phase: 'inherit' as const, revision: 1 };
  const currentPermissions = { requested: null, effective: 'native-observation', phase: 'observed' as const, revision: 9, policy: { opaque: [false, 0, 'original'] } };
  connection.onMessage({ op: 'feed', feedSeq: 1, sessionId: agent, patch: { created: true, agent, status: 'idle', model: 'old', nativeId: 'old-native', permissions: originalPermissions } });
  await new Promise(resolve => setTimeout(resolve, 0));
  const waiting = { op: 'feed' as const, feedSeq: 2, sessionId: agent, patch: { status: 'waiting' as const, model: 'old', nativeId: 'old-native', permissions: originalPermissions } };
  connection.onMessage(waiting); await new Promise(resolve => setTimeout(resolve, 0));
  connection.onMessage({ op: 'feed', feedSeq: 3, sessionId: agent, patch: { status: 'running', model: 'current', nativeId: 'current-native', permissions: currentPermissions } });
  await new Promise(resolve => setTimeout(resolve, 0)); expect(store.unread.get(agent)).toBe(1);
  mocks.putFeedCheckpoint.mockResolvedValue(undefined);
  for (let i = 0; i < 10; i++) connection.onMessage(waiting);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(store.getSession(agent)).toMatchObject({ agent, status: 'running', model: 'current', nativeId: 'current-native', permissions: currentPermissions });
  expect(store.unread.get(agent)).toBe(1); expect(connection.getFeedAfter()).toBe(3);
  expect(mocks.putFeedCheckpoint).toHaveBeenLastCalledWith([expect.objectContaining({ id: agent, nativeId: 'current-native', permissions: currentPermissions })], 3);
});
