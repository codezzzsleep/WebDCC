import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { AGENT_IDS, agentText, isCompatible, sourceLabel } from '../lib/agents.js';
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
  const [dshProviderForm, setDshProviderForm] = useState({ providerKey: '', baseURL: '', model: '', reasoning: 'low', apiKey: '' });
  const [dshProviderError, setDshProviderError] = useState<string | null>(null);
  const [dshProviderSaving, setDshProviderSaving] = useState(false);
  const [form, setForm] = useState({ name: '', baseUrl: '', apiKey: '', models: '', protocols: [] as string[], codexCatalogPath: '' });
  const [error, setError] = useState<string | null>(null);
  const [scanInfo, setScanInfo] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [showForm, setShowForm] = useState(false);

  const reload = (): void => {
    void refreshProviders();
    void refreshDsh();
    if (dsh?.connected === true) {
      void api.dshProvider().then((value) => {
        setDshProvider(value);
        setDshProviderForm((current) => ({
          ...current,
          providerKey: value.providerKey,
          baseURL: typeof value.provider['baseURL'] === 'string' ? String(value.provider['baseURL']) : current.baseURL,
          model: value.defaultModel.model,
          reasoning: value.defaultModel.reasoningEffort ?? (typeof value.provider['reasoning'] === 'string' ? String(value.provider['reasoning']) : current.reasoning),
        }));
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
      setDshProviderForm((current) => ({
        ...current,
        providerKey: value.providerKey,
        baseURL: typeof value.provider['baseURL'] === 'string' ? String(value.provider['baseURL']) : current.baseURL,
        model: value.defaultModel.model,
        reasoning: value.defaultModel.reasoningEffort ?? (typeof value.provider['reasoning'] === 'string' ? String(value.provider['reasoning']) : current.reasoning),
      }));
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

  const usedBy = (providerId: string): string => {
    const provider = providers.find((item) => item.id === providerId);
    if (provider === undefined) return '';
    const names = AGENT_IDS.filter((id) => isCompatible(id, provider)).map((id) => agentText(id).name);
    return names.length === 0 ? '—' : names.join(' · ');
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
            <p className="lead">本机配置会自动导入。Claude/Codex Provider 可在这里维护 Key；DSH Provider 直接写入 DSH 当前配置并立即生效。</p>
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
                  ) : (
                    <div className="kv">
                      <span>原生登录</span>
                      <span>{info?.auth === 'ok' ? '已登录' : info?.auth === 'missing' ? '未登录' : '由本机配置决定'}</span>
                    </div>
                  )}
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
              {dsh?.connected === true && dshProvider !== null ? (
                <div className="dsh-provider-editor" data-testid="dsh-provider-editor" style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                  <div className="panel-head" style={{ padding: 0, border: 0 }}>
                    <h3 style={{ margin: 0 }}>DSH Provider</h3>
                    <span className="badge">{dshProvider.writable ? '可修改' : '只读'}</span>
                  </div>
                  <div className="form-grid" style={{ marginTop: 10 }}>
                    <label className="field">
                      <span>Provider</span>
                      <input className="text-input" value={dshProviderForm.providerKey} onChange={(event) => setDshProviderForm({ ...dshProviderForm, providerKey: event.target.value })} data-testid="dsh-provider-key" />
                    </label>
                    <label className="field">
                      <span>Base URL</span>
                      <input className="text-input" value={dshProviderForm.baseURL} onChange={(event) => setDshProviderForm({ ...dshProviderForm, baseURL: event.target.value })} data-testid="dsh-provider-url" />
                    </label>
                    <label className="field">
                      <span>模型</span>
                      <input className="text-input" value={dshProviderForm.model} onChange={(event) => setDshProviderForm({ ...dshProviderForm, model: event.target.value })} data-testid="dsh-provider-model" />
                    </label>
                    <label className="field">
                      <span>思考强度</span>
                      <select className="text-input" value={dshProviderForm.reasoning} onChange={(event) => setDshProviderForm({ ...dshProviderForm, reasoning: event.target.value })} data-testid="dsh-provider-reasoning">
                        {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => <option key={value} value={value}>{value}</option>)}
                      </select>
                    </label>
                    <label className="field">
                      <span>API Key（留空表示不修改）</span>
                      <input className="text-input" type="password" value={dshProviderForm.apiKey} onChange={(event) => setDshProviderForm({ ...dshProviderForm, apiKey: event.target.value })} data-testid="dsh-provider-api-key" />
                    </label>
                  </div>
                  <div className="row-actions" style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={!dshProvider.writable || dshProviderSaving}
                      data-testid="dsh-provider-save"
                      onClick={() => {
                        setDshProviderSaving(true);
                        setDshProviderError(null);
                        void api.updateDshProvider({ ...dshProviderForm, ...(dshProviderForm.apiKey === '' ? {} : { apiKey: dshProviderForm.apiKey }) })
                          .then(() => {
                            setDshProviderForm((current) => ({ ...current, apiKey: '' }));
                            reload();
                          })
                          .catch((cause: unknown) => setDshProviderError(cause instanceof Error ? cause.message : String(cause)))
                          .finally(() => setDshProviderSaving(false));
                      }}
                    >
                      {dshProviderSaving ? '保存中…' : '保存 DSH Provider'}
                    </button>
                    <span className="muted" style={{ fontSize: 12 }}>优先写入 DSH 原生 settings/credentials API；被 home patch 覆盖时自动更新该 patch。</span>
                  </div>
                  {dshProviderError !== null ? <div className="error-card" role="alert">{dshProviderError}</div> : null}
                </div>
              ) : null}
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

          <section className="panel" aria-label="Provider">
            <div className="panel-head">
              <h2>Provider</h2>
              <div className="row-actions">
                {scanInfo !== null ? (
                  <span className="muted" style={{ fontSize: 12 }} data-testid="scan-info">
                    {scanInfo}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="btn small"
                  data-testid="provider-scan"
                  onClick={() => {
                    void api
                      .providerScan()
                      .then((result) => {
                        setScanInfo(`从本机导入了 ${result.imported} 个 Provider`);
                        reload();
                      })
                      .catch((cause: unknown) => setError(String(cause)));
                  }}
                >
                  <Icon name="refresh" size={14} />
                  重新扫描本机配置
                </button>
                <button
                  type="button"
                  className="btn small ghost"
                  data-testid="provider-restore"
                  onClick={() => {
                    void api
                      .providerRestore()
                      .then((result) => {
                        setScanInfo(`恢复了 ${result.imported} 个 Provider`);
                        reload();
                      })
                      .catch((cause: unknown) => setError(String(cause)));
                  }}
                >
                  恢复已忽略的导入
                </button>
              </div>
            </div>
            <div className="table-scroll">
              <table className="provider-table" data-testid="provider-list">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>来源</th>
                    <th>可用于</th>
                    <th>Key</th>
                    <th>
                      <span className="visually-hidden">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map((provider) => (
                    <tr key={provider.id}>
                      <td>
                        <span className="name">{provider.name}</span>
                        <span className="sub mono">{provider.endpoints?.['openai-responses'] ?? provider.endpoints?.['anthropic-messages'] ?? provider.baseUrl}</span>
                        <span className="sub">{provider.models.join(', ') || '没有模型列表'}</span>
                      </td>
                      <td>{sourceLabel(provider.source)}</td>
                      <td>{usedBy(provider.id)}</td>
                      <td>
                        {editingKey === provider.id ? (
                          <span className="row-actions">
                            <input
                              className="text-input"
                              style={{ width: 170, height: 30 }}
                              type="password"
                              aria-label={`${provider.name} 的新 Key`}
                              value={keyDraft}
                              onChange={(event) => setKeyDraft(event.target.value)}
                              data-testid="provider-key-edit"
                            />
                            <button
                              type="button"
                              className="btn small primary"
                              data-testid="provider-key-save"
                              onClick={() => {
                                void api.updateProvider(provider.id, { apiKey: keyDraft }).then(() => {
                                  setEditingKey(null);
                                  setKeyDraft('');
                                  reload();
                                });
                              }}
                            >
                              保存
                            </button>
                          </span>
                        ) : provider.hasKey ? (
                          <span className="key">…{provider.keyHint ?? ''}</span>
                        ) : (
                          <span style={{ color: 'var(--warning)', fontSize: 12 }}>{provider.note ?? '没有 Key'}</span>
                        )}
                      </td>
                      <td>
                        <span className="actions">
                          <button
                            type="button"
                            className="btn small ghost"
                            data-testid={`provider-key-edit-${provider.name}`}
                            onClick={() => {
                              setEditingKey(provider.id);
                              setKeyDraft('');
                            }}
                          >
                            <Icon name="key" size={14} />
                            Key
                          </button>
                          <button
                            type="button"
                            className="btn small ghost"
                            aria-label={`删除 ${provider.name}`}
                            onClick={() => void api.deleteProvider(provider.id).then(reload)}
                          >
                            删除
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                  {providers.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="muted">
                        本机配置里没有找到 Provider。各 Agent 会使用自己的原生登录。
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
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
