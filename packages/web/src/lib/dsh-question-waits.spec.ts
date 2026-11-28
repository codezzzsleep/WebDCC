import { afterEach, expect, it, vi } from 'vitest';
import type { DshQuestionIdentity, DshQuestionWaitRequest } from '@webdcc/protocol';
import { DshQuestionWaits } from './dsh-question-waits.js';

const identity: DshQuestionIdentity = { nativeId: 'native', callId: 'call', itemId: 'one', timed: true, phase: 'open' };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function browser() {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const sent: DshQuestionWaitRequest[] = [];
  const waits = new DshQuestionWaits(message => sent.push(message), () => undefined);
  return { waits, sent, storage };
}

it('one native call shares one countdown across its question items and late openings from old sockets are ignored', () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { waits, sent } = browser();
  const first = waits.ensure('session', 'event:one', identity, true);
  const second = waits.ensure('session', 'event:two', { ...identity, itemId: 'two' }, true);
  expect(first).toBe(second); expect(sent).toHaveLength(1);
  const old = sent[0]!;
  waits.disconnect();
  waits.ensure('session', 'event:one', identity, true);
  waits.message({ ...old, op: 'dsh-question-wait', result: { kind: 'claim', callId: 'call', remainingMs: 100, claimId: 'old' } });
  expect(first.card.snapshot().channel).toBe('none');
  const current = sent[1]!;
  waits.message({ ...current, op: 'dsh-question-wait', result: { kind: 'claim', callId: 'call', remainingMs: 60000, claimId: 'current' } });
  expect(first.card.snapshot()).toMatchObject({ countdown: { remainingMs: 60000, running: true }, channel: 'waterfall' });
  waits.disconnect();
});

it('focus freezes a pristine countdown, blur resumes its remaining duration, and an unmounted card still times out once', () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { waits, sent } = browser(); const entry = waits.ensure('session', 'event:one', identity, true);
  waits.message({ ...sent[0]!, op: 'dsh-question-wait', result: { kind: 'claim', claimId: 'claim', callId: 'call', remainingMs: 60000 } });
  vi.advanceTimersByTime(10000); entry.card.holdFocus();
  vi.advanceTimersByTime(30000);
  expect(entry.card.snapshot()).toMatchObject({ waitState: 'focused', countdown: { remainingMs: 50000, running: false } });
  entry.card.releaseFocus(); vi.advanceTimersByTime(49000);
  expect(sent.some(message => message.action === 'timeout')).toBe(false);
  vi.advanceTimersByTime(1000); vi.advanceTimersByTime(10000);
  expect(sent.filter(message => message.action === 'timeout')).toHaveLength(1);
  expect(entry.card.snapshot().channel).toBe('none');
  waits.disconnect();
});

for (const mode of ['editing', 'waiting'] as const) it(`${mode} survives new openings and a client restart with its native call draft`, () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { waits, sent } = browser(); const entry = waits.ensure('session', 'event:one', identity, true);
  waits.drafts.save('session', identity, mode, { selected: ['Original label'], custom: '  original answer\r\n' });
  if (mode === 'editing') entry.card.engage(); else entry.card.takeTime();
  waits.message({ ...sent[0]!, op: 'dsh-question-wait', result: { kind: 'claim', claimId: 'claim', callId: 'call', remainingMs: 1000 } });
  vi.advanceTimersByTime(10000);
  expect(entry.card.snapshot()).toMatchObject({ waitState: mode, countdown: { remainingMs: 0, running: false } });
  waits.disconnect();
  const restored = new DshQuestionWaits(message => sent.push(message), () => undefined);
  const newEntry = restored.ensure('session', 'new-event:one', identity, true);
  expect(newEntry.card.snapshot().waitState).toBe(mode);
  expect(restored.drafts.read('session', identity)).toEqual({ selected: ['Original label'], custom: '  original answer\r\n' });
  expect(restored.drafts.read('session', { ...identity, nativeId: 'other-native' })).toEqual({ selected: [], custom: '' });
  restored.finish('session', identity);
  expect(restored.drafts.read('session', identity)).toEqual({ selected: [], custom: '' });
});
