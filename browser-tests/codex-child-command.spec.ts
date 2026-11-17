import { chromium, type Browser, type Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { currentCodexSubagents, type AdapterEvent, type CreateOpts, type EventData } from '../packages/protocol/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { FakeAdapter } from '../packages/testing/fake-adapter/src/index.js';
import type { ThreadItem } from '../packages/adapters/codex/src/schema/v2/ThreadItem.js';
import { createSourceTestApp } from './helpers.js';

type CommandItem = Extract<ThreadItem, { type: 'commandExecution' }>;
const turnId = 'child:command:turn:🐈'; const itemId = 'same:command:item';
const command = (status: CommandItem['status'] = 'inProgress', output: string | null = null): CommandItem => ({
  type: 'commandExecution', id: itemId, command: 'native original <script>literal</script>', cwd: '/native/child-workspace',
  processId: 'native:process:string', pluginId: null, scriptPath: null, source: 'agent', status, commandActions: [],
  aggregatedOutput: output, exitCode: status === 'failed' ? 7 : status === 'completed' ? 0 : null, durationMs: null,
});

async function fixture() {
  const ctx = await createSourceTestApp();
  try {
    const adapter = new FakeAdapter({ id: 'codex' }); let emit!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    adapter.onEvent = value => { emit = value; }; const create = adapter.create.bind(adapter); let sends = 0;
    adapter.create = async value => { opts = value; return create(value); }; adapter.send = async () => { sends++; };
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Controlled native child command', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    await ctx.manager.send(session.id, { text: 'Controlled native notifications only' }, 'child-command-source');
    const nativeId = session.nativeId;
    if (typeof nativeId !== 'string' || nativeId === '') throw new Error('Missing original native session identity');
    const replay = CodexAdapter.replay(session.id, nativeId); let seq = 0;
    const feed = (method: string, params: Record<string, unknown>) => {
      const frame = { i: ++seq, t: seq, dir: 'in' as const, ch: 'rpc', frame: { method, params: { threadId: nativeId, ...params } } };
      const receipt = opts.nativeEvents!.record(frame);
      for (const event of replay.feed(frame)) emit(session.id, { ...event, runtime: opts.runtime, nativeEnvelopeId: receipt.envelopeId });
    };
    const spawn = (childId: string, completedSnapshot = false) => feed('item/completed', { turnId: 'parent-turn', item: {
      type: 'collabAgentToolCall', id: 'spawn-' + childId, tool: 'spawnAgent', status: 'completed', senderThreadId: nativeId,
      receiverThreadIds: [childId], prompt: null, model: null, reasoningEffort: null,
      agentsStates: completedSnapshot ? { [childId]: { status: 'completed', message: null } } : {},
    } satisfies ThreadItem });
    feed('turn/started', { turn: { id: 'parent-turn', status: 'inProgress' } });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    return { ...ctx, session, feed, spawn, sends: () => sends, base: 'http://127.0.0.1:' + address.port };
  } catch (error) { await ctx.close(); throw error; }
}

async function showCommand(page: Page, childId: string, nativeTurnId = turnId) {
  const target = page.getByTestId('codex-child-command').filter({ has: page.locator('summary') });
  const command = target.locator('xpath=self::*[@data-child-id="' + childId + '" and @data-native-turn-id="' + nativeTurnId + '"]');
  await command.waitFor({ state: 'attached' });
  const outer = command.locator('xpath=ancestor::details[1]');
  if (await outer.getAttribute('open') === null) await outer.locator(':scope > summary').click();
  if (await command.getAttribute('open') === null) await command.locator(':scope > summary').click();
  return command;
}

it('source child commands keep both identical chunks, full native final output, nullable results and raw identities after refresh/reconnect', async () => {
  const ctx = await fixture(); let browser: Browser | undefined;
  try {
    // A caller's completed entity snapshot cannot deduplicate later command progress.
    ctx.spawn('child-A', true); ctx.spawn('child-B', true);
    for (const child of ['child-A', 'child-B']) ctx.feed('item/started', { threadId: child, turnId, item: command(), startedAtMs: 1 });
    const prefix = '重复🐈\r\n<script>literal</script>';
    for (let n = 0; n < 2; n++) ctx.feed('item/commandExecution/outputDelta', { threadId: 'child-A', turnId, itemId, delta: prefix });
    ctx.feed('item/commandExecution/outputDelta', { threadId: 'child-B', turnId, itemId, delta: 'B original stream' });
    await expect.poll(() => currentCodexSubagents(ctx.store.allEvents(ctx.session.id)).find(child => child.childId === 'child-A')?.commands?.[0]?.output).toBe(prefix + prefix);
    const deltaRows = ctx.store.allEvents(ctx.session.id).filter(event => event.kind === 'tool.call'
      && (event.data as EventData['tool.call']).output !== undefined
      && ((event.data as EventData['tool.call']).output as { commandDelta?: unknown }).commandDelta !== undefined);
    expect(deltaRows).toHaveLength(3);
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const errors: string[] = []; let sockets = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', () => { sockets++; });
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: ctx.base }]);
    await page.goto(ctx.base + '/s/' + ctx.session.id);
    const a = await showCommand(page, 'child-A'); const b = await showCommand(page, 'child-B');
    expect(await a.getByTestId('codex-child-command-output').textContent()).toBe(prefix + prefix);
    expect(await b.getByTestId('codex-child-command-output').textContent()).toBe('B original stream');
    expect(await a.getByTestId('codex-child-command-status').textContent()).toContain('运行中');
    expect(await page.getByTestId('codex-subagents-panel').locator('.summary').textContent()).toContain('2 已完成');
    const full = Array.from({ length: 250 }, (_, n) => '完整行:' + n + '\r\n').join('') + '原生终稿🐈<script>literal</script>';
    const finalA = { ...command('failed', full), pluginId: 'native:plugin', scriptPath: 'native/script', durationMs: 12 };
    const finalB = command('completed', null);
    for (const [child, item] of [['child-A', finalA], ['child-B', finalB]] as const) ctx.feed('item/completed', { threadId: child, turnId, item, completedAtMs: 2 });
    await expect.poll(() => a.getByTestId('codex-child-command-output').textContent()).toBe(full);
    await expect.poll(() => b.getByTestId('codex-child-command-status').textContent()).toContain('已完成');
    ctx.feed('turn/completed', { turn: { id: 'parent-turn', status: 'failed' } });
    const beforeReconnect = sockets;
    for (const socket of ctx.app.websocketServer.clients) socket.terminate();
    await expect.poll(() => sockets).toBeGreaterThan(beforeReconnect);
    await expect.poll(() => a.getByTestId('codex-child-command-output').textContent()).toBe(full);
    await page.reload();
    const restoredA = await showCommand(page, 'child-A'); const restoredB = await showCommand(page, 'child-B');
    expect(await restoredA.getByTestId('codex-child-command-output').textContent()).toBe(full);
    expect(await restoredA.getByTestId('codex-child-command-status').textContent()).toContain('失败');
    expect(await restoredA.getByTestId('codex-child-command-exit').textContent()).toContain('7');
    expect(await restoredB.getByTestId('codex-child-command-output').textContent()).toBe('B original stream');
    expect(await restoredB.getByTestId('codex-child-command-exit').textContent()).toContain('0');
    for (const [child, native] of [['child-A', finalA], ['child-B', finalB]] as const) {
      const event = ctx.store.allEvents(ctx.session.id).find(event => event.kind === 'tool.call'
        && (event.data as EventData['tool.call']).output !== undefined
        && ((event.data as EventData['tool.call']).output as { command?: { native?: CommandItem } }).command?.native?.id === itemId
        && ((event.data as EventData['tool.call']).input as { childId?: string }).childId === child)!;
      expect((event.data as EventData['tool.call']).output).toEqual({ command: { nativeTurnId: turnId, itemId, native } });
      const mapping = ctx.store.nativeEvents.get(event.nativeEnvelopeId!)!;
      expect(ctx.store.nativeEvents.get(mapping.rawEnvelopeId!)?.payload).toMatchObject({ method: 'item/completed', params: { threadId: child, turnId, item: native } });
    }
    expect(ctx.store.allEvents(ctx.session.id).filter(event => event.kind === 'command')).toHaveLength(0);
    expect(ctx.store.allEvents(ctx.session.id).filter(event => event.kind === 'turn.started')).toHaveLength(1);
    expect(ctx.sends()).toBe(1); expect(errors).toEqual([]);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it('source refresh preserves an interrupted partial command and a late previous-turn completion keeps the new child command separate', async () => {
  const ctx = await fixture(); let browser: Browser | undefined;
  try {
    ctx.spawn('child-A'); ctx.feed('turn/started', { threadId: 'child-A', turn: { id: turnId, status: 'inProgress' } });
    ctx.feed('item/started', { threadId: 'child-A', turnId, item: command() });
    ctx.feed('item/commandExecution/outputDelta', { threadId: 'child-A', turnId, itemId, delta: 'partial before interrupt' });
    ctx.feed('turn/completed', { threadId: 'child-A', turn: { id: turnId, status: 'interrupted' } });
    ctx.feed('item/commandExecution/outputDelta', { threadId: 'child-A', turnId, itemId, delta: 'obsolete suffix' });
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: ctx.base }]);
    await page.goto(ctx.base + '/s/' + ctx.session.id); await page.reload();
    const old = await showCommand(page, 'child-A'); expect(await old.getByTestId('codex-child-command-output').textContent()).toBe('partial before interrupt');
    expect(await old.getByTestId('codex-child-command-status').textContent()).toContain('尚未收到命令完成通知');
    ctx.feed('turn/started', { threadId: 'child-A', turn: { id: 'new-child-turn', status: 'inProgress' } });
    ctx.feed('item/started', { threadId: 'child-A', turnId: 'new-child-turn', item: command() });
    ctx.feed('item/commandExecution/outputDelta', { threadId: 'child-A', turnId: 'new-child-turn', itemId, delta: 'new command output' });
    ctx.feed('item/completed', { threadId: 'child-A', turnId, item: command('failed', 'late old final') });
    await page.reload(); const previous = await showCommand(page, 'child-A'); const current = await showCommand(page, 'child-A', 'new-child-turn');
    expect(await previous.getByTestId('codex-child-command-output').textContent()).toBe('late old final');
    expect(await current.getByTestId('codex-child-command-output').textContent()).toBe('new command output');
    expect(await current.getByTestId('codex-child-command-status').textContent()).toContain('尚未收到命令完成通知');
    const view = currentCodexSubagents(ctx.store.allEvents(ctx.session.id))[0]!;
    expect(view).toMatchObject({ nativeTurnId: 'new-child-turn', nativeStatus: 'running' }); expect(view.commands).toHaveLength(2);
    expect(ctx.sends()).toBe(1);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);

it.each(['claude-code', 'dsh'] as const)('preserves %s ordinary subagent-named tools and shows no Codex child command UI', async agent => {
  const ctx = await createSourceTestApp(); let browser: Browser | undefined;
  try {
    const adapter = new FakeAdapter({ id: agent }); let emit!: (id: string, event: AdapterEvent) => void; let opts!: CreateOpts;
    adapter.onEvent = value => { emit = value; }; const create = adapter.create.bind(adapter);
    adapter.create = async value => { opts = value; return create(value); }; adapter.send = async () => undefined; ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Ordinary subagent-named tool', ctx.dataDir);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent });
    await ctx.manager.send(session.id, { text: 'Controlled other Agent compatibility' }, 'ordinary-child-command-' + agent);
    const data: EventData['tool.call'] = { name: 'subagent', input: { agent, childId: 'ordinary-child', parentThreadId: 'ordinary-parent', nativeStatus: 'completed' },
      output: { command: { nativeTurnId: turnId, itemId, native: command('completed', 'ordinary bytes') } }, status: 'completed' };
    emit(session.id, { type: 'item.complete', kind: 'tool.call', itemKey: 'ordinary-subagent', data, native: {}, runtime: opts.runtime });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 }); const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener'); const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(base + '/s/' + session.id); await page.reload();
    expect(await page.getByTestId('codex-child-command').count()).toBe(0);
    expect(ctx.store.allEvents(session.id).find(event => event.itemKey === 'ordinary-subagent')?.data).toEqual(data);
  } finally { await browser?.close(); await ctx.close(); }
}, 30_000);
