import { expect, it } from 'vitest';
import { currentCodexSubagents, isValidEventData, type AdapterEvent, type CodexSubagentView, type StoredEvent } from '@webdcc/protocol';
import { CodexAdapter } from '../src/adapter.js';
import type { ThreadItem } from '../src/schema/v2/ThreadItem.js';
import type { CommandExecutionOutputDeltaNotification } from '../src/schema/v2/CommandExecutionOutputDeltaNotification.js';

type CommandItem = Extract<ThreadItem, { type: 'commandExecution' }>;
const parent = 'parent:command:string';
const itemId = 'same:command:🐈';
const command = (status: CommandItem['status'] = 'inProgress', output: string | null = null): CommandItem => ({
  type: 'commandExecution', id: itemId, pluginId: null, scriptPath: null, command: 'native original command',
  cwd: '/native/child-workspace', processId: 'native:pty:id', source: 'agent', status, commandActions: [],
  aggregatedOutput: output, exitCode: status === 'failed' ? 7 : status === 'completed' ? 0 : null, durationMs: null,
});

function fixture(seed: readonly CodexSubagentView[] = [], prior: readonly StoredEvent[] = [], startParent = true) {
  const replay = CodexAdapter.replay('session', parent, seed); const events: AdapterEvent[] = []; const stored = [...prior]; let index = 0;
  const feed = (method: string, params: Record<string, unknown>) => {
    const emitted = replay.feed({ i: ++index, t: index, dir: 'in', ch: 'rpc', frame: { method, params } }); events.push(...emitted);
    for (const event of emitted) if (event.type === 'item.complete') {
      expect(isValidEventData(event.kind, event.data)).toBe(true);
      stored.push({ sessionId: 'session', seq: stored.length + 1, turnId: null, itemKey: event.itemKey, at: 'controlled',
        kind: event.kind, data: event.data as StoredEvent['data'], native: event.native });
    }
    return emitted;
  };
  const start = (childId = 'child-a', turnId = 'child-turn', observedTurn = true) => {
    feed('item/completed', { threadId: parent, turnId: 'parent-turn', item: { type: 'collabAgentToolCall', id: 'spawn-' + childId,
      tool: 'spawnAgent', status: 'completed', senderThreadId: parent, receiverThreadIds: [childId], prompt: null, model: null,
      reasoningEffort: null, agentsStates: observedTurn ? {} : { [childId]: { status: 'completed', message: null } },
    } satisfies ThreadItem });
    if (observedTurn) feed('turn/started', { threadId: childId, turn: { id: turnId, status: 'inProgress' } });
  };
  const begin = (item = command(), childId = 'child-a', turnId = 'child-turn') =>
    feed('item/started', { threadId: childId, turnId, item, startedAtMs: 1 });
  const delta = (text: string, childId = 'child-a', turnId = 'child-turn', id = itemId) =>
    feed('item/commandExecution/outputDelta', { threadId: childId, turnId, itemId: id, delta: text } satisfies CommandExecutionOutputDeltaNotification);
  const complete = (item = command('completed', 'native final'), childId = 'child-a', turnId = 'child-turn') =>
    feed('item/completed', { threadId: childId, turnId, item, completedAtMs: 2 });
  const end = (status: string, childId = 'child-a', turnId = 'child-turn') => feed('turn/completed', { threadId: childId, turn: { id: turnId, status } });
  const children = () => currentCodexSubagents(stored);
  const commands = (childId = 'child-a') => children().find(child => child.childId === childId)?.commands ?? [];
  if (startParent) feed('turn/started', { threadId: parent, turn: { id: 'parent-turn', status: 'inProgress' } });
  return { feed, start, begin, delta, complete, end, children, commands, events, stored };
}

it('keeps two known native child command streams and matching item IDs separate without a parent command or turn', () => {
  const f = fixture(); f.start('child-a', 'shared:turn'); f.start('child-b', 'shared:turn');
  const first = command(); const second = { ...command(), command: 'B original', cwd: '/native/B', processId: null };
  Object.freeze(first); Object.freeze(second);
  f.begin(first, 'child-a', 'shared:turn'); f.begin(second, 'child-b', 'shared:turn');
  f.delta(' 原生🐈\r\n', 'child-a', 'shared:turn'); f.delta(' 原生🐈\r\n', 'child-a', 'shared:turn');
  f.delta('<script>literal B</script>', 'child-b', 'shared:turn');
  expect(f.commands('child-a')).toEqual([{ nativeTurnId: 'shared:turn', itemId, native: first,
    output: ' 原生🐈\r\n 原生🐈\r\n', streamedOutput: ' 原生🐈\r\n 原生🐈\r\n', incomplete: true }]);
  expect(f.commands('child-b')).toEqual([{ nativeTurnId: 'shared:turn', itemId, native: second,
    output: '<script>literal B</script>', streamedOutput: '<script>literal B</script>', incomplete: true }]);
  expect(f.events.filter(event => event.type === 'turn.start')).toHaveLength(1);
  expect(f.events.some(event => 'kind' in event && event.kind === 'command')).toBe(false);
  expect(f.children().every(child => child.parentThreadId === parent)).toBe(true);
});

it('keeps the initial native output plus deltas while duplicate starts cannot reset captured bytes', () => {
  const f = fixture(); f.start(); const item = command('inProgress', 'initial ');
  f.begin(item); f.delta('stdout/stderr\r\n'); f.begin(item);
  expect(f.commands()).toEqual([{ nativeTurnId: 'child-turn', itemId, native: item,
    output: 'initial stdout/stderr\r\n', streamedOutput: 'initial stdout/stderr\r\n', incomplete: true }]);
});

it('keeps early output before native command metadata arrives and a delayed start cannot erase it', () => {
  const f = fixture(); f.start(); f.delta('first observed chunk');
  expect(f.commands()).toEqual([{ nativeTurnId: 'child-turn', itemId, output: 'first observed chunk', streamedOutput: 'first observed chunk', incomplete: true }]);
  const item = command(); f.begin(item);
  expect(f.commands()).toEqual([{ nativeTurnId: 'child-turn', itemId, native: item,
    output: 'first observed chunk', streamedOutput: 'first observed chunk', incomplete: true }]);
});

it('uses the full original completed aggregate and exit result while retaining the captured progress separately', () => {
  const f = fixture(); f.start(); f.begin(); f.delta('observed temporary prefix');
  const full = Array.from({ length: 250 }, (_, n) => '原始行:' + n + '\r\n').join('') + '🐈<script>literal</script>';
  const original = { ...command('failed', full), pluginId: 'native:plugin', scriptPath: 'original/script', durationMs: 12 };
  Object.freeze(original); f.complete(original);
  expect(f.commands()).toEqual([{ nativeTurnId: 'child-turn', itemId, native: original, output: full, streamedOutput: 'observed temporary prefix' }]);
  const event = f.events.find(event => event.type === 'item.complete' && event.kind === 'tool.call'
    && (event.data as { output?: { command?: unknown } }).output?.command !== undefined);
  expect(event).toMatchObject({ scope: 'session', native: { method: 'item/completed', params: { threadId: 'child-a', turnId: 'child-turn', item: original } },
    data: { name: 'subagent', output: { command: { nativeTurnId: 'child-turn', itemId, native: original } } } });
  expect(f.children()[0]?.nativeStatus).toBe('running');
});

it.each(['', null])('retains captured progress separately from the original %s completed aggregate', aggregate => {
  const f = fixture(); f.start(); f.begin(); f.delta('captured bytes'); const item = command('completed', aggregate); f.complete(item);
  expect(f.commands()).toEqual([{ nativeTurnId: 'child-turn', itemId, native: item,
    output: aggregate === null ? 'captured bytes' : '', streamedOutput: 'captured bytes' }]);
});

it('keeps late starts, deltas and duplicate completions in raw evidence without reopening or replacing a completed command', () => {
  const f = fixture(); f.start(); f.complete(); const before = JSON.stringify(f.commands());
  const late = f.delta('obsolete suffix'); f.begin(); f.complete(command('failed', 'obsolete result'));
  expect(JSON.stringify(f.commands())).toBe(before);
  expect(late).toEqual([expect.objectContaining({ kind: 'internal', scope: 'session', native: {
    method: 'item/commandExecution/outputDelta', params: { threadId: 'child-a', turnId: 'child-turn', itemId, delta: 'obsolete suffix' },
  } })]);
});

it.each(['interrupted', 'failed', 'completed'])('keeps command output incomplete when only the native child turn %s was observed', status => {
  const f = fixture(); f.start(); f.begin(); f.delta('unfinished output'); f.end(status); f.delta('late'); f.begin();
  expect(f.commands()).toEqual([{ nativeTurnId: 'child-turn', itemId, native: command(), output: 'unfinished output', streamedOutput: 'unfinished output', incomplete: true }]);
  expect(f.children()[0]).toMatchObject({ nativeStatus: status, turns: { 'child-turn': { status } } });
});

it('keeps a late previous-turn command result without overwriting a new child turn or matching current item ID', () => {
  const f = fixture(); f.start(); f.begin(); f.delta('old progress'); f.end('interrupted');
  f.feed('turn/started', { threadId: 'child-a', turn: { id: 'new-turn', status: 'inProgress' } }); f.begin(command(), 'child-a', 'new-turn');
  f.delta('current progress', 'child-a', 'new-turn'); f.complete(command('failed', 'old terminal result'));
  expect(f.children()[0]).toMatchObject({ nativeTurnId: 'new-turn', nativeStatus: 'running' });
  expect(f.commands()).toContainEqual({ nativeTurnId: 'child-turn', itemId, native: command('failed', 'old terminal result'), output: 'old terminal result', streamedOutput: 'old progress' });
  expect(f.commands()).toContainEqual({ nativeTurnId: 'new-turn', itemId, native: command(), output: 'current progress', streamedOutput: 'current progress', incomplete: true });
});

it('continues a restored partial stream, restores terminal fences and keeps passive command data outside child identity', () => {
  const first = fixture(); first.start(); first.begin(); first.delta('before reconnect ');
  const next = fixture(first.children(), first.stored, false); next.delta('after reconnect'); next.complete(); next.end('completed');
  expect(next.commands()).toEqual([{ nativeTurnId: 'child-turn', itemId, native: command('completed', 'native final'), output: 'native final', streamedOutput: 'before reconnect after reconnect' }]);
  const restored = fixture(next.children(), next.stored, false); restored.delta('obsolete'); restored.begin(); restored.complete(command('failed'));
  expect(restored.commands()).toEqual(next.commands());
  expect(restored.events.every(event => 'kind' in event && event.kind === 'internal')).toBe(true);
  expect(next.events.filter(event => event.type === 'item.complete' && event.kind === 'tool.call')
    .every(event => event.type === 'item.complete' && event.kind === 'tool.call' && !Object.hasOwn((event.data as { input: object }).input, 'commands'))).toBe(true);
  expect(next.events.some(event => event.type === 'turn.start' || event.type === 'turn.end')).toBe(false);
});

it('restores an incomplete terminal stream without reopening it but accepts the later native command completion', () => {
  const first = fixture(); first.start(); first.begin(); first.delta('interrupted prefix'); first.end('interrupted');
  const next = fixture(first.children(), first.stored, false); next.delta('late suffix'); next.begin();
  expect(next.commands()).toEqual(first.commands()); next.complete(command('failed', 'late native output'));
  expect(next.commands()).toEqual([{ nativeTurnId: 'child-turn', itemId, native: command('failed', 'late native output'), output: 'late native output', streamedOutput: 'interrupted prefix' }]);
  expect(next.children()[0]?.nativeStatus).toBe('interrupted');
});

it('keeps two identical output chunks as progress even when a caller snapshot says the child entity is completed', () => {
  const f = fixture(); f.start('child-a', 'child-turn', false); f.begin(); f.delta('same'); f.delta('same');
  expect(f.commands()[0]).toMatchObject({ output: 'samesame', streamedOutput: 'samesame', incomplete: true });
  expect(f.children()[0]).toMatchObject({ nativeStatus: 'completed', turns: {} });
  const progress = f.events.filter(event => event.type === 'item.complete' && event.kind === 'tool.call'
    && (event.data as { output?: { commandDelta?: unknown } }).output?.commandDelta !== undefined);
  expect(progress).toHaveLength(2); expect(progress.every(event => event.type === 'item.complete' && event.kind === 'tool.call'
    && (event.data as { status: string }).status === 'running')).toBe(true);
});

it('keeps unknown lineage and malformed command identities in raw records and preserves ordinary parent commands', () => {
  const f = fixture(); f.delta('foreign', 'foreign'); f.begin(command(), 'foreign'); f.complete(command(), 'foreign'); f.start();
  f.delta('missing turn', 'child-a', ''); f.delta('missing item', 'child-a', 'child-turn', ''); f.begin({ ...command(), id: '' });
  expect(f.commands()).toEqual([]); expect(f.children()).toHaveLength(1);
  const parentEvent = f.begin(command(), parent, 'parent-turn'); expect(parentEvent).toContainEqual(expect.objectContaining({ type: 'item.start', kind: 'command', nativeTurnId: 'parent-turn' }));
});
