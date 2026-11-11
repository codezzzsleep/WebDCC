import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { MetaResponse, ProviderDto, WorkspaceDto } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { agentInfo } from '../lib/format.js';

interface NewSessionProps {
  workspaces: WorkspaceDto[];
  meta: MetaResponse | null;
  /** 由路由层传入（这里的组件也会被 "/" 复用，不能直接用 useSearch） */
  initial?: { w?: string; agent?: string };
}

const AGENTS = ['dsh', 'codex', 'claude-code'] as const;

export function NewSession({ workspaces, meta, initial }: NewSessionProps): React.ReactElement {
  const search = initial ?? {};
  const navigate = useNavigate();
  const [workspaceId, setWorkspaceId] = useState(search.w ?? workspaces[0]?.id ?? '');
  useEffect(() => {
    // 工作区是异步加载的，首次渲染时可能还是空
    if (workspaceId === '' && workspaces.length > 0) setWorkspaceId(search.w ?? workspaces[0]?.id ?? '');
  }, [workspaces, search.w, workspaceId]);
  const [agent, setAgent] = useState<string>(search.agent ?? 'dsh');
  const [text, setText] = useState('');
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [providerId, setProviderId] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.providers().then(setProviders).catch(() => setProviders([]));
  }, []);

  const compatible = providers.filter((provider) =>
    agent === 'codex' ? provider.protocols.includes('openai-responses') : agent === 'claude-code' ? provider.protocols.includes('anthropic-messages') : false,
  );
  const selectedProvider = compatible.find((provider) => provider.id === providerId);

  const submit = async (): Promise<void> => {
    if (workspaceId === '' || text.trim() === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const sessionId = await store.createSession({
        workspaceId,
        agent,
        ...(providerId === '' ? { providerId: null } : { providerId }),
        ...(model === '' ? {} : { model }),
      });
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
          // 没有 probe 结果 = 该 adapter 未启用（例如 DSH 被 WDCC_ENABLE_DSH=0 关掉）
          const installed = agentMeta !== undefined && agentMeta.installed !== false;
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
              <span className="muted">{installed ? '原装运行，使用你自己的配置' : (agentMeta?.notes?.[0] ?? '该 Agent 未启用或未安装')}</span>
            </button>
          );
        })}
      </div>

      <div className="provider-row">
        <label className="field">
          <span>Provider</span>
          <select
            className="text-input"
            value={providerId}
            onChange={(event) => {
              setProviderId(event.target.value);
              setModel('');
            }}
            data-testid="provider-select"
          >
            <option value="">原生登录 / 原生配置</option>
            {compatible.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
            {providers.filter((provider) => !compatible.includes(provider)).map((provider) => (
              <option key={provider.id} value={provider.id} disabled>
                {provider.name}（与 {agent} 协议不兼容）
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>模型</span>
          <select className="text-input" value={model} onChange={(event) => setModel(event.target.value)} data-testid="model-select" disabled={selectedProvider === undefined}>
            {(selectedProvider?.models ?? []).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
            {selectedProvider === undefined ? <option value="">（先选 Provider）</option> : null}
          </select>
        </label>
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
