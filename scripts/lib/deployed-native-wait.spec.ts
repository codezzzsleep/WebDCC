import { expect, it } from 'vitest';
import { waitForNativeTurn, waitForNativeReceipts } from '../deployed-native-wait.mjs';

const user = { seq: 1, kind: 'user.message', turnId: 'target', data: { text: 'original input' } };
const done = { seq: 4, kind: 'turn.completed', turnId: 'target', data: { status: 'completed' } };
function clock() { let time = 0; return { now: () => time, sleep: async (ms: number) => { time += ms; } }; }

it('waits through two healthy native tool steps beyond the old 150 second total cutoff', async () => {
  const timer = clock();
  const result = await waitForNativeTurn(async () => {
    const t = timer.now();
    const events = t >= 187714 ? [user, { seq: 2, kind: 'tool.call' }, done] : t >= 96220 ? [user, { seq: 2, kind: 'tool.call' }] : [user];
    return { events, requests: [{ id: 'first', state: t >= 96220 ? 'completed' : 'in-flight' },
      ...(t >= 96220 ? [{ id: 'second', state: t >= 187714 ? 'completed' : 'in-flight' }] : [])] };
  }, { ...timer, intervalMs: 1000 });
  expect(timer.now()).toBeGreaterThan(150000); expect(result.at(-1)).toEqual(done);
});

it('in-flight native response chunks count as progress while no new semantic event arrives', async () => {
  const timer = clock();
  const result = await waitForNativeTurn(async () => ({ events: timer.now() >= 200000 ? [user, done] : [user],
    requests: [{ id: 'stream', state: 'in-flight', response: { chunks: Array.from({ length: Math.floor(timer.now() / 50000) + 1 }, (_, i) => ({ t: i * 50000 })) } }] }),
  { ...timer, intervalMs: 1000 });
  expect(result.at(-1)).toEqual(done);
});

it('does not accept an unrelated completed turn or a missing intended user turn', async () => {
  const timer = clock();
  await expect(waitForNativeTurn(async () => ({ events: [user, { ...done, turnId: 'other' }] }),
    { ...timer, idleTimeoutMs: 100, intervalMs: 10 })).rejects.toMatchObject({ observation: { deadline: 'idle', targetTurnId: 'target' } });
});

it('native progress cannot bypass the absolute observation budget and uncertain receipts never pass', async () => {
  const timer = clock();
  await expect(waitForNativeTurn(async () => ({ events: [user, { seq: timer.now() + 2, kind: 'tool.call' }] }),
    { ...timer, idleTimeoutMs: 100, maxDurationMs: 300, intervalMs: 10 })).rejects.toMatchObject({ observation: { deadline: 'absolute' } });
  await expect(waitForNativeTurn(async () => ({ events: [user, done], requests: [{ id: 'uncertain', state: 'uncertain' }] }))).rejects.toThrow('paid input will not be repeated');
});

it('defers cleanup when an admitted receipt is still pending, then observes its eventual settlement', async () => {
  const timer = clock();
  const read = () => [{ id: 'paid', state: timer.now() >= 200 ? 'completed' : 'in-flight' }];
  const first = await waitForNativeReceipts(read, { ...timer, timeoutMs: 100, intervalMs: 10 });
  expect(first).toMatchObject({ settled: false, pendingRequestIds: ['paid'] });
  const settled = await waitForNativeReceipts(read, { ...timer, timeoutMs: Infinity, intervalMs: 10 });
  expect(settled).toMatchObject({ settled: true, pendingRequestIds: [] });
  expect(await waitForNativeReceipts(() => [{ id: 'unknown', state: 'uncertain' }])).toMatchObject({
    settled: false, pendingRequestIds: [], uncertainRequestIds: ['unknown'],
  });
});
