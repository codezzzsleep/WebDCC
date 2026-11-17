import { afterEach, expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterEvent, ClaudeQueryConfiguration, CreateOpts } from '@webdcc/protocol';
import { currentClaudeConfiguration } from '@webdcc/protocol';

const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mock.query }));
import { ClaudeAdapter } from '../src/adapter.js';

const opts: CreateOpts = { sessionId: 'configuration-session', cwd: '/tmp/claude-configuration', providerId: null, model: 'current' };
const nativeId = 'native-configuration';
function harness() {
  const queries: { options: Options; close: ReturnType<typeof vi.fn> }[] = [];
  const initialized = new Set<number>();
  let nextInitialization: Promise<{ claude_code_version: string }> | undefined;
  mock.query.mockImplementation(({ options }: { options: Options }) => {
    let ended = false; let wake: (() => void) | undefined;
    const initialization = nextInitialization ?? Promise.resolve({ claude_code_version: '2.1.322' }); nextInitialization = undefined;
    const messages = [{ type: 'system', subtype: 'init', session_id: nativeId, model: options.model,
      permissionMode: 'default', slash_commands: [], capabilities: [] }] as unknown as SDKMessage[];
    const close = vi.fn(() => { ended = true; wake?.(); }); const index = queries.length; queries.push({ options, close });
    return {
      async *[Symbol.asyncIterator]() { while (!ended || messages.length > 0) {
        const message = messages.shift(); if (message !== undefined) yield message;
        else await new Promise<void>(resolve => { wake = resolve; });
      } }, close, initializationResult: () => { initialized.add(index); return initialization; },
      supportedModels: async () => [{ value: 'current', displayName: 'Current', description: 'Controlled SDK catalog', supportsAdaptiveThinking: true }],
      supportedCommands: async () => [], supportedAgents: async () => [], accountInfo: async () => ({}), mcpServerStatus: async () => [],
    } as unknown as Query;
  });
  return { queries, initialized, next(promise: Promise<{ claude_code_version: string }>) { nextInitialization = promise; },
    adapter(env?: Record<string, string>) {
      const adapter = new ClaudeAdapter(env === undefined ? {} : { env });
      vi.spyOn(adapter.nativeHistory, 'info').mockRejectedValue(new Error('controlled native transcript unavailable'));
      return adapter;
    } };
}
async function accepted(adapter: ClaudeAdapter): Promise<ClaudeQueryConfiguration> {
  await adapter.create(opts);
  const result = await adapter.executeNativeControl(opts.sessionId, { type: 'thinking', thinking: { type: 'enabled', budgetTokens: 1024 } });
  return (result as { configuration: ClaudeQueryConfiguration }).configuration;
}
afterEach(() => mock.query.mockReset());

it.each(['workspace', 'provider', 'model', 'native session', 'native version', 'changed payload'])('rejects a changed %s before starting a restored SDK query', async changed => {
  const h = harness(); const adapter = h.adapter();
  try {
    const configuration = await accepted(adapter); await adapter.dispose(opts.sessionId); const count = h.queries.length;
    const restore = { ...opts, nativeId, restoreClaudeConfiguration: configuration };
    if (changed === 'workspace') restore.cwd = '/tmp/other-configuration-workspace';
    if (changed === 'provider') restore.providerId = 'other-provider';
    if (changed === 'model') restore.model = 'other-model';
    if (changed === 'native session') restore.nativeId = 'other-native-session';
    if (changed === 'native version') restore.restoreClaudeConfiguration = { ...configuration, sdkVersion: '0.3.321' };
    if (changed === 'changed payload') restore.restoreClaudeConfiguration = { ...configuration, options: { thinking: { type: 'disabled' } } };
    await expect(adapter.resume(restore)).rejects.toMatchObject({ code: 'native-control-rejected' });
    expect(h.queries).toHaveLength(count);
  } finally { await adapter.dispose(opts.sessionId); }
});

it('does not reuse an accepted configuration from a different native profile', async () => {
  const h = harness(); const first = h.adapter({ CLAUDE_CONFIG_DIR: '/tmp/configuration-profile-first' });
  const second = h.adapter({ CLAUDE_CONFIG_DIR: '/tmp/configuration-profile-second' });
  try {
    const configuration = await accepted(first); await first.dispose(opts.sessionId); const count = h.queries.length;
    await expect(second.resume({ ...opts, nativeId, restoreClaudeConfiguration: configuration })).rejects.toMatchObject({ code: 'native-control-rejected' });
    expect(h.queries).toHaveLength(count);
  } finally { await first.dispose(opts.sessionId); await second.dispose(opts.sessionId); }
});

it('an explicit CLI return inherits native settings instead of replaying SDK overrides', async () => {
  const h = harness(); const adapter = h.adapter();
  try {
    const configuration = await accepted(adapter); await adapter.dispose(opts.sessionId);
    await adapter.resume({ ...opts, nativeId, restoreClaudeConfiguration: configuration, restoreNativeHistory: true });
    expect(h.queries.at(-1)!.options.thinking).toBeUndefined();
    expect(h.queries.at(-1)!.options.outputFormat).toBeUndefined();
  } finally { await adapter.dispose(opts.sessionId); }
});

it('late restoration acceptance cannot publish settings or close a newer query', async () => {
  const h = harness(); const adapter = h.adapter(); const events: AdapterEvent[] = [];
  adapter.onEvent((_id, event) => events.push(event)); let release!: (value: { claude_code_version: string }) => void;
  let pending: Promise<void> | undefined;
  try {
    const configuration = await accepted(adapter); await adapter.dispose(opts.sessionId);
    h.next(new Promise(resolve => { release = resolve; }));
    pending = adapter.resume({ ...opts, nativeId, restoreClaudeConfiguration: configuration });
    const failure = expect(pending).rejects.toMatchObject({ statusCode: 409 });
    await vi.waitFor(() => expect(h.queries).toHaveLength(3));
    await vi.waitFor(() => expect(h.initialized.has(2)).toBe(true));
    await adapter.dispose(opts.sessionId); await adapter.create(opts);
    const current = (await adapter.nativeCatalog(opts.sessionId)).configuration!; const query = h.queries.at(-1)!;
    release({ claude_code_version: '2.1.322' }); await failure;
    expect(query.close).not.toHaveBeenCalled(); expect((await adapter.nativeCatalog(opts.sessionId)).configuration).toEqual(current);
    const projections = events.filter((event): event is Extract<AdapterEvent, { type: 'item.complete' }> => event.type === 'item.complete' && event.kind === 'internal');
    expect(currentClaudeConfiguration(projections, nativeId)).toEqual({ state: 'accepted', configuration: current });
    expect(current.options).toEqual({});
  } finally { release?.({ claude_code_version: '2.1.322' }); await pending?.catch(() => undefined); await adapter.dispose(opts.sessionId); }
});
