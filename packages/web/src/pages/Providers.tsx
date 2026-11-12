import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { AGENT_IDS, agentText, isCompatible, type AgentKey } from '../lib/agents.js';
import { refreshDsh, refreshProviders, useAppData } from '../lib/appData.js';
import { store } from '../lib/store.js';
import { AgentMark } from '../components/AgentMark.js';
import { Icon } from '../components/Icon.js';

const PROTOCOLS = [
  { id: 'openai-responses', label: 'OpenAI Responses（Codex 用）' },
  { id: 'anthropic-messages', label: 'Anthropic Messages（Claude Code 用）' },
];

/** Agent 与 Provider：大部分内容从本机配置只读导入，这里主要看状态、偶尔补一个 Key */
export function ProvidersPage(): React.ReactElement {
  const { meta, providers, dsh } = useAppData();
  const [dshLink, setDshLink] = useState('');
  const [dshError, setDshError] = useState<string | null>(null);
  const [dshProvider, setDshProvider] = useState<{
    writable: boolean;
    providerKey: string;
    provider: Record<string, unknown>;
    defaultModel: { provider: string; model: string; reasoningEffort?: string };
  } | null>(null);
  const [form, setForm] = useState({ name: '', baseUrl: '', apiKey: '', models: '', protocols: [] as string[], codexCatalogPath: '' });
  const [error, setError] = useState<string | null>(null);
  const [scanInfo, setScanInfo] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const reload = (): void => {
    void refreshProviders();
    void refreshDsh();
    if (dsh?.connected === true) {
      void api.dshProvider().then((value) => {
        setDshProvider(value);
      }).catch(() => setDshProvider(null));
    }
  };

  useEffect(() => {
    if (dsh?.connected !== true) {
      setDshProvider(null);
      return;
    }
    void api.dshProvider().then((value) => {
      setDshProvider(value);
    }).catch(() => setDshProvider(null));
  }, [dsh?.connected]);

  const submit = async (): Promise<void> => {
    setError(null);
    try {
      await api.createProvider({
        name: form.name,
        baseUrl: form.baseUrl,
        protocols: form.protocols,
        models: form.models
          .split(',')
          .map((model) => model.trim())
          .filter(Boolean),
        ...(form.apiKey === '' ? {} : { apiKey: form.apiKey }),
        ...(form.codexCatalogPath === '' ? {} : { codexCatalogPath: form.codexCatalogPath }),
      });
      setForm({ name: '', baseUrl: '', apiKey: '', models: '', protocols: [], codexCatalogPath: '' });
      setShowForm(false);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <main className="main" data-testid="providers-page">
      <div className="mobile-only session-header" style={{ borderBottom: 0 }}>
        <div className="session-header-row">
          <button type="button" className="icon-btn drawer-toggle" aria-label="会话列表" onClick={() => store.setDrawer(true)}>
            <Icon name="menu" size={18} />
          </button>
        </div>
      </div>
      <div className="settings">
        <div className="settings-inner">
          <div>
            <h1>Agent 与 Provider</h1>
            <p className="lead">Provider 是模型的容器：一个 Harness 可以有多个 Provider，一个 Provider 可以有多个模型；新建对话时从对应 Harness 的 Provider 和模型中选择。</p>
            {meta !== null ? <p className="muted" style={{ fontSize: 12 }}>版本 {meta.version} · commit {meta.commit} · 构建于 {meta.builtAt}</p> : null}
          </div>

          <div className="agent-status-grid">
            {AGENT_IDS.map((id) => {
              const info = meta?.agents[id];
              const enabled = info !== undefined && info.installed !== false;
              const dshDown = id === 'dsh' && enabled && dsh !== null && !dsh.connected;
              return (
                <section key={id} className="panel panel-pad" aria-label={agentText(id).name}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <AgentMark agent={id} size="md" />
                    <h2>{agentText(id).name}</h2>
                    <span className={`badge ${!enabled ? 'off' : dshDown ? 'warn' : ''}`} style={{ marginLeft: 'auto' }}>
                      {!enabled ? (info === undefined ? '未启用' : '未安装') : dshDown ? '未连接' : '可用'}
                    </span>
                  </div>
                  <div className="kv">
                    <span>版本</span>
                    <span>{info?.version ?? info?.pinnedVersion ?? '—'}</span>
                  </div>
                  {id === 'dsh' ? (
                    <div className="kv">
                      <span>运行方式</span>
                      <span>{dsh === null ? '—' : dsh.mode === 'attach' ? `连接本机 DSH${dsh.url === null ? '' : ` · ${dsh.url}`}` : 'WebDCC 自己拉起'}</span>
                    </div>
                  ) : <div className="kv"><span>Provider</span><span>由下方 Harness Provider 管理</span></div>}
                  {meta?.runningAsRoot === true && id === 'claude-code' ? (
                    <div className="kv">
                      <span>注意</span>
                      <span>以 root 运行，"跳过权限"模式不可用</span>
                    </div>
                  ) : null}
                  {(info?.notes ?? []).slice(0, 2).map((note) => (
                    <div key={note} className="kv">
                      <span>提示</span>
                      <span>{note}</span>
                    </div>
                  ))}
                </section>
              );
            })}
          </div>

          <section className="panel" data-testid="dsh-section" aria-label="DSH 连接">
            <div className="panel-head">
              <h2>DSH 连接</h2>
              <span className={`badge ${dsh?.connected === true ? '' : 'warn'}`}>
                {dsh?.connected === true ? `已连接${dsh.version === undefined ? '' : ` · ${dsh.version}`}` : '未连接'}
              </span>
            </div>
            <div className="panel-pad">
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                WebDCC 会自动发现本机正在运行的 DSH，和 DSH 原版界面共用同一个进程。WebDCC 重启后会自动恢复连接；自动发现失败时才需要手动恢复。
              </p>
              {dsh?.connected === true ? <div className="kv" style={{ marginTop: 10 }}><span>自动连接</span><span>已连接当前 DSH</span></div> : null}
              <details style={{ marginTop: 12 }}>
                <summary className="link-button">自动发现失败？手动连接</summary>
                <div className="row-actions" style={{ marginTop: 10 }}>
                  <label className="visually-hidden" htmlFor="dsh-link">
                    DSH 访问链接
                  </label>
                  <input
                    id="dsh-link"
                    className="text-input"
                    style={{ flex: '1 1 320px', width: 'auto' }}
                    placeholder="粘贴 DSH 启动时打印的访问链接"
                    value={dshLink}
                    onChange={(event) => setDshLink(event.target.value)}
                    data-testid="dsh-link"
                  />
                  <button
                    type="button"
                    className="btn primary"
                    data-testid="dsh-connect"
                    disabled={dshLink.trim() === ''}
                    onClick={() => {
                      setDshError(null);
                      void api
                        .dshConnect(dshLink.trim())
                        .then(() => {
                          setDshLink('');
                          reload();
                        })
                        .catch((cause: unknown) => setDshError(cause instanceof Error ? cause.message : String(cause)));
                    }}
                  >
                    连接 DSH
                  </button>
                </div>
              </details>
              {dsh?.url !== null && dsh?.url !== undefined ? (
                <a className="btn" href={dsh.url} target="_blank" rel="noreferrer" style={{ marginTop: 10 }}>
                  打开 DSH 原版界面
                </a>
              ) : null}
              {dshError !== null ? (
                <div className="error-card" role="alert">
                  {dshError}
                </div>
              ) : null}
            </div>
          </section>

          <section className="panel" aria-label="Harness Provider">
            <div className="panel-head">
              <h2>Harness Provider</h2>
              <div className="row-actions">
                {scanInfo !== null ? <span className="muted" style={{ fontSize: 12 }}>{scanInfo}</span> : null}
                <button type="button" className="btn small" data-testid="provider-scan" onClick={() => void api.providerScan().then((result) => { setScanInfo(`已扫描本机配置，新增 ${result.imported} 个 Provider`); reload(); }).catch((cause: unknown) => setError(String(cause)))}>
                  <Icon name="refresh" size={14} /> 扫描本机 Provider
                </button>
                <button type="button" className="btn small ghost" data-testid="provider-restore" onClick={() => void api.providerRestore().then((result) => { setScanInfo(`已恢复 ${result.imported} 个 Provider`); reload(); }).catch((cause: unknown) => setError(String(cause)))}>
                  恢复已忽略
                </button>
              </div>
            </div>
            <div className="harness-provider-grid">
              {AGENT_IDS.map((agent) => {
                if (agent === 'dsh') {
                  if (dshProvider === null) return <ProviderEditor key={agent} agent={agent} editable={false} connected={dsh?.connected === true} onSaved={reload} />;
                  return (
                    <ProviderEditor
                      key={agent}
                      agent={agent}
                      editable={dshProvider.writable}
                      connected={dsh?.connected === true}
                      providerKey={dshProvider.providerKey}
                      providerName={String(dshProvider.provider['displayName'] ?? dshProvider.providerKey)}
                      baseUrl={String(dshProvider.provider['baseURL'] ?? '')}
                      models={[dshProvider.defaultModel.model]}
                      reasoning={dshProvider.defaultModel.reasoningEffort ?? String(dshProvider.provider['reasoning'] ?? 'low')}
                      hasKey={typeof dshProvider.provider['apiKeyEnv'] === 'string'}
                      onSaved={reload}
                    />
                  );
                }
                const compatible = providers.filter((item) => isCompatible(agent, item));
                return compatible.length === 0 ? <ProviderEditor key={agent} agent={agent} editable={false} connected={true} onSaved={reload} /> : compatible.map((provider) => (
                  <ProviderEditor key={`${agent}:${provider.id}`} agent={agent} editable providerId={provider.id} connected providerName={provider.name} providerKey={provider.source ?? ''} baseUrl={provider.endpoints?.[agent === 'codex' ? 'openai-responses' : 'anthropic-messages'] ?? provider.baseUrl} models={provider.models} protocols={provider.protocols} hasKey={provider.hasKey} onSaved={reload} />
                ));
              })}
            </div>
          </section>

          <section className="panel" aria-label="手动添加 Provider">
            <div className="panel-head">
              <h2>手动添加</h2>
              <button type="button" className="btn small" onClick={() => setShowForm((value) => !value)} aria-expanded={showForm} data-testid="provider-form-toggle">
                {showForm ? '收起' : '添加 Provider'}
              </button>
            </div>
            {showForm ? (
              <div className="panel-pad">
                <div className="form-grid">
                  <label className="field">
                    <span>名称</span>
                    <input className="text-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} data-testid="provider-name" />
                  </label>
                  <label className="field">
                    <span>Base URL</span>
                    <input className="text-input" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} data-testid="provider-baseurl" />
                  </label>
                  <label className="field">
                    <span>API Key（保存后不再显示）</span>
                    <input className="text-input" type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} data-testid="provider-key" />
                  </label>
                  <label className="field">
                    <span>模型（逗号分隔）</span>
                    <input className="text-input" value={form.models} onChange={(event) => setForm({ ...form, models: event.target.value })} data-testid="provider-models" />
                  </label>
                  <label className="field">
                    <span>Codex 模型目录文件（可选）</span>
                    <input className="text-input" value={form.codexCatalogPath} onChange={(event) => setForm({ ...form, codexCatalogPath: event.target.value })} />
                  </label>
                  <fieldset className="field" style={{ border: 0, margin: 0, padding: 0 }}>
                    <legend style={{ marginBottom: 6 }}>协议</legend>
                    {PROTOCOLS.map((protocol) => (
                      <label key={protocol.id} className="checkbox">
                        <input
                          type="checkbox"
                          checked={form.protocols.includes(protocol.id)}
                          onChange={() =>
                            setForm({
                              ...form,
                              protocols: form.protocols.includes(protocol.id) ? form.protocols.filter((item) => item !== protocol.id) : [...form.protocols, protocol.id],
                            })
                          }
                        />
                        {protocol.label}
                      </label>
                    ))}
                  </fieldset>
                </div>
                <div className="row-actions">
                  <button type="button" className="btn primary" onClick={() => void submit()} data-testid="provider-create">
                    添加
                  </button>
                  <span className="muted" style={{ fontSize: 12 }}>
                    Key 存在服务器本地（0600），永远不会出现在接口响应里。
                  </span>
                </div>
                {error !== null ? (
                  <div className="error-card" role="alert">
                    {error}
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}

interface ProviderEditorProps {
  agent: AgentKey;
  editable: boolean;
  connected: boolean;
  providerId?: string;
  providerKey?: string;
  providerName?: string;
  baseUrl?: string;
  models?: string[];
  reasoning?: string;
  protocols?: string[];
  hasKey?: boolean;
  onSaved: () => void;
}

function ProviderEditor({
  agent,
  editable,
  connected,
  providerId,
  providerKey,
  providerName,
  baseUrl,
  models = [],
  reasoning = 'low',
  protocols = [],
  hasKey = false,
  onSaved,
}: ProviderEditorProps): React.ReactElement {
  const [draft, setDraft] = useState({ providerKey: providerKey ?? '', providerName: providerName ?? '', baseUrl: baseUrl ?? '', models: models.join(', '), reasoning, apiKey: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = agentText(agent).name;
  const isDsh = agent === 'dsh';

  useEffect(() => {
    setDraft({ providerKey: providerKey ?? '', providerName: providerName ?? '', baseUrl: baseUrl ?? '', models: models.join(', '), reasoning, apiKey: '' });
  }, [providerKey, providerName, baseUrl, models, reasoning]);

  const save = (): void => {
    if (!editable || draft.baseUrl.trim() === '' || draft.models.trim() === '') return;
    setSaving(true);
    setError(null);
    const request = isDsh
      ? api.updateDshProvider({ providerKey: draft.providerKey.trim(), baseURL: draft.baseUrl.trim(), model: draft.models.split(',')[0]?.trim() ?? '', reasoning: draft.reasoning, ...(draft.apiKey === '' ? {} : { apiKey: draft.apiKey }) })
      : providerId === undefined
        ? Promise.reject(new Error('Provider 不存在'))
        : api.updateProvider(providerId, {
            ...(draft.providerName.trim() === '' ? {} : { name: draft.providerName.trim() }),
            baseUrl: draft.baseUrl.trim(),
            models: draft.models.split(',').map((item) => item.trim()).filter(Boolean),
            endpoints: protocols.reduce<Record<string, string>>((out, protocol) => { out[protocol] = draft.baseUrl.trim(); return out; }, {}),
            ...(draft.apiKey === '' ? {} : { apiKey: draft.apiKey }),
          });
    void request
      .then(() => { setDraft((current) => ({ ...current, apiKey: '' })); onSaved(); })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSaving(false));
  };

  return (
    <article className="harness-provider-card" data-testid={`harness-provider-${agent}`}>
      <div className="harness-provider-card-head">
        <AgentMark agent={agent} size="md" />
        <div>
          <h3>{name}</h3>
          <span className="muted">{connected ? providerName ?? (isDsh ? 'DSH 未返回 Provider' : '等待 Provider') : '未连接'}</span>
        </div>
        <span className={`badge ${editable ? '' : 'off'}`}>{editable ? '可编辑' : '只读'}</span>
      </div>
      <div className="form-grid">
        <label className="field"><span>Provider</span><input className="text-input" value={draft.providerKey} disabled={!editable || !isDsh} onChange={(event) => setDraft({ ...draft, providerKey: event.target.value })} /></label>
        <label className="field"><span>名称</span><input className="text-input" value={draft.providerName} disabled={!editable || isDsh} onChange={(event) => setDraft({ ...draft, providerName: event.target.value })} /></label>
        <label className="field"><span>Base URL</span><input className="text-input" value={draft.baseUrl} disabled={!editable} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
        <label className="field"><span>模型（多个用逗号分隔）</span><input className="text-input" value={draft.models} disabled={!editable} onChange={(event) => setDraft({ ...draft, models: event.target.value })} /></label>
        <label className="field"><span>思考强度</span>{isDsh ? <select className="text-input" value={draft.reasoning} disabled={!editable} onChange={(event) => setDraft({ ...draft, reasoning: event.target.value })}>{['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => <option key={value} value={value}>{value}</option>)}</select> : <input className="text-input" value="由 Harness 控制" disabled />}</label>
        <label className="field"><span>API Key（留空不修改）</span><input className="text-input" type="password" value={draft.apiKey} disabled={!editable} placeholder={hasKey ? '已配置' : '未配置'} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /></label>
      </div>
      <div className="row-actions">
        <button type="button" className="btn primary" disabled={!editable || saving || draft.baseUrl.trim() === '' || draft.models.trim() === ''} onClick={save}>{saving ? '保存中…' : '保存 Provider'}</button>
        <span className="muted" style={{ fontSize: 12 }}>{isDsh ? '写入 DSH 当前 Provider 配置；模型的思考强度跟随 Provider' : '一个 Provider 可维护多个模型，模型选择在新建对话中完成'}</span>
      </div>
      {error !== null ? <div className="error-card" role="alert">{error}</div> : null}
    </article>
  );
}
