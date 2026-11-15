import { validateDshResult } from './contracts.js';
export interface DshWorkspaceRow {
  workspaceId: string; path: string; title: string; sessionIds: string[]; createdAt: string; updatedAt: string;
}
export interface DshWorkspaceSnapshot { items: DshWorkspaceRow[]; archivedSessionIds: string[]; pinnedSessionIds: string[] }
/** Host-global state belongs to its connection generation. Empty replacement
 * baselines erase old rows, pins and archives; late increments cannot create
 * a state before the new generation's authoritative baseline. */
export class DshWorkspaceBridge {
  snapshot: DshWorkspaceSnapshot | null = null;
  invalidate(): void { this.snapshot = null; }
  accept(value: unknown): void {
    validateDshResult('workspace/follow', value);
    const frame = value as { type: string; value?: DshWorkspaceSnapshot; workspace?: DshWorkspaceRow; workspaceId?: string; workspaceIds?: string[]; archivedSessionIds?: string[]; pinnedSessionIds?: string[] };
    if (frame.type === 'baseline' || frame.type === 'replace') {
      this.snapshot = structuredClone(frame.value!); return;
    }
    if (this.snapshot === null) throw new Error('Workspace increment arrived before its Host baseline');
    const current = this.snapshot;
    switch (frame.type) {
      case 'upsert': {
        const row = frame.workspace!;
        const index = current.items.findIndex(item => item.workspaceId === row.workspaceId);
        if (index === -1) current.items.push(structuredClone(row)); else current.items[index] = structuredClone(row);
        return;
      }
      case 'remove': current.items = current.items.filter(item => item.workspaceId !== frame.workspaceId); return;
      case 'order': {
        const rows = new Map(current.items.map(row => [row.workspaceId, row]));
        current.items = [...frame.workspaceIds!.flatMap(id => rows.get(id) === undefined ? [] : [rows.get(id)!]), ...current.items.filter(row => !frame.workspaceIds!.includes(row.workspaceId))];
        return;
      }
      case 'archived': current.archivedSessionIds = [...frame.archivedSessionIds!]; return;
      case 'pinned': current.pinnedSessionIds = [...frame.pinnedSessionIds!]; return;
    }
  }
  organization(nativeId: string): unknown {
    if (this.snapshot === null) return null;
    return structuredClone({ workspace: this.snapshot.items.find(row => row.sessionIds.includes(nativeId)), archived: this.snapshot.archivedSessionIds.includes(nativeId), pinned: this.snapshot.pinnedSessionIds.includes(nativeId) });
  }
}
