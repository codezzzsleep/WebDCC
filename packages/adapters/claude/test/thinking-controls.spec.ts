import { afterEach, expect, it, vi } from 'vitest';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';

const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mock.query }));
import { ClaudeAdapter } from '../src/adapter.js';

function harness(adaptive: boolean) {
  const queries: { options: Options; close: ReturnType<typeof vi.fn> }[] = [];
  mock.query.mockImplementation(({ options }: { options: Options }) => {
    let ended = false; let wake: (() => void) | undefined;
    const close = vi.fn(() => { ended = true; wake?.(); }); queries.push({ options, close });
    return {
      [Symbol.asyncIterator]() { return { async next() {
        if (!ended) await new Promise<void>(resolve => { wake = resolve; });
        return { done: true as const, value: undefined };
      } }; },
      close, initializationResult: async () => ({ claude_code_version: '2.1.322' }),
      supportedModels: async () => [{ value: 'current', displayName: 'current', description: 'controlled native catalog', supportsAdaptiveThinking: adaptive }],
      supportedCommands: async () => [], supportedAgents: async () => [], accountInfo: async () => ({}), mcpServerStatus: async () => [],
    } as unknown as Query;
  });
  return { adapter: new ClaudeAdapter(), queries };
}
afterEach(() => mock.query.mockReset());

it('keeps the requested optional budget and reports the SDK adaptive mapping without claiming a model effect', async () => {
  const h = harness(true);
  try {
    await h.adapter.create({ sessionId: 's', cwd: '/tmp', providerId: null, model: 'current' });
    const catalog = await h.adapter.executeNativeControl('s', { type: 'thinking', thinking: { type: 'enabled', display: 'omitted' } }) as { thinkingMapping: unknown };
    expect(h.queries).toHaveLength(2); expect(h.queries[1]!.options.thinking).toEqual({ type: 'enabled', display: 'omitted' });
    expect(catalog.thinkingMapping).toEqual({ requested: { type: 'enabled', display: 'omitted' }, sdkMode: 'adaptive', source: 'SDK startup options/0.3.322', modelEffect: 'not-observed' });
  } finally { await h.adapter.dispose('s'); }
});

it('applies the same declared model boundary to adaptive and enabled without a budget before closing a query', async () => {
  const h = harness(false);
  try {
    await h.adapter.create({ sessionId: 's', cwd: '/tmp', providerId: null, model: 'current' });
    for (const thinking of [{ type: 'adaptive' }, { type: 'enabled' }]) await expect(h.adapter.executeNativeControl('s', { type: 'thinking', thinking })).rejects.toMatchObject({ code: 'native-control-rejected' });
    expect(h.queries).toHaveLength(1); expect(h.queries[0]!.close).not.toHaveBeenCalled();
    await h.adapter.executeNativeControl('s', { type: 'thinking', thinking: { type: 'enabled', budgetTokens: 1024 } });
    expect(h.queries[1]!.options.thinking).toEqual({ type: 'enabled', budgetTokens: 1024 });
  } finally { await h.adapter.dispose('s'); }
});
