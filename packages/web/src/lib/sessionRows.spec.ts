import { describe, expect, it } from 'vitest';
import { sessionRows } from './sessionRows.js';
import type { SessionMeta } from './store.js';

function session(id: string, parentId?: string, handoffKind?: SessionMeta['handoffKind']): SessionMeta {
  return { id, workspaceId: 'w', agent: 'codex', status: 'idle', updatedAt: '2026-11-13T00:00:00Z', ...(parentId === undefined ? {} : { parentId }), ...(handoffKind === undefined ? {} : { handoffKind }) };
}

const levels = (list: SessionMeta[]): Record<string, number> => Object.fromEntries(sessionRows(list).map(({ session, depth }) => [session.id, depth]));

describe('手动转交层级和 Watchdog 同级接续', () => {
  it('手动转交和旧的无类型转交均逐层缩进', () => {
    expect(levels([session('root'), session('child', 'root', 'manual'), session('grandchild', 'child')])).toEqual({ root: 0, child: 1, grandchild: 2 });
  });

  it('根会话的自动接续仍为根，之后手动转交产生下一层', () => {
    expect(levels([session('root'), session('recovery', 'root', 'watchdog'), session('manual', 'recovery', 'manual')])).toEqual({ root: 0, recovery: 0, manual: 1 });
  });

  it('子会话的连续自动接续共享其父级，手动后代仍多一层', () => {
    const list = [session('root'), session('child', 'root', 'manual'), session('grandchild', 'child', 'manual'), session('recovery', 'child', 'watchdog'), session('next-recovery', 'recovery', 'watchdog'), session('next-manual', 'next-recovery', 'manual')];
    expect(levels(list)).toEqual({ root: 0, child: 1, grandchild: 2, recovery: 1, 'next-recovery': 1, 'next-manual': 2 });
  });

  it('搜索或归档隐藏父级后，会话仍能作为根展示', () => {
    expect(levels([session('child', 'hidden', 'manual'), session('recovery', 'child', 'watchdog')])).toEqual({ child: 0, recovery: 0 });
  });

  it('保留手动会话树的置顶和近期后代排序', () => {
    const pinned = { ...session('pinned'), pinned: true };
    const parent = { ...session('parent'), updatedAt: '2026-11-12T00:00:00Z' };
    const child = { ...session('child', 'parent', 'manual'), updatedAt: '2026-11-14T00:00:00Z' };
    expect(sessionRows([session('other'), parent, child, pinned]).map(row => row.session.id)).toEqual(['pinned', 'parent', 'child', 'other']);
  });
});
