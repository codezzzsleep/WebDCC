import { expect, it } from 'vitest';
import { DshWorkspaceBridge } from '../src/workspaces.js';
const row = { workspaceId: 'workspace', title: 'title', path: '/native/workspace', sessionIds: ['native'], createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z' };
it('Host-global workspace replacements clear old pins/archives and increments require a baseline', () => {
  const bridge = new DshWorkspaceBridge();
  expect(() => bridge.accept({ type: 'pinned', pinnedSessionIds: ['native'] })).toThrow('baseline');
  bridge.accept({ type: 'baseline', value: { items: [row], pinnedSessionIds: ['native'], archivedSessionIds: ['native'] } });
  expect(bridge.organization('native')).toMatchObject({ workspace: row, pinned: true, archived: true });
  bridge.accept({ type: 'pinned', pinnedSessionIds: [] });
  expect(bridge.organization('native')).toMatchObject({ pinned: false });
  bridge.invalidate();
  expect(bridge.organization('native')).toBeNull();
  bridge.accept({ type: 'replace', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } });
  expect(bridge.snapshot?.items).toEqual([]);
  expect(bridge.organization('native')).toEqual({ workspace: undefined, archived: false, pinned: false });
});
