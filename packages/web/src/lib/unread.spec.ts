import { expect, it, vi } from 'vitest';
import type { StoredEvent } from '@webdcc/protocol';
import { AppStore } from './store.js';
const event = (sessionId: string, seq: number): StoredEvent => ({ sessionId, seq, turnId: 't', itemKey: `end-${seq}`, at: new Date().toISOString(), kind: 'turn.completed', data: { status: 'completed', durationMs: 1, answerItemKeys: [] } });
it('title counts ignore history/duplicates and clear both visible sessions', () => {
  const store = new AppStore(); store.setCurrentSession('main', 'dock');
  store.applyEvent(event('main', 1)); store.applyEvent(event('dock', 1)); store.applyEvent(event('other', 1), true);
  expect(store.unreadTotal()).toBe(0);
  store.applyEvent(event('other', 2)); store.applyEvent(event('other', 2)); expect(store.unreadTotal()).toBe(1);
  store.setCurrentSession('other', 'dock'); expect(store.unreadTotal()).toBe(0);
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  store.applyEvent(event('other', 3)); expect(store.unreadTotal()).toBe(1);
  vi.stubGlobal('document', { visibilityState: 'visible' }); store.setCurrentSession('other'); expect(store.unreadTotal()).toBe(0); vi.unstubAllGlobals();
});
