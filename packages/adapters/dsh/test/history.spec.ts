import { expect, it, vi } from 'vitest';
import { DshHistoryBridge, type DshOpening } from '../src/history.js';
import type { DshHistoryRecord, DshPage } from '../src/contracts.js';

const record = (seq: number): DshHistoryRecord => ({ type: 'event', event: { type: 'user/message', seq, time: 1000 + seq, data: { content: [{ type: 'text', text: `message ${seq}` }], source: { kind: 'user' } } } });
const opening = (records: DshHistoryRecord[], hasMore = false): DshOpening => ({ type: 'snapshot', header: { id: 'native' }, cursor: records.at(-1)?.event.seq ?? -1, records, hasMore });

it('NP-10 pins the native opening cut, fills the whole outage, then publishes buffered live events', async () => {
  let resolvePage!: (page: DshPage) => void;
  const page = vi.fn(() => new Promise<DshPage>(resolve => { resolvePage = resolve; }));
  const seen: number[] = [];
  let ready = 0;
  const bridge = new DshHistoryBridge('native', page, record => seen.push(record.event.seq), () => { ready++; }, error => { throw error; });
  bridge.opening(opening([record(0), record(1)]));
  expect(bridge.lastSeq).toBe(1);
  bridge.invalidate();
  bridge.opening(opening([record(4), record(5)], true));
  bridge.event(record(6));
  expect(seen).toEqual([0, 1]);
  expect(page).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: 'native' }, throughSeq: 5, beforeSeq: 4, maxMessages: 200 });
  resolvePage({ cursor: 5, hasMore: false, records: [record(0), record(1), record(2), record(3)] });
  await vi.waitFor(() => expect(ready).toBe(2));
  expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
  bridge.event(record(5));
  expect(seen).toHaveLength(7);
  expect(bridge.lastSeq).toBe(6);
});

it('NP-10 retains the old waterline after a failed page and retries the missing range', async () => {
  let failed = true;
  const errors: Error[] = [];
  const seen: number[] = [];
  const bridge = new DshHistoryBridge('native', async () => { if (failed) throw new Error('offline'); return { cursor: 3, records: [record(0), record(1), record(2)], hasMore: false }; }, record => seen.push(record.event.seq), () => undefined, error => errors.push(error));
  bridge.opening(opening([record(0)]));
  bridge.opening(opening([record(3)], true));
  await vi.waitFor(() => expect(errors).toHaveLength(1));
  bridge.event(record(4));
  expect(seen).toEqual([0]);
  expect(bridge.lastSeq).toBe(0);
  failed = false;
  bridge.opening(opening([record(3), record(4)], true));
  await vi.waitFor(() => expect(bridge.lastSeq).toBe(4));
  expect(seen).toEqual([0, 1, 2, 3, 4]);
});

it('NP-10 ignores pages completing after disposal or a newer opening', async () => {
  let resolvePage!: (page: DshPage) => void;
  const seen: number[] = [];
  const bridge = new DshHistoryBridge('native', () => new Promise(resolve => { resolvePage = resolve; }), record => seen.push(record.event.seq), () => undefined, error => { throw error; });
  bridge.opening(opening([record(3)], true));
  bridge.invalidate();
  bridge.opening(opening([record(0)]));
  resolvePage({ cursor: 3, records: [record(0), record(1), record(2)], hasMore: false });
  await Promise.resolve();
  expect(seen).toEqual([0]);
  expect(bridge.lastSeq).toBe(0);
});

it('NP-10 rejects changed Host/session identity and non-progressing pages without advancing', async () => {
  const errors: Error[] = [];
  const seen: number[] = [];
  const bridge = new DshHistoryBridge('native', async () => ({ cursor: 4, hasMore: true, records: [record(4)] }), record => seen.push(record.event.seq), () => undefined, error => errors.push(error));
  bridge.opening({ ...opening([record(0)]), header: { id: 'other' } });
  expect(errors[0]?.message).toContain('身份');
  bridge.opening(opening([record(4)], true));
  await vi.waitFor(() => expect(errors).toHaveLength(2));
  expect(bridge.lastSeq).toBe(-1);
  expect(seen).toEqual([]);
});

it('NP-10 rolls back the covered cursor if the durable consumer rejects the batch', () => {
  const errors: Error[] = [];
  const bridge = new DshHistoryBridge('native', async () => { throw new Error('unexpected page'); }, () => undefined, () => { throw new Error('disk full'); }, error => errors.push(error));
  bridge.opening(opening([record(0)]));
  expect(errors[0]?.message).toBe('disk full');
  expect(bridge.lastSeq).toBe(-1);
});
