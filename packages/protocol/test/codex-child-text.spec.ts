import { expect, it } from 'vitest';
import { currentCodexSubagents, type StoredEvent } from '../src/index.js';

function event(output: unknown, seq: number): StoredEvent<'tool.call'> {
  return { sessionId: 'session', seq, turnId: null, itemKey: 'native-child', at: 'controlled', kind: 'tool.call', native: {},
    data: { name: 'subagent', input: { agent: 'codex', childId: 'child', parentThreadId: 'parent', nativeStatus: 'running' },
      output, status: 'running' } };
}

function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

it('rebuilds partial text from frozen stored rows without mutating their original delta, initial text or native metadata', () => {
  const rows = [event({ resultStart: { nativeTurnId: 'turn', itemId: 'item', text: '初始 ', nativePhase: null } }, 1),
    event({ resultDelta: { nativeTurnId: 'turn', itemId: 'item', text: '🐈\r\n' } }, 2)];
  const original = JSON.stringify(rows); freeze(rows);
  expect(currentCodexSubagents(rows)[0]?.results).toEqual([
    { nativeTurnId: 'turn', itemId: 'item', text: '初始 🐈\r\n', nativePhase: null, incomplete: true },
  ]);
  expect(JSON.stringify(rows)).toBe(original);
});

it('preserves an empty authoritative final and ignores replayed partial observations after it', () => {
  const rows = [event({ resultDelta: { nativeTurnId: 'turn', itemId: 'item', text: 'temporary' } }, 1),
    event({ result: { nativeTurnId: 'turn', itemId: 'item', text: '', nativePhase: null } }, 2),
    event({ resultDelta: { nativeTurnId: 'turn', itemId: 'item', text: 'late' } }, 3)];
  const original = JSON.stringify(rows); freeze(rows);
  expect(currentCodexSubagents(rows)[0]?.results).toEqual([{ nativeTurnId: 'turn', itemId: 'item', text: '', nativePhase: null }]);
  expect(JSON.stringify(rows)).toBe(original);
});

it('does not guess a missing streaming identity or revive partial text after a stored native terminal', () => {
  const rows = [event({ resultDelta: { itemId: 'missing-turn', text: 'unassignable' } }, 1),
    event({ resultDelta: { nativeTurnId: 'turn', itemId: 'item', text: 'retained' } }, 2),
    event({ turn: { id: 'turn', status: 'interrupted' } }, 3),
    event({ resultStart: { nativeTurnId: 'turn', itemId: 'item', text: 'obsolete' } }, 4),
    event({ resultDelta: { nativeTurnId: 'turn', itemId: 'item', text: 'late' } }, 5)];
  expect(currentCodexSubagents(rows)[0]?.results).toEqual([{ nativeTurnId: 'turn', itemId: 'item', text: 'retained', incomplete: true }]);
});
