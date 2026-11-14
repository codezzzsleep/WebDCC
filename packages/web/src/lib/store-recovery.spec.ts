import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedInput } from '@webdcc/protocol';
import type { SyncConnectionOptions } from './connection.js';

const mocks = vi.hoisted(() => ({ queue: vi.fn(), cancel: vi.fn(), putOutbox: vi.fn(), getOutbox: vi.fn(), send: vi.fn(), subscribe: vi.fn(), session: vi.fn(), events: vi.fn(), options: [] as SyncConnectionOptions[] }));
vi.mock('./connection.js', () => ({ SyncConnection: class {
  constructor(options: SyncConnectionOptions) { mocks.options.push(options); }
  sendCommand = mocks.send;
  subscribe = mocks.subscribe;
} }));
vi.mock('./api.js', () => ({ api: { queue: mocks.queue, cancelQueued: mocks.cancel, session: mocks.session, events: mocks.events } }));
vi.mock('./db.js', () => ({ cache: { putOutbox: mocks.putOutbox, deleteOutbox: vi.fn().mockResolvedValue(undefined), getOutbox: mocks.getOutbox, getEvents: vi.fn().mockResolvedValue([]), putSession: vi.fn().mockResolvedValue(undefined), putEvents: vi.fn().mockResolvedValue(undefined), setMeta: vi.fn().mockResolvedValue(undefined) } }));
import { AppStore } from './store.js';

const queued: QueuedInput = { commandId: 'queued', sessionId: 's', turnId: 't', ordinal: 1, input: { text: '持久队列原文' }, state: 'queued', createdAt: '2026-01-01T00:00:00Z' };
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.options.length = 0; mocks.queue.mockResolvedValue({ inputs: [queued], revision: 1 }); mocks.cancel.mockResolvedValue(undefined); mocks.putOutbox.mockResolvedValue(undefined); mocks.getOutbox.mockResolvedValue([]); });
afterEach(() => { vi.useRealTimers(); });

describe('NP-03 browser queue recovery', () => {
  it('NP-06 distinguishes collected answers, failed submissions and newer retries', async () => {
    const store = new AppStore();
    store.answer('s', 'q', { custom: 'first' });
    const first = store.getInteractionSubmission('s', 'answer', 'q')!;
    store.answer('s', 'q', { custom: 'duplicate click' });
    expect(mocks.putOutbox).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('pending');
    mocks.options[0]?.onMessage({ op: 'ack', clientCommandId: first.commandId, result: { ok: true, value: { submitted: false } } });
    expect(store.getInteractionSubmission('s', 'answer', 'q')?.status).toBe('collected');
    store.answer('s', 'q', { custom: 'updated' });
    const second = store.getInteractionSubmission('s', 'answer', 'q')!;
    mocks.options[0]?.onMessage({ op: 'ack', clientCommandId: first.commandId, result: { ok: false, code: 'bad-request', error: 'old failure' } });
    expect(store.getInteractionSubmission('s', 'answer', 'q')).toEqual(second);
    mocks.options[0]?.onMessage({ op: 'ack', clientCommandId: second.commandId, result: { ok: false, code: 'bad-request', error: 'retry allowed' } });
    expect(store.getInteractionSubmission('s', 'answer', 'q')).toMatchObject({ status: 'failed', error: 'retry allowed' });
    store.answer('s', 'q', { custom: 'retry' });
    expect(mocks.putOutbox.mock.calls.filter(([entry]) => (entry as { status?: string }).status === 'pending')).toHaveLength(3);
    await Promise.resolve();
  });
  it('shows server-accepted text after refresh, then removes it after cancellation', async () => {
    const store = new AppStore();
    await store.refreshQueue('s');
    expect(store.getTurns('s')[0]).toMatchObject({ user: { text: '持久队列原文' }, pending: { status: 'queued' } });
    mocks.queue.mockResolvedValue({ inputs: [], revision: 2 });
    await store.cancelQueued('s', 'queued');
    expect(mocks.cancel).toHaveBeenCalledWith('s', 'queued');
    expect(store.getTurns('s')).toEqual([]);
  });

  it('does not let an older queue response resurrect cancelled input', async () => {
    let release: ((value: { inputs: QueuedInput[]; revision: number }) => void) | undefined;
    mocks.queue.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce({ inputs: [], revision: 2 });
    const store = new AppStore();
    const old = store.refreshQueue('s');
    await store.refreshQueue('s');
    release?.({ inputs: [queued], revision: 1 });
    await old;
    expect(store.getPending('s')).toEqual([]);
  });

  it('saves outbox before sending and never automatically retries uncertain commands', async () => {
    let persisted: (() => void) | undefined;
    mocks.putOutbox.mockImplementationOnce(() => new Promise<void>(resolve => { persisted = resolve; }));
    const store = new AppStore();
    const command = store.sendMessage('s', '原文');
    expect(mocks.send).not.toHaveBeenCalled();
    persisted?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    mocks.options[0]?.onMessage({ op: 'ack', clientCommandId: command.clientCommandId, result: { ok: false, code: 'uncertain', error: 'unknown outcome' } });
    mocks.options[0]?.onOpen?.();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(store.getPending('s')[0]?.status).toBe('uncertain');
    expect(mocks.putOutbox).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'uncertain' }));
  });
  it('structured commands receive a durable receipt before dispatch, and retain exact attachments after failure and refresh', async () => {
    const contentParts = { version: 1 as const, parts: [{ type: 'text' as const, text: '  原文\r\n ' }, { type: 'file' as const, fileId: 'chosen-file', name: 'chosen.txt' }] };
    mocks.putOutbox.mockRejectedValueOnce(new Error('quota'));
    const store = new AppStore();
    await expect(store.sendStructuredMessage('s', '  原文\r\n ', contentParts)).rejects.toThrow('未能保存');
    expect(mocks.send).not.toHaveBeenCalled();
    expect(store.getPending('s')[0]).toMatchObject({ status: 'failed', contentParts, text: '  原文\r\n ' });
    let recovered: unknown;
    const unbind = store.bindDraftRecovery('s', input => { recovered = input; return true; });
    store.recoverFailedInput('s', store.getPending('s')[0]!.clientCommandId);
    expect(recovered).toMatchObject({ text: '  原文\r\n ', contentParts }); unbind();
    let persisted!: () => void;
    mocks.putOutbox.mockImplementationOnce(() => new Promise<void>(resolve => { persisted = resolve; }));
    const accepting = store.sendStructuredMessage('s', '  原文\r\n ', contentParts, 'queue');
    mocks.options[0]?.onOpen?.(); expect(mocks.send).not.toHaveBeenCalled();
    persisted(); const receipt = await accepting; expect(receipt.commandId).not.toBe('');
    const sent = mocks.send.mock.calls[0]![0];
    expect(sent).toMatchObject({ contentParts, intent: 'queue', text: '  原文\r\n ' });
    const createdAt = Date.parse(store.getPending('s').find(item => item.clientCommandId === receipt.commandId)!.at);
    mocks.options[0]?.onMessage({ op: 'ack', clientCommandId: receipt.commandId, result: { ok: false, code: 'uncertain', error: 'native result unknown' } });
    expect(() => store.recoverFailedInput('s', receipt.commandId)).toThrow('不能直接重发');
    const cached = mocks.putOutbox.mock.calls.at(-1)![0]; expect(cached).toMatchObject({ createdAt, error: 'native result unknown', command: sent });
    mocks.getOutbox.mockResolvedValue([cached]);
    const restored = new AppStore(); await restored.restoreOutbox();
    expect(restored.getTurns('s')[0]).toMatchObject({ user: { text: '  原文\r\n ', contentParts }, pending: { status: 'uncertain', error: 'native result unknown' } });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('offline steer remains visible inside its existing turn and preserves every admitted supplemental input', async () => {
    const store = new AppStore();
    store.applyEvent({ sessionId: 's', seq: 1, turnId: 't', itemKey: 'user-1', kind: 'user.message', data: { text: 'first', clientCommandId: 'initial' }, at: '2026-01-01T00:00:00Z' });
    store.applyEvent({ sessionId: 's', seq: 2, turnId: 't', itemKey: 'start', kind: 'turn.started', data: {}, at: '2026-01-01T00:00:01Z' });
    const contentParts = { version: 1 as const, parts: [{ type: 'text' as const, text: 'steered' }, { type: 'file' as const, fileId: 'chosen-file' }] };
    const receipt = await store.sendStructuredMessage('s', 'steered', contentParts, 'steer', 't');
    expect(store.getTurns('s')).toHaveLength(1);
    expect(store.getTurns('s')[0]).toMatchObject({ turnId: 't', pendingInputs: [{ text: 'steered', contentParts, status: 'pending' }] });
    mocks.options[0]?.onMessage({ op: 'event', event: { sessionId: 's', seq: 3, turnId: 't', itemKey: 'steer', kind: 'user.message', data: { text: 'steered', contentParts, intent: 'steer', clientCommandId: receipt.commandId }, at: '2026-01-01T00:00:02Z' } });
    await Promise.resolve();
    expect(store.getTurns('s')[0]?.inputs).toMatchObject([{ text: 'first' }, { text: 'steered', contentParts }]);
    expect(store.getTurns('s')[0]?.pendingInputs).toBeUndefined();
  });
});
