import { useMemo, useState } from 'react';
import { AGENT_IDS, agentAvailable, agentText } from '../lib/agents.js';
import { useAppData } from '../lib/appData.js';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';
import { AgentMark } from './AgentMark.js';
import { Icon } from './Icon.js';

interface HandoffDialogProps {
  text: string;
  fromSessionId: string;
  workspaceId: string;
  onClose: () => void;
  /** 放进已有会话 */
  onHanded: (targetSessionId: string, title: string) => void;
  /** 在另一个 Agent 中继续：新建接续会话 */
  onContinueIn: (agent: string, text: string) => void;
}

/** "带到…"：把回答原文放进别的会话的输入框，绝不自动发送（SPEC 9.10） */
export function HandoffDialog({ text, fromSessionId, workspaceId, onClose, onHanded, onContinueIn }: HandoffDialogProps): React.ReactElement {
  useStoreVersion();
  const { meta } = useAppData();
  const [busy, setBusy] = useState(false);
  const from = store.getSession(fromSessionId);
  const targets = useMemo(
    () =>
      store
        .getSessions()
        .filter((session) => session.workspaceId === workspaceId && session.id !== fromSessionId && session.archived !== true)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 12),
    [workspaceId, fromSessionId, store.getVersion()],
  );

  const handoffTo = async (sessionId: string, title: string): Promise<void> => {
    setBusy(true);
    try {
      store.appendDraft(sessionId, text);
      await store.flushDraft(sessionId);
      onHanded(sessionId, title);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="handoff-dialog">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="handoff-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="handoff-title">带到…</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          回答原文会放进目标会话的输入框，你可以先改再发。WebDCC 不会替你发送任何东西。
        </p>
        <div className="menu" style={{ position: 'static', boxShadow: 'none', maxWidth: 'none', width: '100%' }}>
          <div className="menu-group-title">在另一个 Agent 中继续（新建接续会话）</div>
          {AGENT_IDS.filter((id) => id !== from?.agent).map((id) => (
            <button
              key={id}
              type="button"
              className="menu-item"
              disabled={busy || !agentAvailable(id, meta)}
              onClick={() => onContinueIn(id, text)}
            >
              <AgentMark agent={id} size="md" />
              <span className="menu-item-body">
                在 {agentText(id).name} 中继续…
                <span className="menu-item-sub">{agentText(id).strength}</span>
              </span>
            </button>
          ))}
          <div className="menu-sep" />
          <div className="menu-group-title">放进已有会话</div>
          {targets.length === 0 ? <div className="menu-note">这个工作区还没有其他会话</div> : null}
          {targets.map((session) => (
            <button
              key={session.id}
              type="button"
              className="menu-item"
              disabled={busy}
              onClick={() => void handoffTo(session.id, session.title ?? '新会话')}
            >
              <AgentMark agent={session.agent} />
              <span className="menu-item-body">{session.title ?? '新会话'}</span>
              <span className="menu-item-sub">{agentText(session.agent).name}</span>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            <Icon name="x" size={14} />
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
