import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createTestApp, type TestApp } from './helpers.js';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mock.query }));
import { ClaudeAdapter } from '../../adapters/claude/src/adapter.js';

const thinking = { type: 'enabled', budgetTokens: 1024, display: 'omitted' } as const;
const schema = { type: 'object', properties: { value: { type: 'array', items: { enum: [false, null, 0, '中文'] } } }, required: ['value'], additionalProperties: false };
function controlledSDK() {
  const queries: { options: Options; close: ReturnType<typeof vi.fn> }[] = [];
  mock.query.mockImplementation(({ options }: { options: Options }) => {
    let ended = false; let wake: (() => void) | undefined;
    const messages = [{ type: 'system', subtype: 'init', session_id: options.resume ?? randomUUID(), model: options.model,
      permissionMode: options.permissionMode ?? 'default', slash_commands: [], capabilities: [] }] as unknown as SDKMessage[];
    const close = vi.fn(() => { ended = true; wake?.(); }); queries.push({ options, close });
    return {
      async *[Symbol.asyncIterator]() { while (!ended || messages.length > 0) {
        const message = messages.shift(); if (message !== undefined) yield message;
        else await new Promise<void>(resolve => { wake = resolve; });
      } }, close,
      initializationResult: async () => {
        if (options.outputFormat?.schema['title'] === 'reject-initialization') throw new Error('original controlled SDK initialization rejection');
        return { claude_code_version: '2.1.322' };
      },
      supportedModels: async () => [{ value: 'current', displayName: 'Native model', description: 'Controlled SDK catalog', supportsAdaptiveThinking: true }],
      supportedCommands: async () => [], supportedAgents: async () => [], accountInfo: async () => ({}), mcpServerStatus: async () => [],
    } as unknown as Query;
  });
  const adapter = (): ClaudeAdapter => {
    const value = new ClaudeAdapter();
    vi.spyOn(value.nativeHistory, 'info').mockRejectedValue(new Error('controlled native history unavailable'));
    return value;
  };
  return { queries, adapter, active: () => queries.findLast(query => query.options.onUserDialog !== undefined)! };
}
afterEach(() => mock.query.mockReset());

async function action(ctx: TestApp, sessionId: string, value: { type: string; [key: string]: unknown }) {
  const snapshot = await ctx.manager.nativeControls(sessionId);
  return ctx.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/native/actions`, headers: { cookie: ctx.cookie },
    payload: { commandId: randomUUID(), revision: snapshot.revision, action: value } });
}
async function configure(ctx: TestApp, sessionId: string) {
  for (const value of [{ type: 'thinking', thinking }, { type: 'output', schema }, { type: 'checkpoints', enabled: true }]) {
    const response = await action(ctx, sessionId, value); expect(response.statusCode, response.body).toBe(200);
  }
}
async function connect(ctx: TestApp, sessionId: string) {
  return ctx.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/native/connect`, headers: { cookie: ctx.cookie },
    payload: { commandId: randomUUID(), action: { type: 'connect' } } });
}
async function session(ctx: TestApp, cwd = ctx.dataDir) {
  const workspace = ctx.store.createWorkspace('Claude accepted configuration', cwd);
  const value = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'claude-code', model: 'current', accessMode: 'plan' });
  await vi.waitFor(() => expect(ctx.store.getSession(value.id)?.nativeId).toEqual(expect.any(String)));
  return value;
}

it('HTTP reconnect restores the accepted thinking, output schema and checkpoint options without changing permission or native identity', async () => {
  const sdk = controlledSDK(); const ctx = await createTestApp(); ctx.manager.registerAdapter(sdk.adapter());
  try {
    const value = await session(ctx); await configure(ctx, value.id);
    const nativeId = ctx.store.getSession(value.id)!.nativeId; await ctx.manager.dispose(value.id);
    const response = await connect(ctx, value.id); expect(response.statusCode, response.body).toBe(200);
    expect(sdk.active().options.thinking).toEqual(thinking);
    expect(sdk.active().options.outputFormat).toEqual({ type: 'json_schema', schema });
    expect(sdk.active().options.enableFileCheckpointing).toBe(true);
    expect(sdk.active().options.permissionMode).toBe('plan'); expect(sdk.active().options.resume).toBe(nativeId);
  } finally { await ctx.close(); }
});

it('a second production Store connection and reopened dispatcher restore exact accepted values without replaying native commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-claude-config-reopen-')); const path = join(directory, 'state.sqlite');
  const cwd = join(directory, 'workspace'); await mkdir(cwd);
  const sdk = controlledSDK(); let ctx: TestApp | undefined;
  try {
    ctx = await createTestApp({}, undefined, {}, { dbPath: path }); ctx.manager.registerAdapter(sdk.adapter());
    const value = await session(ctx, cwd); await configure(ctx, value.id);
    const saved = ctx.store.allEvents(value.id); const second = openDb(path);
    try { expect(new Store(second).allEvents(value.id)).toEqual(saved); } finally { second.close(); }
    const count = sdk.queries.length; await ctx.close(); ctx = undefined;
    ctx = await createTestApp({}, undefined, {}, { dbPath: path }); ctx.manager.registerAdapter(sdk.adapter());
    const response = await connect(ctx, value.id); expect(response.statusCode, response.body).toBe(200);
    expect(sdk.queries).toHaveLength(count + 1);
    expect(sdk.active().options.thinking).toEqual(thinking);
    expect(sdk.active().options.outputFormat).toEqual({ type: 'json_schema', schema });
    expect(sdk.active().options.enableFileCheckpointing).toBe(true);
    console.log(JSON.stringify({ proof: 'Claude configuration source HTTP/SQLite recovery', controlledSDK: true,
      secondConnection: true, reopen: true, exactOptions: true, noCommandReplay: true, actualNativeRuns: 0, providerRequests: 0 }));
  } finally { await ctx?.close(); await rm(directory, { recursive: true, force: true }); }
});

it('a rejected native initialization preserves the previously accepted schema through rollback and later reconnection', async () => {
  const sdk = controlledSDK(); const ctx = await createTestApp(); ctx.manager.registerAdapter(sdk.adapter());
  try {
    const value = await session(ctx); await configure(ctx, value.id);
    const failed = await action(ctx, value.id, { type: 'output', schema: { type: 'object', title: 'reject-initialization' } });
    expect(failed.statusCode).toBeGreaterThanOrEqual(400); expect(failed.body).toContain('original controlled SDK initialization rejection');
    expect(failed.body).not.toContain('"state":"completed"');
    expect(sdk.active().options.outputFormat).toEqual({ type: 'json_schema', schema });
    await ctx.manager.dispose(value.id); const response = await connect(ctx, value.id); expect(response.statusCode, response.body).toBe(200);
    expect(sdk.active().options.outputFormat).toEqual({ type: 'json_schema', schema });
    expect(sdk.active().options.thinking).toEqual(thinking);
  } finally { await ctx.close(); }
});

it('explicitly cleared overrides do not revive an older schema and false checkpoints remain false after reconnect', async () => {
  const sdk = controlledSDK(); const ctx = await createTestApp(); ctx.manager.registerAdapter(sdk.adapter());
  try {
    const value = await session(ctx); await configure(ctx, value.id);
    for (const option of [{ type: 'thinking', thinking: null }, { type: 'output', schema: null }, { type: 'checkpoints', enabled: false }]) {
      const response = await action(ctx, value.id, option); expect(response.statusCode, response.body).toBe(200);
    }
    await ctx.manager.dispose(value.id); const response = await connect(ctx, value.id); expect(response.statusCode, response.body).toBe(200);
    expect(sdk.active().options.thinking).toBeUndefined(); expect(sdk.active().options.outputFormat).toBeUndefined();
    expect(sdk.active().options.enableFileCheckpointing).toBe(false);
  } finally { await ctx.close(); }
});

it('reading the last accepted configuration is authenticated and never reconnects the native writer', async () => {
  const sdk = controlledSDK(); const ctx = await createTestApp(); ctx.manager.registerAdapter(sdk.adapter());
  try {
    const value = await session(ctx); await configure(ctx, value.id); await ctx.manager.dispose(value.id);
    const count = sdk.queries.length; const url = `/api/sessions/${value.id}/native/claude-configuration`;
    expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const read = await ctx.app.inject({ method: 'GET', url, headers: { cookie: ctx.cookie } });
    expect(read.statusCode, read.body).toBe(200); expect(read.json()).toMatchObject({ state: 'accepted', configuration: { options: { thinking, outputFormat: { type: 'json_schema', schema }, enableFileCheckpointing: true }, modelEffect: 'not-observed' } });
    expect(ctx.manager.getRuntime(value.id)).toBeUndefined(); expect(sdk.queries).toHaveLength(count);
  } finally { await ctx.close(); }
});

it('schema redaction preserves configuration identity and typed values but blocks restoration of a changed original', async () => {
  const sdk = controlledSDK(); const ctx = await createTestApp(); ctx.manager.registerAdapter(sdk.adapter());
  try {
    const value = await session(ctx); ctx.store.nativeEvents.addSecret('configuration-secret');
    ctx.store.nativeEvents.addSecret('enabled');
    expect((await action(ctx, value.id, { type: 'thinking', thinking })).statusCode).toBe(200);
    expect((await action(ctx, value.id, { type: 'output', schema: { type: 'object', title: 'configuration-secret' } })).statusCode).toBe(200);
    const accepted = ctx.store.allEvents(value.id).filter(event => event.kind === 'internal' && 'claudeConfiguration' in event.data).at(-1)!;
    const saved = accepted.data as { claudeConfiguration: { nativeSessionId: string; options: { thinking: unknown } } };
    expect(saved.claudeConfiguration.nativeSessionId).toBe(ctx.store.getSession(value.id)!.nativeId);
    expect(saved.claudeConfiguration.options.thinking).toEqual(thinking);
    expect(JSON.stringify(accepted)).not.toContain('configuration-secret');
    await ctx.manager.dispose(value.id); const count = sdk.queries.length;
    const read = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${value.id}/native/claude-configuration`, headers: { cookie: ctx.cookie } });
    expect(read.json()).toMatchObject({ state: 'unavailable' });
    const restored = await connect(ctx, value.id); expect(restored.statusCode).toBeGreaterThanOrEqual(400);
    expect(restored.body).toContain('无法确认原值'); expect(sdk.queries).toHaveLength(count);
  } finally { await ctx.close(); }
});
