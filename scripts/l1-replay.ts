import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterEvent, EventData, EventKind, OpenItem, StoredEvent, TurnView, TraceFrame } from '../packages/protocol/src/index.js';
import { checkTurnInvariants, reduceTurn, resolveAnswer } from '../packages/protocol/src/index.js';
import { CodexTranslator, DELTA_FRAMES as CODEX_DELTAS } from '../packages/adapters/codex/src/translator.js';
import { ClaudeTranslator, DELTA_FRAMES as CLAUDE_DELTAS } from '../packages/adapters/claude/src/translator.js';
import { DshTranslator, DELTA_FRAMES as DSH_DELTAS } from '../packages/adapters/dsh/src/translator.js';

interface Result { fixture: string; frames: number; invariants: { passed: number; total: number; failures: { id: string; frame: number; message: string }[] }; view?: TurnView; error?: string; }

function parseFrames(text: string): TraceFrame[] { return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as TraceFrame); }
function event(sessionId: string, seq: number, turnId: string | null, kind: EventKind, itemKey: string, data: unknown, native?: unknown): StoredEvent {
  return { sessionId, seq, turnId, kind, itemKey, data: data as never, at: new Date(seq * 1000).toISOString(), ...(native === undefined ? {} : { native }) };
}
function viewFor(events: StoredEvent[], open: Map<string, OpenItem>, turnId: string): TurnView { return reduceTurn(events.filter((item) => item.turnId === turnId), [...open.values()]); }
function adapterFor(agent: string): { feed: (frame: TraceFrame) => AdapterEvent[]; deltas: Set<string> } {
  if (agent === 'codex') { const translator = new CodexTranslator(); return { feed: (frame) => translator.feed(frame), deltas: CODEX_DELTAS }; }
  if (agent === 'claude-code') { const translator = new ClaudeTranslator(); return { feed: (frame) => translator.feed(frame), deltas: CLAUDE_DELTAS }; }
  const translator = new DshTranslator(); return { feed: (frame) => translator.feed(frame), deltas: DSH_DELTAS };
}

async function runFixture(fixture: string, writeExpected: boolean): Promise<Result> {
  const meta = JSON.parse(await readFile(join(fixture, 'meta.json'), 'utf8')) as { agent: string; scenario: string; prompt?: string };
  const frames = parseFrames(await readFile(join(fixture, 'native.jsonl'), 'utf8'));
  const { feed, deltas } = adapterFor(meta.agent);
  const sessionId = `trace:${meta.agent}:${meta.scenario}`;
  let turnId = '';
  let seq = 0;
  let currentTurn = 0;
  let finalTurnId = '';
  const events: StoredEvent[] = [];
  const open = new Map<string, OpenItem>();
  const failures: { id: string; frame: number; message: string }[] = [];
  const userText = meta.prompt ?? '';
  if (userText !== '') events.push(event(sessionId, ++seq, null, 'user.message', `user-${meta.scenario}`, { text: userText }));

  for (const [frameIndex, frame] of frames.entries()) {
    const translated = feed(frame);
    const method = typeof frame.frame === 'object' && frame.frame !== null ? String((frame.frame as Record<string, unknown>)['method'] ?? '') : '';
    if (translated.length === 0 && !deltas.has(method)) failures.push({ id: 'I8', frame: frameIndex + 1, message: `帧 ${method || frame.ch} 没有产生事件且未登记 delta` });
    if (turnId === '' && translated.length > 0 && !(translated.length === 1 && translated[0]?.type === 'item.complete' && translated[0].kind === 'internal' && frame.dir === 'out')) {
      currentTurn += 1;
      turnId = `${sessionId}:turn:${currentTurn}`;
      finalTurnId = turnId;
      events.push(event(sessionId, ++seq, turnId, 'turn.started', `turn-start-${currentTurn}`, {}));
    }
    for (const adapterEvent of translated) {
      if (adapterEvent.type === 'turn.start') {
        currentTurn += 1;
        turnId = `${sessionId}:turn:${currentTurn}`;
        finalTurnId = turnId;
        events.push(event(sessionId, ++seq, turnId, 'turn.started', `turn-start-${currentTurn}`, {}));
        continue;
      }
      if (turnId === '') continue;
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
        events.push(event(sessionId, ++seq, turnId, 'turn.completed', `turn-end-${currentTurn}`, { status: adapterEvent.status, durationMs: 0, answerItemKeys: answerKeys }, adapterEvent.native));
        open.clear();
        turnId = '';
      }
    }
    if (turnId !== '') {
      const view = viewFor(events, open, turnId);
      const checked = checkTurnInvariants(events.filter((item) => item.turnId === turnId), view, { frame: frameIndex + 1, inputProducedEvent: translated.length > 0, deltaFrame: translated.length === 0 });
      failures.push(...checked);
    }
  }
  if (finalTurnId === '') return { fixture, frames: frames.length, invariants: { passed: 0, total: frames.length, failures }, error: '轨迹没有 turn.start' };
  const finalView = viewFor(events, open, finalTurnId);
  const finalPath = join(fixture, 'reference', 'final.txt');
  const reference = await readFile(finalPath, 'utf8').catch(() => undefined);
  if (reference !== undefined) {
    const actual = finalView.answer.map((item) => item.text).join('\n');
    const normalized = (value: string): string => value.replace(/\r\n/g, '\n').trim();
    if (normalized(actual) !== normalized(reference)) failures.push({ id: 'I5', frame: frames.length, message: `最终回答与 reference/final.txt 不一致 (${actual.length}/${reference.length})` });
  }
  if (writeExpected) {
    const clean = JSON.parse(JSON.stringify(finalView)) as TurnView;
    clean.startedAt = '<timestamp>';
    delete clean.endedAt;
    await writeFile(join(fixture, 'expected.turns.json'), JSON.stringify([clean], null, 2) + '\n');
  }
  const total = frames.length;
  return { fixture, frames: frames.length, invariants: { passed: total - failures.length, total, failures }, view: finalView };
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
