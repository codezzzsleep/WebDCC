import type { SessionMeta } from './store.js';

export interface SessionTreeRow {
  session: SessionMeta;
  depth: number;
}

/** Manual handoffs nest; recovery inherits its source's display parent. */
export function sessionRows(list: SessionMeta[]): SessionTreeRow[] {
  const sessions = new Map(list.map((session) => [session.id, session]));
  const displayParents = new Map<string, string | undefined>();
  const displayParent = (session: SessionMeta): string | undefined => {
    if (displayParents.has(session.id)) return displayParents.get(session.id);
    const source = session.parentId === undefined ? undefined : sessions.get(session.parentId);
    const parentId = source === undefined ? undefined : session.handoffKind === 'watchdog' ? displayParent(source) : source.id;
    displayParents.set(session.id, parentId);
    return parentId;
  };
  const children = new Map<string, SessionMeta[]>();
  const roots: SessionMeta[] = [];
  for (const session of list) {
    const parentId = displayParent(session);
    if (parentId === undefined) roots.push(session);
    else {
      const siblings = children.get(parentId) ?? [];
      siblings.push(session);
      children.set(parentId, siblings);
    }
  }
  const latest = (session: SessionMeta): string => {
    let best = session.updatedAt;
    for (const child of children.get(session.id) ?? []) {
      const value = latest(child);
      if (value > best) best = value;
    }
    return best;
  };
  roots.sort((a, b) => {
    if ((a.pinned === true) !== (b.pinned === true)) return a.pinned === true ? -1 : 1;
    return latest(b).localeCompare(latest(a));
  });
  const rows: SessionTreeRow[] = [];
  const walk = (session: SessionMeta, depth: number): void => {
    rows.push({ session, depth });
    const kids = [...(children.get(session.id) ?? [])].sort((a, b) => (a.createdAt ?? a.updatedAt).localeCompare(b.createdAt ?? b.updatedAt));
    for (const child of kids) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return rows;
}
