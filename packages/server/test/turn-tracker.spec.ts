import { describe, expect, it } from 'vitest';
import { TurnTracker } from '../src/turn-tracker.js';

describe('M9 TurnTracker', () => {
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
