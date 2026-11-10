import { useState } from 'react';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';
import { agentInfo } from '../lib/format.js';

interface SessionHeaderProps {
  sessionId: string;
  tab: 'chat' | 'trajectory';
  onTab: (tab: 'chat' | 'trajectory') => void;
  dockOpen: boolean;
  onToggleDock: () => void;
}

export function SessionHeader({ sessionId, tab, onTab, dockOpen, onToggleDock }: SessionHeaderProps): React.ReactElement {
  useStoreVersion();
  const session = store.getSession(sessionId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const info = agentInfo(session?.agent ?? 'dsh');

  return (
    <header className="session-header" data-testid="session-header">
      <div className="session-header-row">
        {renaming ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim() !== '') store.rename(sessionId, draft.trim());
              setRenaming(false);
            }}
          >
            <input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => setRenaming(false)} className="text-input" />
          </form>
        ) : (
          <button
            type="button"
            className="session-title-button"
            onClick={() => {
              setDraft(session?.title ?? '');
              setRenaming(true);
            }}
            title="点击改名"
          >
            {session?.title ?? '新会话'}
          </button>
        )}
        <span className={`agent-mark ${info.className}`}>{info.mark}</span>
        <span className="agent-name">{info.name}</span>
        <span className="spacer" />
        <div className="menu-anchor">
          <button type="button" className="icon-button" onClick={() => setMenuOpen((value) => !value)} title="更多">
            ···
          </button>
          {menuOpen ? (
            <div className="menu" onMouseLeave={() => setMenuOpen(false)}>
              <button type="button" onClick={() => { setDraft(session?.title ?? ''); setRenaming(true); setMenuOpen(false); }}>
                重命名
              </button>
              <button type="button" onClick={() => { store.archive(sessionId, !(session?.archived ?? false)); setMenuOpen(false); }}>
                {session?.archived === true ? '取消归档' : '归档'}
              </button>
              <a href={`/api/sessions/${sessionId}/export`} download>
                导出
              </a>
              <button type="button" onClick={() => { void navigator.clipboard.writeText(window.location.href); setMenuOpen(false); }}>
                复制链接
              </button>
            </div>
          ) : null}
        </div>
        <button type="button" className={`icon-button ${dockOpen ? 'active' : ''}`} onClick={onToggleDock} title="停靠区">
          ▥
        </button>
      </div>
      <nav className="tabs">
        <button type="button" className={tab === 'chat' ? 'tab active' : 'tab'} onClick={() => onTab('chat')} data-testid="tab-chat">
          对话
        </button>
        <button type="button" className={tab === 'trajectory' ? 'tab active' : 'tab'} onClick={() => onTab('trajectory')} data-testid="tab-trajectory">
          轨迹
        </button>
      </nav>
    </header>
  );
}
