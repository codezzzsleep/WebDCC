import { expect, it } from 'vitest';
import { isInputContent, publicInputContent } from './input.js';
import { isCommand } from './command-validation.js';
import { checkTurnInvariants } from './invariants.js';
import { reduceTurn } from './turn.js';
import type { StoredEvent } from './events.js';

it('structured text remains exact and browser references cannot smuggle paths, receipts or unknown fields', () => {
  const text = '  原文\r\n  ';
  const content = { version: 1, parts: [{ type: 'text', text }, { type: 'file', fileId: 'file-1', name: 'chosen.txt' }] };
  expect(isInputContent(content, text)).toBe(true);
  expect(isInputContent(content, text.trim())).toBe(false);
  for (const extra of [{ path: '/private/path' }, { receiptId: 'native-authority' }, { hidden: true }]) {
    expect(isInputContent({ ...content, parts: [content.parts[0], { ...content.parts[1], ...extra }] }, text)).toBe(false);
  }
  expect(isCommand({ op: 'send', clientCommandId: 'command', sessionId: 'session', text, contentParts: content, intent: 'steer', expectedTurnId: 'turn' })).toBe(true);
  expect(isCommand({ op: 'send', clientCommandId: 'command', sessionId: 'session', text, contentParts: content, images: ['file-1'] })).toBe(false);
});
it('native attachment paths stay server-side while hash, size, name and text element byte ranges survive', () => {
  const source = { version: 1 as const, parts: [{ type: 'file' as const, fileId: 'file', name: 'chosen.txt', path: '/cas/object', mime: 'text/plain', sha256: 'a'.repeat(64), size: 3 }] };
  const published = publicInputContent(source); expect(isInputContent(published, '')).toBe(true); expect(published.parts[0]).not.toHaveProperty('path');
  expect(isInputContent(publicInputContent({ ...source, version: 2 } as never), '')).toBe(false);
  expect(isInputContent({ version: 1, parts: [{ type: 'text', text: '你', elements: [{ byteRange: { start: 0, end: 3 }, placeholder: null }] }] }, '你')).toBe(true);
  expect(isInputContent({ version: 1, parts: [{ type: 'text', text: '你', elements: [{ byteRange: { start: 0, end: 4 }, placeholder: null }] }] }, '你')).toBe(false);
});
it('one turn can retain a distinctly admitted steer input without accepting duplicate ordinary messages', () => {
  const events: StoredEvent[] = [
    { sessionId: 's', seq: 1, turnId: 't', itemKey: 'first', kind: 'user.message', data: { text: 'first', clientCommandId: 'initial' }, at: '2026-01-01T00:00:00Z' },
    { sessionId: 's', seq: 2, turnId: 't', itemKey: 'steer', kind: 'user.message', data: { text: 'next', clientCommandId: 'steer-command', intent: 'steer' }, at: '2026-01-01T00:00:01Z' },
  ];
  expect(reduceTurn(events).inputs?.map(input => input.text)).toEqual(['first', 'next']);
  expect(checkTurnInvariants(events, reduceTurn(events))).toEqual([]);
  (events[1]!.data as { intent?: string }).intent = 'send';
  expect(checkTurnInvariants(events, reduceTurn(events)).some(failure => failure.id === 'I3')).toBe(true);
});
