import { afterEach, expect, it, vi } from 'vitest';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mock.query }));
import { ClaudeAdapter } from '../src/adapter.js';

function harness() {
  const options: Options[] = [];
  mock.query.mockImplementation((input: { options: Options }) => {
    options.push(input.options); let done = false; let wake: (() => void) | undefined;
    return { [Symbol.asyncIterator]() { return { async next() {
      if (!done) await new Promise<void>(resolve => { wake = resolve; }); return { done: true as const, value: undefined };
    } }; }, close() { done = true; wake?.(); }, initializationResult: async () => ({ claude_code_version: '2.1.322' }) } as unknown as Query;
  });
  const adapter = new ClaudeAdapter({ dialogSpecs: { declared: {
    validateRequest(payload) { if (typeof payload['value'] !== 'number') throw new Error('original fixture validation error'); },
    validateResult() {},
  } } });
  return { adapter, options };
}
afterEach(() => mock.query.mockReset());
const opts = { sessionId: 's', cwd: '/tmp', providerId: null };

it('an undeclared inherited object key is never mistaken for a registered renderer', async () => {
  const h = harness(); try {
    await h.adapter.create(opts);
    await expect(h.options[0]!.onUserDialog!({ dialogKind: 'constructor', payload: {} }, { requestId: 'unregistered', signal: new AbortController().signal })).rejects.toThrow('未声明');
    expect(h.adapter.nativeState('s').interactions).toEqual([]);
  } finally { await h.adapter.dispose('s'); }
});

it('a callback from a retired query does not settle a dialog or create interactions on the new query', async () => {
  const h = harness(); try {
    await h.adapter.create(opts); const old = h.options[0]!.onUserDialog!;
    await h.adapter.dispose('s'); await h.adapter.create(opts);
    await expect(old({ dialogKind: 'declared', payload: { value: 1 } }, { requestId: 'old', signal: new AbortController().signal })).rejects.toMatchObject({ statusCode: 409 });
    expect(h.adapter.nativeState('s').interactions).toEqual([]);
  } finally { await h.adapter.dispose('s'); }
});

it('an already withdrawn dialog cannot be turned into a user cancellation', async () => {
  const h = harness(); try {
    await h.adapter.create(opts); const controller = new AbortController(); controller.abort();
    await expect(h.options[0]!.onUserDialog!({ dialogKind: 'declared', payload: { value: 1 } }, { requestId: 'withdrawn', signal: controller.signal })).rejects.toThrow('请求已结束');
    expect(h.adapter.nativeState('s').interactions).toEqual([]);
  } finally { await h.adapter.dispose('s'); }
});

it('a conflicting redelivery is refused while the original declared user cancellation remains available', async () => {
  const h = harness(); let first: ReturnType<NonNullable<Options['onUserDialog']>> | undefined;
  try {
    await h.adapter.create(opts); const callback = h.options[0]!.onUserDialog!; const signal = new AbortController().signal;
    first = callback({ dialogKind: 'declared', payload: { value: 1 } }, { requestId: 'same', signal });
    await expect(callback({ dialogKind: 'declared', payload: { value: 2 } }, { requestId: 'same', signal })).rejects.toThrow('冲突');
    expect(h.adapter.nativeState('s').interactions[0]).toMatchObject({ status: 'pending', payload: { payload: { value: 1 } } });
    await h.adapter.executeNativeControl('s', { type: 'dialog', requestId: 'same', behavior: 'cancelled' });
    expect(await first).toEqual({ behavior: 'cancelled' });
  } finally { await h.adapter.dispose('s'); await first?.catch(() => undefined); }
});

it('invalid declared payloads preserve the validation cause and never return a fake dismissal', async () => {
  const h = harness(); try {
    await h.adapter.create(opts);
    await expect(h.options[0]!.onUserDialog!({ dialogKind: 'declared', payload: { value: 'invalid' } }, { requestId: 'bad', signal: new AbortController().signal }))
      .rejects.toMatchObject({ cause: { message: 'original fixture validation error' } });
    expect(h.adapter.nativeState('s').interactions).toEqual([]);
  } finally { await h.adapter.dispose('s'); }
});
