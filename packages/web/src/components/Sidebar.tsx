import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { WorkspaceDto } from '@webdcc/protocol';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';
import { agentInfo, relativeTime } from '../lib/format.js';

interface SidebarProps {
  currentSessionId: string | null;
  dockSessionId: string | null;
  workspaces: WorkspaceDto[];
  onAddWorkspace: () => void;
  onSearch: () => void;
  collapsed: boolean;
  onToggle: () => void;
  /** 窄屏抽屉里点了会话之后关掉抽屉（F9） */
  onNavigate?: () => void;
}

export function Sidebar({ currentSessionId, dockSessionId, workspaces, onAddWorkspace, onSearch, collapsed, onToggle, onNavigate }: SidebarProps): React.ReactElement {
  useStoreVersion();
  const sessions = store.getSessions();
  const grouped = useMemo(() => {
    const map = new Map<string, typeof sessions>();
    for (const session of sessions) {
      if (session.archived === true) continue;
      const list = map.get(session.workspaceId) ?? [];
      list.push(session);
      map.set(session.workspaceId, list);
    }
    return map;
  }, [sessions]);

  if (collapsed) {
    return (
      <aside className="sidebar collapsed" data-testid="sidebar">
        <button type="button" className="icon-button" onClick={onToggle} title="展开侧边栏">
          ☰
        </button>
        <Link to="/new" search={{}} className="icon-button" title="新会话">
          ＋
        </Link>
      </aside>
    );
  }

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sidebar-top">
        <Link to="/" className="brand">
          Web<span>DCC</span>
        </Link>
        <button type="button" className="icon-button" onClick={onToggle} title="收起侧边栏">
          ⇤
        </button>
      </div>
      <Link to="/new" search={{}} className="new-session-button" onClick={() => onNavigate?.()}>
        ＋ 新会话
      </Link>

      <Link to="/settings/providers" className="session-row" data-testid="nav-providers">
        <span className="agent-mark">⚙</span>
        <span className="session-title">Provider 与模型</span>
      </Link>

      <div className="sidebar-section-title">
        <span>工作区</span>
        <span className="sidebar-actions">
          <button type="button" className="icon-button" onClick={onSearch} title="搜索会话">
            ⌕
          </button>
          <button type="button" className="icon-button" onClick={onAddWorkspace} title="添加工作区">
            ＋
          </button>
        </span>
      </div>

      <div className="workspace-list">
        {workspaces.map((workspace) => {
          const list = grouped.get(workspace.id) ?? [];
          return (
            <div key={workspace.id} className="workspace-group">
              <div className="workspace-row">
                <span className="folder">▸</span>
                <span className="workspace-name" title={workspace.path}>
                  {workspace.name}
                </span>
                <Link
                  to="/new"
                  search={{ w: workspace.id, agent: undefined }}
                  className="icon-button tiny"
                  title="在此工作区新建会话"
                >
                  ＋
                </Link>
              </div>
              {list.map((session) => {
                const info = agentInfo(session.agent);
                const active = session.id === currentSessionId;
                return (
                  <Link
                    key={session.id}
                    to="/s/$sid"
                    params={{ sid: session.id }}
                    search={{}}
                    className={`session-row ${active ? 'active' : ''}`}
                    data-testid="session-row"
                  >
                    <span className={`agent-mark ${info.className}`}>{info.mark}</span>
                    <span className="session-title">
                      {session.pinned === true ? '置顶 · ' : ''}
                      {session.title ?? '新会话'}
                    </span>
                    <span className={`session-status status-${session.status}`}>
                      {session.status === 'running'
                        ? '运行中'
                        : session.status === 'waiting'
                          ? '待批准'
                          : session.id === dockSessionId
                            ? '右栏'
                            : relativeTime(session.updatedAt)}
                    </span>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>

      {store.getSessions().some((session) => session.archived === true) ? (
        <div className="archived-section" data-testid="archived-section">
          <div className="sidebar-section-title">已归档</div>
          {store
            .getSessions()
            .filter((session) => session.archived === true)
            .map((session) => (
              <Link
                key={session.id}
                to="/s/$sid"
                params={{ sid: session.id }}
                search={{}}
                className="session-row archived"
                data-testid="archived-row"
              >
                <span className="agent-mark muted">{agentInfo(session.agent).mark}</span>
                <span className="session-title">{session.title ?? '新会话'}</span>
              </Link>
            ))}
        </div>
      ) : null}

      <div className="sidebar-bottom">
        <span className="muted">WebDCC · 三个原装 Agent</span>
      </div>
    </aside>
  );
}
