import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import type { WorkspaceDto } from '@webdcc/protocol';
import { useStoreVersion } from '../lib/hooks.js';
import { store, type SessionMeta } from '../lib/store.js';
import { relativeTime } from '../lib/format.js';
import { AGENT_IDS, agentText } from '../lib/agents.js';
import { useAppData } from '../lib/appData.js';
import { AgentMark } from './AgentMark.js';
import { Icon, Spinner } from './Icon.js';

interface SidebarProps {
  currentSessionId: string | null;
  dockSessionId: string | null;
  workspaces: WorkspaceDto[];
  onAddWorkspace: () => void;
  collapsed: boolean;
  onToggle: () => void;
  /** 窄屏抽屉里点了会话之后关掉抽屉（F9） */
  onNavigate?: () => void;
  settingsActive: boolean;
}

interface Row {
  session: SessionMeta;
  depth: number;
}

/** 同一工作区内，按"接力"关系排成树：接续会话缩进在上一棒下面 */
function chainRows(list: SessionMeta[]): Row[] {
  const ids = new Set(list.map((session) => session.id));
  const children = new Map<string, SessionMeta[]>();
  const roots: SessionMeta[] = [];
  for (const session of list) {
    if (session.parentId !== undefined && ids.has(session.parentId)) {
      const siblings = children.get(session.parentId) ?? [];
      siblings.push(session);
      children.set(session.parentId, siblings);
    } else {
      roots.push(session);
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
  const rows: Row[] = [];
  const walk = (session: SessionMeta, depth: number): void => {
    rows.push({ session, depth });
    const kids = [...(children.get(session.id) ?? [])].sort((a, b) => (a.createdAt ?? a.updatedAt).localeCompare(b.createdAt ?? b.updatedAt));
    for (const child of kids) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return rows;
}

export function Sidebar({
  currentSessionId,
  dockSessionId,
  workspaces,
  onAddWorkspace,
  collapsed,
  onToggle,
  onNavigate,
  settingsActive,
}: SidebarProps): React.ReactElement {
  useStoreVersion();
  const { meta, dsh } = useAppData();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const sessions = store.getSessions();

  const grouped = useMemo(() => {
    const map = new Map<string, SessionMeta[]>();
    const needle = query.trim().toLowerCase();
    for (const session of sessions) {
      if (session.archived === true) continue;
      if (needle !== '' && !(session.title ?? '新会话').toLowerCase().includes(needle)) continue;
      const list = map.get(session.workspaceId) ?? [];
      list.push(session);
      map.set(session.workspaceId, list);
    }
    return map;
  }, [sessions, query]);

  const archived = sessions.filter((session) => session.archived === true);

  if (collapsed) {
    return (
      <aside className="sidebar collapsed" data-testid="sidebar" aria-label="会话">
        <button type="button" className="icon-btn" onClick={onToggle} aria-label="展开侧边栏" title="展开侧边栏">
          <Icon name="panelLeft" size={18} />
        </button>
        <Link to="/new" search={{}} className="icon-btn" aria-label="新会话" title="新会话">
          <Icon name="plusCircle" size={18} />
        </Link>
        <Link to="/settings/providers" className="icon-btn" aria-label="Agent 与 Provider" title="Agent 与 Provider">
          <Icon name="sliders" size={18} />
        </Link>
      </aside>
    );
  }

  return (
    <aside className="sidebar" data-testid="sidebar" aria-label="会话">
      <div className="sidebar-top">
        <Link to="/" className="brand" aria-label="WebDCC 首页">
          <span className="brand-word">WebDCC</span>
          <span className="brand-tag">3 HARNESS</span>
        </Link>
        <button type="button" className="icon-btn" onClick={onToggle} aria-label="收起侧边栏" title="收起侧边栏">
          <Icon name="panelLeft" size={18} />
        </button>
      </div>

      <Link to="/new" search={{}} className="new-session-button" onClick={() => onNavigate?.()} data-testid="nav-new">
        <Icon name="plusCircle" />
        新会话
      </Link>

      <nav className="sidebar-nav">
        <Link
          to="/settings/providers"
          className={`nav-item ${settingsActive ? 'active' : ''}`}
          data-testid="nav-providers"
          onClick={() => onNavigate?.()}
        >
          <Icon name="sliders" />
          Agent 与 Provider
        </Link>
      </nav>

      <div className="sidebar-section-title">
        <span>工作区</span>
        <span className="actions">
          <button
            type="button"
            className={`icon-btn ${searching ? 'active' : ''}`}
            onClick={() => {
              setSearching((value) => !value);
              setQuery('');
            }}
            aria-label="搜索会话"
            title="搜索会话"
          >
            <Icon name="search" size={15} />
          </button>
          <button type="button" className="icon-btn" onClick={onAddWorkspace} aria-label="添加工作区" title="添加工作区">
            <Icon name="folderPlus" size={15} />
          </button>
        </span>
      </div>
      {searching ? (
        <div style={{ padding: '0 12px 6px' }}>
          <label className="visually-hidden" htmlFor="session-search">
            搜索会话标题
          </label>
          <input
            id="session-search"
            className="text-input"
            autoFocus
            placeholder="按标题搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            data-testid="session-search"
          />
        </div>
      ) : null}

      <div className="workspace-list">
        {workspaces.map((workspace) => {
          const rows = chainRows(grouped.get(workspace.id) ?? []);
          if (query.trim() !== '' && rows.length === 0) return null;
          return (
            <div key={workspace.id} className="workspace-group">
              <div className="workspace-row" title={workspace.path}>
                <Icon name="folder" className="folder" />
                <span className="name">{workspace.name}</span>
                <Link
                  to="/new"
                  search={{ w: workspace.id }}
                  className="icon-btn"
                  aria-label={`在 ${workspace.name} 新建会话`}
                  title="在此工作区新建会话"
                  onClick={() => onNavigate?.()}
                >
                  <Icon name="plus" size={15} />
                </Link>
              </div>
              {rows.map(({ session, depth }) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  depth={depth}
                  active={session.id === currentSessionId}
                  inDock={session.id === dockSessionId}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          );
        })}
        {workspaces.length === 0 ? (
          <div className="dock-notice">还没有工作区。点上面的文件夹按钮，添加服务器上的一个项目目录。</div>
        ) : null}

        {archived.length > 0 ? (
          <div className="workspace-group" data-testid="archived-section">
            <div className="sidebar-section-title" style={{ paddingLeft: 10 }}>
              <span>已归档</span>
            </div>
            {archived.map((session) => (
              <Link
                key={session.id}
                to="/s/$sid"
                params={{ sid: session.id }}
                search={{}}
                className="session-row archived"
                data-testid="archived-row"
                onClick={() => onNavigate?.()}
              >
                <AgentMark agent={session.agent} />
                <span className="session-title">{session.title ?? '新会话'}</span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      <div className="sidebar-bottom">
        {AGENT_IDS.map((id) => {
          const info = meta?.agents[id];
          const enabled = info !== undefined && info.installed !== false;
          let detail = enabled ? (info?.version ?? '') : info === undefined ? '未启用' : '未安装';
          let on = enabled;
          if (id === 'dsh' && enabled && dsh !== null) {
            on = dsh.connected;
            detail = dsh.connected ? (dsh.mode === 'attach' ? '已连接本机 DSH' : '已启动') : dsh.mode === 'attach' ? '未连接' : '未运行';
          }
          return (
            <div key={id} className="health-row">
              <span className={`dot ${on ? '' : 'off'}`} aria-hidden="true" />
              <span className="name">{agentText(id).name}</span>
              <span className="detail">{detail}</span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function SessionRow({
  session,
  depth,
  active,
  inDock,
  onNavigate,
}: {
  session: SessionMeta;
  depth: number;
  active: boolean;
  inDock: boolean;
  onNavigate: (() => void) | undefined;
}): React.ReactElement {
  const info = agentText(session.agent);
  return (
    <Link
      to="/s/$sid"
      params={{ sid: session.id }}
      search={{}}
      className={`session-row ${active ? 'active' : ''} ${inDock ? 'in-dock' : ''}`}
      style={{ paddingLeft: 10 + Math.min(depth, 3) * 14 }}
      data-testid="session-row"
      data-agent={session.agent}
      title={`${info.name} · ${session.title ?? '新会话'}`}
      onClick={() => onNavigate?.()}
    >
      {depth > 0 ? <Icon name="cornerDownRight" size={13} strokeWidth={2} className="chain" label="接续会话" /> : null}
      <AgentMark agent={session.agent} />
      <span className="session-title">{session.title ?? '新会话'}</span>
      {session.pinned === true ? <Icon name="pin" size={13} strokeWidth={2} className="pinned" label="置顶" /> : null}
      <span className={`session-status status-${session.status}`}>
        {session.status === 'running' ? (
          <Spinner size={13} label="运行中" />
        ) : session.status === 'waiting' ? (
          '待批准'
        ) : session.status === 'error' ? (
          '出错'
        ) : inDock ? (
          '右栏'
        ) : (
          relativeTime(session.updatedAt)
        )}
      </span>
    </Link>
  );
}
