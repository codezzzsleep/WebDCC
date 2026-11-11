import { useState } from 'react';
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
  const [form, setForm] = useState({ name: '', baseUrl: '', apiKey: '', models: '', protocols: [] as string[], codexCatalogPath: '' });
  const [error, setError] = useState<string | null>(null);
  const [scanInfo, setScanInfo] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [showForm, setShowForm] = useState(false);

  const reload = (): void => {
    void refreshProviders();
    void refreshDsh();
  };

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
            <p className="lead">Provider 从本机已有的配置自动导入：只读，不写回。这里主要看状态，偶尔补一个 Key。</p>
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
                WebDCC 连接你已经在运行的 DSH，和 DSH 原版界面共用同一个进程。首次连接或 DSH 重启后，粘贴 DSH 启动时打印的访问链接。
              </p>
              <div className="row-actions">
                <label className="visually-hidden" htmlFor="dsh-link">
                  DSH 访问链接
                </label>
                <input
                  id="dsh-link"
                  className="text-input"
                  style={{ flex: '1 1 320px', width: 'auto' }}
                  placeholder="http://127.0.0.1:3080/?token=…"
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
                {dsh?.url !== null && dsh?.url !== undefined ? (
                  <a className="btn" href={dsh.url} target="_blank" rel="noreferrer">
                    打开 DSH 原版界面
                  </a>
                ) : null}
              </div>
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
