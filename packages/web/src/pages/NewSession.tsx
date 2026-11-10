import { useEffect, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { MetaResponse, WorkspaceDto } from '@webdcc/protocol';
import { store } from '../lib/store.js';
import { agentInfo } from '../lib/format.js';

interface NewSessionProps {
  workspaces: WorkspaceDto[];
  meta: MetaResponse | null;
}

const AGENTS = ['dsh', 'codex', 'claude-code'] as const;

export function NewSession({ workspaces, meta }: NewSessionProps): React.ReactElement {
  const search = useSearch({ from: '/new' }) as { w?: string; agent?: string };
  const navigate = useNavigate();
  const [workspaceId, setWorkspaceId] = useState(search.w ?? workspaces[0]?.id ?? '');
  useEffect(() => {
    // 工作区是异步加载的，首次渲染时可能还是空
    if (workspaceId === '' && workspaces.length > 0) setWorkspaceId(search.w ?? workspaces[0]?.id ?? '');
  }, [workspaces, search.w, workspaceId]);
  const [agent, setAgent] = useState<string>(search.agent ?? 'dsh');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (workspaceId === '' || text.trim() === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const sessionId = await store.createSession({ workspaceId, agent });
      if (sessionId === '') throw new Error('服务端没有返回会话 id');
      store.sendMessage(sessionId, text);
      await navigate({ to: '/s/$sid', params: { sid: sessionId }, search: {} });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="new-session" data-testid="new-session">
      <h1>新会话</h1>
      <label className="field">
        <span>工作区</span>
        <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} className="text-input">
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name} · {workspace.path}
            </option>
          ))}
        </select>
      </label>

      <div className="agent-cards">
        {AGENTS.map((id) => {
          const info = agentInfo(id);
          const agentMeta = meta?.agents[id];
          const installed = agentMeta?.installed !== false;
          return (
            <button
              key={id}
              type="button"
              className={`agent-card ${agent === id ? 'selected' : ''} ${installed ? '' : 'disabled'}`}
              disabled={!installed}
              onClick={() => setAgent(id)}
              data-testid={`agent-card-${id}`}
            >
              <span className={`agent-mark ${info.className}`}>{info.mark}</span>
              <span className="agent-card-name">{info.name}</span>
              <span className="muted">{installed ? '原装运行，使用你自己的配置' : agentMeta?.notes?.[0] ?? '未安装'}</span>
            </button>
          );
        })}
      </div>

      <div className="new-session-input">
        <textarea
          className="composer-input"
          placeholder="描述你想做的事…"
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
          data-testid="new-session-input"
        />
        <div className="composer-bar">
          <span className="muted">{meta?.agents[agent]?.pinnedVersion ?? ''}</span>
          <button type="button" className="button primary" disabled={busy || text.trim() === ''} onClick={() => void submit()} data-testid="new-session-send">
            发送
          </button>
        </div>
      </div>
      {error !== null ? <div className="error-card">{error}</div> : null}
    </div>
  );
}
