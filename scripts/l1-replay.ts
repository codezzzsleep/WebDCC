import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterEvent, EventData, EventKind, OpenItem, StoredEvent, TraceFrame, TurnView } from '../packages/protocol/src/index.js';
import { checkTurnInvariants, reduceTurn, resolveAnswer } from '../packages/protocol/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';
import { DshAdapter } from '../packages/adapters/dsh/src/adapter.js';

interface Failure { id: string; frame: number; message: string; }
interface Result {
  fixture: string;
  frames: number;
  invariants: { passed: number; total: number; failures: Failure[] };
  views?: TurnView[];
  error?: string;
}

function parseFrames(text: string): TraceFrame[] {
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as TraceFrame);
}

function event(sessionId: string, seq: number, turnId: string | null, kind: EventKind, itemKey: string, data: unknown, native?: unknown): StoredEvent {
  return { sessionId, seq, turnId, kind, itemKey, data: data as never, at: new Date(seq * 1000).toISOString(), ...(native === undefined ? {} : { native }) };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function promptOf(frame: TraceFrame): string | undefined {
  if (frame.dir !== 'out') return undefined;
  const raw = record(frame.frame);
  if (typeof raw['text'] === 'string') return raw['text'];
  const params = record(raw['params']);
  const input = Array.isArray(params['input']) ? params['input'] as unknown[] : [];
  return input.map((part) => record(part)['text']).find((value): value is string => typeof value === 'string');
}

function adapterFor(agent: string): { feed: (frame: TraceFrame) => AdapterEvent[]; deltas: Set<string> } {
  const handler = agent === 'codex' ? CodexAdapter.replay() : agent === 'claude-code' ? ClaudeAdapter.replay() : DshAdapter.replay();
  return { feed: handler.feed, deltas: new Set() };
}

/** Expected files deliberately ignore transport timestamps while retaining
 * item ids, native evidence, and the complete step sequence. */
function normalise(value: unknown, key?: string): unknown {
  if (key === 'at' || key === 'startedAt' || key === 'endedAt') return '<timestamp>';
  if (Array.isArray(value)) return value.map((item) => normalise(item));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) out[childKey] = normalise(child, childKey);
    return out;
  }
  return value;
}

function viewFor(events: StoredEvent[], open: Map<string, OpenItem>, turnId: string): TurnView {
  return reduceTurn(events.filter((item) => item.turnId === turnId), [...open.values()].filter((item) => item.turnId === turnId));
}

async function runFixture(fixture: string, writeExpected: boolean): Promise<Result> {
  const meta = JSON.parse(await readFile(join(fixture, 'meta.json'), 'utf8')) as { agent: string; scenario: string; prompt?: string };
  const frames = parseFrames(await readFile(join(fixture, 'native.jsonl'), 'utf8'));
  const { feed, deltas } = adapterFor(meta.agent);
  const sessionId = `trace:${meta.agent}:${meta.scenario}`;
  let seq = 0;
  let turnNumber = 0;
  let activeTurn: string | null = null;
  const events: StoredEvent[] = [];
  const open = new Map<string, OpenItem>();
  const failures: Failure[] = [];
  const checkedTerminal = new Set<string>();

  const startTurn = (prompt: string): string => {
    const turnId = `${sessionId}:turn:${++turnNumber}`;
    activeTurn = turnId;
    events.push(event(sessionId, ++seq, turnId, 'user.message', `user-${turnId}`, { text: prompt }));
    events.push(event(sessionId, ++seq, turnId, 'turn.started', `turn-start-${turnId}`, {}));
    return turnId;
  };
  // The server writes these two events before it invokes adapter.send().
  startTurn(meta.prompt ?? '');

  for (const [frameIndex, frame] of frames.entries()) {
    const translated = feed(frame);
    const method = typeof frame.frame === 'object' && frame.frame !== null ? String((frame.frame as Record<string, unknown>)['method'] ?? '') : '';
    if (translated.length === 0 && !deltas.has(method)) failures.push({ id: 'I8', frame: frameIndex + 1, message: `帧 ${method || frame.ch} 没有产生事件且未登记 delta` });

    // S10 contains two sends in one native recording. The outgoing input is
    // the boundary at which the server would have allocated the next ULID.
    if (activeTurn === null) {
      const prompt = promptOf(frame);
      if (prompt !== undefined) startTurn(prompt);
    }
    for (const adapterEvent of translated) {
      if (adapterEvent.type === 'turn.start') {
        if (activeTurn === null) startTurn(promptOf(frame) ?? '');
        continue;
      }
      const turnId = activeTurn;
      if (turnId === null) continue; // late frames after a completed turn are orphans
      if (adapterEvent.type === 'item.start') {
        open.set(adapterEvent.itemKey, { itemKey: adapterEvent.itemKey, kind: adapterEvent.kind, data: adapterEvent.data as EventData[EventKind], turnId });
      } else if (adapterEvent.type === 'item.delta') {
        const item = open.get(adapterEvent.itemKey);
        if (item !== undefined) {
          const data = item.data as { text?: string; outputTail?: string };
          if (adapterEvent.field === 'text') data.text = `${data.text ?? ''}${adapterEvent.append}`;
          else data.outputTail = `${data.outputTail ?? ''}${adapterEvent.append}`;
        }
      } else if (adapterEvent.type === 'item.update') {
        const item = open.get(adapterEvent.itemKey);
        if (item !== undefined) item.data = adapterEvent.data as EventData[EventKind];
      } else if (adapterEvent.type === 'item.cancel') {
        open.delete(adapterEvent.itemKey);
      } else if (adapterEvent.type === 'item.complete') {
        open.delete(adapterEvent.itemKey);
        events.push(event(sessionId, ++seq, turnId, adapterEvent.kind, adapterEvent.itemKey, adapterEvent.data, adapterEvent.native));
      } else if (adapterEvent.type === 'turn.end') {
        const answerKeys = resolveAnswer(events.filter((item) => item.turnId === turnId)).map((answer) => answer.itemKey);
        events.push(event(sessionId, ++seq, turnId, 'turn.completed', `turn-end-${turnId}`, { status: adapterEvent.status, durationMs: 0, answerItemKeys: answerKeys }, adapterEvent.native));
        open.clear();
        activeTurn = null;
      }
    }

    const turnIds = [...new Set(events.map((item) => item.turnId).filter((id): id is string => id !== null))];
    for (const turnId of turnIds) {
      const view = viewFor(events, open, turnId);
      if (turnId === activeTurn || (['completed', 'interrupted', 'failed'].includes(view.state) && !checkedTerminal.has(turnId))) {
        failures.push(...checkTurnInvariants(events.filter((item) => item.turnId === turnId), view, turnId === activeTurn
          ? { frame: frameIndex + 1, inputProducedEvent: translated.length > 0, deltaFrame: translated.length === 0 }
          : { frame: frameIndex + 1 }));
        if (['completed', 'interrupted', 'failed'].includes(view.state)) checkedTerminal.add(turnId);
      }
    }
  }

  const turnIds = [...new Set(events.map((item) => item.turnId).filter((id): id is string => id !== null))];
  const views = turnIds.map((turnId) => viewFor(events, open, turnId));
  for (const [index, view] of views.entries()) {
    if (!['completed', 'interrupted', 'failed'].includes(view.state)) failures.push({ id: 'I1', frame: frames.length, message: `轮次 ${index + 1} 没有终止事件` });
  }
  const finalView = views.at(-1);
  const finalPath = join(fixture, 'reference', 'final.txt');
  const reference = await readFile(finalPath, 'utf8').catch(() => undefined);
  if (reference !== undefined && finalView !== undefined) {
    const actual = finalView.answer.map((item) => item.text).join('\n');
    if (actual !== reference.replace(/\r\n/g, '\n')) failures.push({ id: 'I5', frame: frames.length, message: `最终回答与 reference/final.txt 不一致 (${actual.length}/${reference.length})` });
  }

  const expectedPath = join(fixture, 'expected.turns.json');
  const actualNormalised = normalise(views);
  if (writeExpected) {
    await writeFile(expectedPath, JSON.stringify(actualNormalised, null, 2) + '\n');
  } else {
    const expectedText = await readFile(expectedPath, 'utf8').catch(() => undefined);
    if (expectedText === undefined) failures.push({ id: 'GOLDEN', frame: frames.length, message: '缺少 expected.turns.json；先运行 pnpm l1:update' });
    else {
      try {
        if (JSON.stringify(normalise(JSON.parse(expectedText))) !== JSON.stringify(actualNormalised)) failures.push({ id: 'GOLDEN', frame: frames.length, message: 'TurnView 与 expected.turns.json 不一致' });
      } catch (error) {
        failures.push({ id: 'GOLDEN', frame: frames.length, message: `expected.turns.json 不是有效 JSON：${String(error)}` });
      }
    }
  }
  const total = frames.length;
  return { fixture, frames: total, invariants: { passed: Math.max(0, total - failures.length), total, failures }, views };
}

const root = process.argv[2] ?? 'fixtures/traces';
const writeExpected = process.argv.includes('--write-expected');
const results: Result[] = [];
async function walk(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  if (entries.some((entry) => entry.name === 'native.jsonl')) { results.push(await runFixture(path, writeExpected)); return; }
  for (const entry of entries) if (entry.isDirectory()) await walk(join(path, entry.name));
}
await walk(root);
const failures = results.flatMap((result) => result.invariants.failures.map((failure) => ({ fixture: result.fixture, ...failure })));
process.stdout.write(JSON.stringify({ fixtures: results.length, frames: results.reduce((sum, result) => sum + result.frames, 0), passed: results.reduce((sum, result) => sum + result.invariants.passed, 0), total: results.reduce((sum, result) => sum + result.invariants.total, 0), failures }, null, 2) + '\n');
if (failures.length > 0) process.exitCode = 1;
