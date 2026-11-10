import { useMemo, useState } from 'react';
import { agentInfo } from '../lib/format.js';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';

interface HandoffDialogProps {
  text: string;
  fromSessionId: string;
  workspaceId: string;
  onClose: () => void;
  onHanded: (targetSessionId: string, title: string) => void;
}

/** "带到…"：把回复原文或文件路径放进目标会话的输入框，绝不自动发送（SPEC 9.10） */
export function HandoffDialog({ text, fromSessionId, workspaceId, onClose, onHanded }: HandoffDialogProps): React.ReactElement {
  useStoreVersion();
  const [busy, setBusy] = useState(false);
  const targets = useMemo(
    () => store.getSessions().filter((session) => session.workspaceId === workspaceId && session.id !== fromSessionId),
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

  const handoffToNew = async (agent: 'dsh' | 'codex' | 'claude-code'): Promise<void> => {
    setBusy(true);
    try {
      const sessionId = await store.createSession({ workspaceId, agent });
      store.appendDraft(sessionId, text);
      await store.flushDraft(sessionId);
      onHanded(sessionId, '新会话');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="handoff-dialog">
      <div className="modal handoff" onClick={(event) => event.stopPropagation()}>
        <h2>带到…</h2>
        <p className="muted">内容会原样追加到目标会话的输入框，不会自动发送。</p>
        <div className="handoff-group">
          <div className="mention-title">同一工作区的会话</div>
          {targets.length === 0 ? <div className="muted">这个工作区还没有其他会话</div> : null}
          {targets.map((session) => (
            <button
              key={session.id}
              type="button"
              className="handoff-item"
              disabled={busy}
              onClick={() => void handoffTo(session.id, session.title ?? '新会话')}
            >
              <span className={`agent-mark ${agentInfo(session.agent).className}`}>{agentInfo(session.agent).mark}</span>
              {session.title ?? '新会话'}
            </button>
          ))}
        </div>
        <div className="handoff-group">
          <div className="mention-title">新建会话</div>
          {(['dsh', 'codex', 'claude-code'] as const).map((agent) => (
            <button key={agent} type="button" className="handoff-item" disabled={busy} onClick={() => void handoffToNew(agent)}>
              <span className={`agent-mark ${agentInfo(agent).className}`}>{agentInfo(agent).mark}</span>
              新建 {agentInfo(agent).name} 会话
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
