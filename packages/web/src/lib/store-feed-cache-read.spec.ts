import { expect, it, vi } from 'vitest';
import type { SyncConnectionOptions } from './connection.js';
const mocks = vi.hoisted(() => ({ options: [] as SyncConnectionOptions[], getSessions: vi.fn(), getMeta: vi.fn(), getFeedCheckpoint: vi.fn(), start: vi.fn() }));
vi.mock('./connection.js', () => ({ SyncConnection: class {
  constructor(options: SyncConnectionOptions) { mocks.options.push(options); } start = mocks.start;
} }));
vi.mock('./api.js', () => ({ api: {} }));
vi.mock('./db.js', () => ({ cache: { getSessions: mocks.getSessions, getMeta: mocks.getMeta, getFeedCheckpoint: mocks.getFeedCheckpoint } }));
import { AppStore } from './store.js';

it('startup cannot advertise a newer writer checkpoint with the older cached session list', async () => {
  let currentSequence = 2;
  mocks.getSessions.mockImplementation(async () => {
    // The returned read is from checkpoint 2; a second writer commits 4
    // before AppStore starts its separate meta transactions.
    currentSequence = 4;
    return [{ id: 'older-session', workspaceId: 'original', agent: 'codex', status: 'idle', updatedAt: '2026-11-17' }];
  });
  mocks.getMeta.mockImplementation(async key => key === 'feedSeq' ? currentSequence : { formatVersion: 1, feedSeq: currentSequence });
  mocks.getFeedCheckpoint.mockImplementation(async () => {
    const feedSeq = currentSequence;
    const sessions = await mocks.getSessions();
    return { sessions, feedSeq, checkpoint: { formatVersion: 1, feedSeq } };
  });
  vi.stubGlobal('document', { addEventListener: vi.fn(), visibilityState: 'visible' });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  try {
    const store = new AppStore(); await store.init();
    expect(store.getSession('older-session')).toBeDefined();
    expect(store.getSession('newer-session')).toBeUndefined();
    expect(mocks.options.at(-1)!.getFeedAfter()).toBe(2);
  } finally { vi.unstubAllGlobals(); }
});

it('a failed checkpoint read starts replay from zero without certifying a separately readable cursor', async () => {
  mocks.getFeedCheckpoint.mockRejectedValue(new Error('readonly transaction aborted'));
  mocks.getMeta.mockResolvedValue(100);
  vi.stubGlobal('document', { addEventListener: vi.fn(), visibilityState: 'visible' });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  try {
    const store = new AppStore(); await store.init();
    expect(mocks.options.at(-1)!.getFeedAfter()).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});
