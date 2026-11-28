import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceDto } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { refreshWorkspaces } from '../lib/appData.js';
import { useModalFocus } from '../lib/modal-focus.js';

export function WorkspaceActions({ workspace, onClose, onArchived }: {
  workspace: WorkspaceDto;
  onClose: () => void;
  onArchived: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const close = (): void => { if (!busy) onClose(); };
  useModalFocus(ref, close, true, () => document.querySelector<HTMLElement>('[data-testid="workspace-archive-toggle"]') ?? document.querySelector<HTMLElement>('[aria-label="添加工作区"]'));
  const apply = async (remove: boolean): Promise<void> => {
    setBusy(true); setError('');
    try {
      if (remove) await api.removeWorkspace(workspace.id);
      else await api.archiveWorkspace(workspace.id, workspace.archived !== true);
      if (!remove && !workspace.archived) onArchived();
      await refreshWorkspaces();
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return createPortal(<div className="modal-backdrop" onClick={close}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="workspace-action-title" className="modal" onClick={event => event.stopPropagation()}>
      <h2 id="workspace-action-title">{removing ? '移除工作区？' : workspace.name}</h2>
      <p className="muted" style={{ overflowWrap: 'anywhere' }}>{workspace.path}</p>
      {error ? <p role="alert">{error}</p> : null}
      {removing ? <>
        <p>仅移除 WebDCC 中的工作区关联，服务器上的目录和文件会保留。</p>
        <div className="modal-actions"><button className="btn" disabled={busy} onClick={() => setRemoving(false)}>取消移除</button><button className="btn danger-text" disabled={busy} onClick={() => void apply(true)}>{busy ? '正在移除…' : '确认移除'}</button></div>
      </> : <>
        <p>{workspace.archived ? '恢复后，工作区及其中的会话会重新显示在侧栏。' : '归档后从日常列表隐藏，保留会话、草稿和服务器文件。正在执行的任务继续运行。'}</p>
        {(workspace.sessionCount ?? 0) > 0 ? <p className="muted">包含 {workspace.sessionCount} 个会话；可归档以保留历史。</p> : null}
        <div className="modal-actions"><button className="btn" disabled={busy} onClick={close}>取消</button>
          <button className="btn primary" disabled={busy} onClick={() => void apply(false)}>{busy ? '正在保存…' : workspace.archived ? '恢复工作区' : '归档工作区'}</button>
          {(workspace.sessionCount ?? 0) === 0 ? <button className="btn danger-text" disabled={busy} onClick={() => setRemoving(true)}>移除工作区</button> : null}
        </div>
      </>}
    </div>
  </div>, document.body);
}
