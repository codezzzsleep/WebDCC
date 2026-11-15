import { expect, it } from 'vitest';
import { CodexAdapter } from '../src/adapter.js';

it('ordinary resume scans finite long native history without imposing a new 500-turn limit', async () => {
  const native = CodexAdapter.replay('history', 'native');
  const adapter = native.adapter as unknown as { sessions: Map<string, { rpc: { request: () => Promise<unknown> } }>; restoreAsyncQuestions: (id: string, runtime: unknown) => Promise<void> };
  const runtime = adapter.sessions.get('history')!;
  let pages = 0;
  runtime.rpc.request = async () => ({ data: Array.from({ length: 100 }, (_, index) => ({ id: `turn-${pages}-${index}`, rootTurnId: null, items: [], itemsView: 'full',
    status: 'completed', error: null, startedAt: 1, completedAt: 2, durationMs: 1000 })), nextCursor: ++pages < 7 ? `page-${pages}` : null, backwardsCursor: null });
  await expect(adapter.restoreAsyncQuestions('history', runtime)).resolves.toBeUndefined();
  expect(pages).toBe(7);
});

it('rejects cyclic native history cursors rather than silently claiming complete question recovery', async () => {
  const native = CodexAdapter.replay('history', 'native');
  const adapter = native.adapter as unknown as { sessions: Map<string, { rpc: { request: () => Promise<unknown> } }>; restoreAsyncQuestions: (id: string, runtime: unknown) => Promise<void> };
  const runtime = adapter.sessions.get('history')!;
  runtime.rpc.request = async () => ({ data: [], nextCursor: 'cycle', backwardsCursor: null });
  await expect(adapter.restoreAsyncQuestions('history', runtime)).rejects.toMatchObject({ code: 'uncertain' });
});
