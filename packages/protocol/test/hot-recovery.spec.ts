import { expect, it } from 'vitest';
import { reduceTurn, type HotObservation, type StoredEvent } from '../src/index.js';

const observation: HotObservation = { state: 'lost', identity: { ownerId: 'original owner', generation: 1, hostId: 'original host' }, origins: [] };
const events: StoredEvent[] = [{ seq: 1, sessionId: 's', turnId: 'original public turn', itemKey: 'start', kind: 'turn.started', data: {}, at: '2026-11-17T00:00:00Z' }];
it('loss of Web observation retains original running data and does not infer native terminal or activity', () => {
  const data = { command: 'original command', status: 'running' as const, outputTail: 'original output' };
  const turn = reduceTurn(events, [{ itemKey: 'original item', kind: 'command', data, turnId: 'original public turn', observation }]);
  expect(turn).toMatchObject({ state: 'running', observation: 'lost', activity: null, answer: [], live: [{ data, observation }] });
  expect(events).toHaveLength(1);
});
it('restart notice with no recoverable hot still records observation loss, and fresh live state replaces it', () => {
  const noticed: StoredEvent[] = [...events, { seq: 2, sessionId: 's', turnId: 'original public turn', itemKey: 'unobserved', kind: 'notice', data: { text: 'original observation loss', level: 'warning', nativeType: 'runtime-unobserved' }, at: '2026-11-17T00:00:01Z' }];
  expect(reduceTurn(noticed).observation).toBe('lost');
  const fresh = reduceTurn(noticed, [{ itemKey: 'fresh', kind: 'assistant.message', data: { text: 'fresh output' }, turnId: 'original public turn' }]);
  expect(fresh.observation).toBeUndefined(); expect(fresh.activity?.kind).toBe('writing');
});
it('persisted original native completion remains terminal and excludes recovered hot', () => {
  const completed: StoredEvent = { seq: 2, sessionId: 's', turnId: 'original public turn', itemKey: 'end', kind: 'turn.completed', data: { status: 'completed', durationMs: 1000 }, at: '2026-11-17T00:00:01Z' };
  const turn = reduceTurn([...events, completed], [{ itemKey: 'old', kind: 'reasoning', data: { text: 'original' }, observation }]);
  expect(turn).toMatchObject({ state: 'completed', live: [], activity: null }); expect(turn.observation).toBeUndefined();
});
