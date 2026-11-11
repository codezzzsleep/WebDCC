import { useEffect, useRef, useState } from 'react';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';
import { agentText } from '../lib/agents.js';
import { useAppData } from '../lib/appData.js';
import { AgentMark } from './AgentMark.js';
import { Icon } from './Icon.js';

interface SessionHeaderProps {
  sessionId: string;
  tab: 'chat' | 'trajectory';
  onTab: (tab: 'chat' | 'trajectory') => void;
  dockSessionId: string | null;
  onOpenDockSession: (sessionId: string) => void;
  onOpenFiles: () => void;
}

export function SessionHeader({ sessionId, tab, onTab, dockSessionId, onOpenDockSession, onOpenFiles }: SessionHeaderProps): React.ReactElement {
  useStoreVersion();
  const { providers } = useAppData();
  const session = store.getSession(sessionId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<'more' | 'dock' | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const agent = session?.agent ?? 'dsh';
  const provider = providers.find((item) => item.id === session?.providerId);
  const modelText = [provider?.name, session?.model].filter((part) => part !== undefined && part !== '').join(' · ');

  useEffect(() => {
    if (menu === null) return;
    const onDown = (event: MouseEvent): void => {
      if (actionsRef.current !== null && !actionsRef.current.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  const siblings = store
    .getSessions()
    .filter((item) => item.workspaceId === session?.workspaceId && item.id !== sessionId && item.archived !== true);
  const relation = (id: string, parentId: string | undefined): string => {
    if (id === session?.parentId) return '上一棒';
    if (parentId === sessionId) return '下一棒';
    return '';
  };
  siblings.sort((a, b) => {
    const ra = relation(a.id, a.parentId) === '' ? 1 : 0;
    const rb = relation(b.id, b.parentId) === '' ? 1 : 0;
    return ra - rb || b.updatedAt.localeCompare(a.updatedAt);
  });

  return (
    <header className="session-header" data-testid="session-header">
      <div className="session-header-row">
        <button type="button" className="icon-btn drawer-toggle" data-testid="drawer-toggle" aria-label="会话列表" onClick={() => store.setDrawer(true)}>
          <Icon name="menu" size={18} />
        </button>
        {renaming ? (
          <form
            style={{ flex: '1 1 auto', maxWidth: 420 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim() !== '') store.rename(sessionId, draft.trim());
              setRenaming(false);
            }}
          >
            <label className="visually-hidden" htmlFor="rename-input">
              会话标题
            </label>
            <input id="rename-input" autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => setRenaming(false)} className="text-input" />
          </form>
        ) : (
          <button
            type="button"
            className="session-title-button"
            data-testid="session-title"
            onClick={() => {
              setDraft(session?.title ?? '');
              setRenaming(true);
            }}
            title="点击改名"
          >
            {session?.title ?? '新会话'}
          </button>
        )}
        <span className="harness-chip" title={`${agentText(agent).name}${modelText === '' ? '' : ` · ${modelText}`}`} data-testid="harness-chip">
          <AgentMark agent={agent} />
          <span className="agent-name">{agentText(agent).name}</span>
          {modelText === '' ? null : <span className="chip-model">· {modelText}</span>}
        </span>
        <span className="spacer" />
        <div className="header-actions" ref={actionsRef}>
          <span className="menu-anchor">
            <button
              type="button"
              className={`btn ghost ${dockSessionId !== null ? 'active' : ''}`}
              aria-haspopup="menu"
              aria-expanded={menu === 'dock'}
              onClick={() => setMenu(menu === 'dock' ? null : 'dock')}
              title="在右侧并排打开另一个会话"
              data-testid="dock-toggle"
            >
              <Icon name="columns" />
              <span className="label">并排</span>
            </button>
            {menu === 'dock' ? (
              <div className="menu down right" role="menu" style={{ width: 320 }}>
                <div className="menu-group-title">在右侧并排打开（同一工作区）</div>
                {siblings.length === 0 ? <div className="menu-note">同一工作区还没有其他会话</div> : null}
                {siblings.slice(0, 12).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      setMenu(null);
                      onOpenDockSession(item.id);
                    }}
                  >
                    <AgentMark agent={item.agent} />
                    <span className="menu-item-body">
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title ?? '新会话'}</span>
                    </span>
                    <span className="menu-item-sub">{relation(item.id, item.parentId) || agentText(item.agent).name}</span>
                  </button>
                ))}
                <div className="menu-sep" />
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    setMenu(null);
                    onOpenFiles();
                  }}
                >
                  <Icon name="folder" />
                  工作区文件
                </button>
              </div>
            ) : null}
          </span>
          <span className="menu-anchor">
            <button type="button" className="icon-btn" aria-label="更多" data-testid="session-more" aria-haspopup="menu" aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? null : 'more')}>
              <Icon name="more" size={18} />
            </button>
            {menu === 'more' ? (
              <div className="menu down right" role="menu" style={{ width: 200 }}>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    setDraft(session?.title ?? '');
                    setRenaming(true);
                    setMenu(null);
                  }}
                >
                  <Icon name="edit" />
                  重命名
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    store.setPinned(sessionId, !(session?.pinned ?? false));
                    setMenu(null);
                  }}
                >
                  <Icon name="pin" />
                  {session?.pinned === true ? '取消置顶' : '置顶'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    store.archive(sessionId, !(session?.archived ?? false));
                    setMenu(null);
                  }}
                >
                  <Icon name="archive" />
                  {session?.archived === true ? '取消归档' : '归档'}
                </button>
                <a role="menuitem" className="menu-item" href={`/api/sessions/${sessionId}/export`} download onClick={() => setMenu(null)}>
                  <Icon name="fileText" />
                  导出
                </a>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    void navigator.clipboard?.writeText(window.location.href);
                    setMenu(null);
                  }}
                >
                  <Icon name="link" />
                  复制链接
                </button>
              </div>
            ) : null}
          </span>
        </div>
      </div>
      <nav className="tabs" aria-label="视图">
        <button type="button" className={tab === 'chat' ? 'tab active' : 'tab'} onClick={() => onTab('chat')} data-testid="tab-chat" aria-current={tab === 'chat'}>
          对话
        </button>
        <button
          type="button"
          className={tab === 'trajectory' ? 'tab active' : 'tab'}
          onClick={() => onTab('trajectory')}
          data-testid="tab-trajectory"
          aria-current={tab === 'trajectory'}
        >
          轨迹
        </button>
      </nav>
    </header>
  );
}

/** 接续会话顶部的"接续自…" */
export function RelayBar({ sessionId, onOpen, onCompare }: { sessionId: string; onOpen: (id: string) => void; onCompare: (id: string) => void }): React.ReactElement | null {
  useStoreVersion();
  const session = store.getSession(sessionId);
  const parentId = session?.parentId;
  useEffect(() => {
    if (parentId !== undefined && store.getSession(parentId) === undefined) void store.ensureSession(parentId);
  }, [parentId]);
  if (parentId === undefined) return null;
  const parent = store.getSession(parentId);
  return (
    <div className="relay-bar" data-testid="relay-bar">
      <Icon name="cornerDownRight" size={14} strokeWidth={2} />
      <span style={{ flex: '0 0 auto' }}>接续自</span>
      <button type="button" className="link" onClick={() => onOpen(parentId)}>
        {parent?.title ?? '上一个会话'}
      </button>
      {parent === undefined ? null : <span style={{ flex: '0 0 auto' }}>· {agentText(parent.agent).name}</span>}
      <button type="button" className="compare" onClick={() => onCompare(parentId)}>
        在右侧对照
      </button>
    </div>
  );
}
