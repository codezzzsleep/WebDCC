import { describe, expect, it } from 'vitest';
import { TurnTracker } from '../src/turn-tracker.js';

describe('M9 TurnTracker', () => {
  it('does not mark a nonblocking question waiting and keeps session waits scoped without creating a turn', () => {
    const tracker = new TurnTracker(); tracker.start('s', 'public'); tracker.observe('s', { type: 'turn.start', nativeTurnId: 'native' });
    tracker.observe('s', { type: 'item.complete', kind: 'question', itemKey: 'nonblocking', nativeTurnId: 'native', data: { questionId: 'q', prompt: 'p', isBlocking: false } }); expect(tracker.state('public')).toBe('running');
    expect(tracker.observe('s', { type: 'item.complete', kind: 'question', itemKey: 'global', scope: 'session', data: { questionId: 'global', prompt: 'p' } }).turnId).toBeNull(); expect(tracker.state('public')).toBe('waiting');
    tracker.resume('s'); tracker.end('s', 'public', 'completed'); tracker.start('s', 'next'); tracker.observe('s', { type: 'turn.start', nativeTurnId: 'new-native' }); tracker.observe('s', { type: 'item.complete', kind: 'question', itemKey: 'old', nativeTurnId: 'native', data: { questionId: 'old', prompt: 'p' } }); expect(tracker.state('next')).toBe('running');
  });
  it('tracks explicit native session waiting/running while idle cannot invent an ended public turn', () => {
    const tracker = new TurnTracker(); tracker.start('s', 'public'); tracker.observe('s', { type: 'turn.start', nativeTurnId: 'native' });
    expect(tracker.observe('s', { type: 'status', status: 'waiting', source: 'native-thread', scope: 'session' }).turnId).toBeNull(); expect(tracker.state('public')).toBe('waiting');
    tracker.observe('s', { type: 'status', status: 'idle', source: 'native-thread', scope: 'session' }); expect(tracker.activeTurn('s')).toBe('public'); expect(tracker.ended('public')).toBe(false);
    tracker.observe('s', { type: 'status', status: 'running', source: 'native-thread', scope: 'session' }); expect(tracker.state('public')).toBe('running');
  });
  it('NP-04 keeps equal native IDs scoped to their owning session', () => {
    const tracker = new TurnTracker();
    tracker.start('one', 'public-one');
    tracker.start('two', 'public-two');
    tracker.observe('one', { type: 'turn.start', nativeTurnId: 'native' });
    expect(tracker.observe('two', { type: 'turn.start', nativeTurnId: 'native' }).turnId).toBe('public-two');
    expect(tracker.assignment('one', { type: 'turn.end', nativeTurnId: 'native', status: 'completed' }).turnId).toBe('public-one');
  });
  it('binds native ids to the server turn and routes late closing events', () => {
    const tracker = new TurnTracker(10_000);
    tracker.start('s', 'server-turn', 0);
    expect(tracker.observe('s', { type: 'turn.start', nativeTurnId: 'native-turn' }, 1)).toEqual({ turnId: 'server-turn', late: false });
    expect(tracker.observe('s', { type: 'item.start', itemKey: 'cmd', kind: 'command', data: {} }, 2)).toEqual({ turnId: 'server-turn', late: false });
    expect(tracker.end('s', 'server-turn', 'completed', 100)).toEqual(['cmd']);
    expect(tracker.assignment('s', { type: 'item.complete', itemKey: 'cmd', kind: 'command', data: {}, nativeTurnId: 'native-turn' }, 105)).toEqual({ turnId: 'server-turn', late: true });
    expect(tracker.assignment('s', { type: 'item.start', itemKey: 'new', kind: 'command', data: {} }, 105)).toEqual({ turnId: null, late: false });
  });
});
