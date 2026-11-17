import { expect, it, vi } from 'vitest';
import { FeedCheckpoint } from './feed-checkpoint.js';
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
const deferred = () => { let resolve!: () => void; let reject!: (error: Error) => void; const promise = new Promise<void>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

it('serializes received snapshots and does not publish a later cursor before the earlier unit settles', async () => {
  const first = deferred(); const second = deferred(); const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const checkpoint = new FeedCheckpoint<{ id: string; title: string }>(write);
  checkpoint.record({ id: 'first', title: 'original' }, 1); await tick();
  checkpoint.record({ id: 'second', title: 'next' }, 9); await tick();
  expect(write).toHaveBeenCalledTimes(1); expect(checkpoint.cursor()).toBe(0); first.resolve(); await tick();
  expect(write).toHaveBeenCalledTimes(2); expect(checkpoint.cursor()).toBe(1); second.resolve(); await tick(); expect(checkpoint.cursor()).toBe(9);
});

it('failed earlier state joins newer received sessions and cannot be skipped by their commit', async () => {
  const first = deferred(); const second = deferred(); const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const checkpoint = new FeedCheckpoint<{ id: string; title: string; nativeId?: string }>(write);
  checkpoint.record({ id: 'first', title: 'original', nativeId: 'original-native' }, 1); await tick(); checkpoint.record({ id: 'second', title: 'new' }, 4);
  first.reject(new Error('IDB abort')); await tick(); expect(checkpoint.cursor()).toBe(0);
  expect(write).toHaveBeenLastCalledWith([{ id: 'first', title: 'original', nativeId: 'original-native' }, { id: 'second', title: 'new' }], 4);
  second.resolve(); await tick(); expect(checkpoint.cursor()).toBe(4);
});

it('a lone failure preserves state without a retry loop, and the next patch repairs all affected sessions', async () => {
  const write = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValue(undefined); const checkpoint = new FeedCheckpoint<{ id: string; title: string }>(write);
  checkpoint.record({ id: 'first', title: 'original' }, 1); await tick(); await tick(); expect(write).toHaveBeenCalledTimes(1); expect(checkpoint.cursor()).toBe(0);
  checkpoint.record({ id: 'second', title: 'later' }, 6); await tick();
  expect(write).toHaveBeenLastCalledWith([{ id: 'first', title: 'original' }, { id: 'second', title: 'later' }], 6); expect(checkpoint.cursor()).toBe(6);
});

it('newer full state for the same session preserves opaque native fields when replacing a failed snapshot', async () => {
  const first = deferred(); const write = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
  const checkpoint = new FeedCheckpoint<{ id: string; title: string; native: { opaque: unknown }; providerId: string | null }>(write);
  checkpoint.record({ id: 's', title: 'old', native: { opaque: [2, 1] }, providerId: null }, 1); await tick();
  checkpoint.record({ id: 's', title: 'new', native: { opaque: false }, providerId: null }, 3); first.reject(new Error('abort')); await tick();
  expect(write).toHaveBeenLastCalledWith([{ id: 's', title: 'new', native: { opaque: false }, providerId: null }], 3); expect(checkpoint.cursor()).toBe(3);
});

it('ten identical replays preserve one cached state and do not move the cursor until the transaction succeeds', async () => {
  const result = deferred(); const write = vi.fn().mockReturnValue(result.promise); const checkpoint = new FeedCheckpoint<{ id: string; title: string }>(write);
  for (let i = 0; i < 10; i++) checkpoint.record({ id: 's', title: 'original' }, 7); await tick(); expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith([{ id: 's', title: 'original' }], 7); expect(checkpoint.cursor()).toBe(0); result.resolve(); await tick(); expect(checkpoint.cursor()).toBe(7);
});

it('invalid cursors never certify a checkpoint and valid source gaps are not interpreted as missing numeric IDs', async () => {
  const write = vi.fn().mockResolvedValue(undefined); const checkpoint = new FeedCheckpoint<{ id: string }>(write);
  checkpoint.restore('100'); checkpoint.restore(-1); checkpoint.restore(NaN); expect(checkpoint.cursor()).toBe(0);
  checkpoint.restore(10); checkpoint.record({ id: 'old' }, 8); checkpoint.record({ id: 'invalid' }, -1); checkpoint.record({ id: 'next' }, 100); await tick();
  expect(write).toHaveBeenCalledTimes(1); expect(checkpoint.cursor()).toBe(100); checkpoint.restore(1); expect(checkpoint.cursor()).toBe(100);
});

it('captures received snapshot values rather than a later mutation of the caller object', async () => {
  const write = vi.fn().mockResolvedValue(undefined); const checkpoint = new FeedCheckpoint<{ id: string; value: { native: string } }>(write);
  const value = { id: 's', value: { native: 'original' } }; checkpoint.record(value, 1); value.value.native = 'mutated'; await tick();
  expect(write).toHaveBeenCalledWith([{ id: 's', value: { native: 'original' } }], 1);
});
