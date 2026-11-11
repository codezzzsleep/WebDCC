import { useEffect, useState } from 'react';
import type { ProviderDto } from '@webdcc/protocol';
import { api } from '../lib/api.js';

const PROTOCOLS = [
  { id: 'openai-responses', label: 'OpenAI Responses（Codex 用）' },
  { id: 'anthropic-messages', label: 'Anthropic Messages（Claude Code 用）' },
];

function sourceLabel(source: string | undefined): string {
  switch (source) {
    case 'codex-config':
      return 'Codex 配置';
    case 'claude-settings':
      return 'Claude 设置';
    case 'dsh':
      return 'DSH';
    case 'paste':
      return '粘贴导入';
    default:
      return '手动';
  }
}

export function ProvidersPage(): React.ReactElement {
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [dsh, setDsh] = useState<{ mode: string; url: string | null; connected: boolean; version?: string } | null>(null);
  const [dshLink, setDshLink] = useState('');
  const [dshError, setDshError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', baseUrl: '', apiKey: '', models: '', protocols: [] as string[], codexCatalogPath: '' });
  const [error, setError] = useState<string | null>(null);
  const [scanInfo, setScanInfo] = useState<string | null>(null);

  const reload = (): void => {
    void api.providers().then(setProviders).catch((cause: unknown) => setError(String(cause)));
    void api.dshStatus().then(setDsh).catch(() => undefined);
  };
  useEffect(reload, []);

  const submit = async (): Promise<void> => {
    setError(null);
    try {
      await api.createProvider({
        name: form.name,
        baseUrl: form.baseUrl,
        protocols: form.protocols,
        models: form.models.split(',').map((model) => model.trim()).filter(Boolean),
        ...(form.apiKey === '' ? {} : { apiKey: form.apiKey }),
        ...(form.codexCatalogPath === '' ? {} : { codexCatalogPath: form.codexCatalogPath }),
      });
      setForm({ name: '', baseUrl: '', apiKey: '', models: '', protocols: [], codexCatalogPath: '' });
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="page" data-testid="providers-page">
      <h1>Provider 与模型</h1>
      {scanInfo !== null ? <p className="muted" data-testid="scan-info">{scanInfo}</p> : null}
      <div className="provider-actions">
        <button
          type="button"
          className="button"
          data-testid="provider-scan"
          onClick={() => {
            void api.providerScan().then((result) => {
              setScanInfo(`从本机导入了 ${result.imported} 个 Provider`);
              reload();
            }).catch((cause: unknown) => setError(String(cause)));
          }}
        >
          重新扫描本机配置
        </button>
        <button
          type="button"
          className="button ghost"
          data-testid="provider-restore"
          onClick={() => {
            void api.providerRestore().then((result) => {
              setScanInfo(`恢复了 ${result.imported} 个 Provider`);
              reload();
            }).catch((cause: unknown) => setError(String(cause)));
          }}
        >
          恢复已忽略的导入
        </button>
      </div>

      <section className="dsh-section" data-testid="dsh-section">
        <h2>DSH 连接</h2>
        <p className="muted">
          模式：{dsh?.mode ?? 'spawn'}；状态：
          {dsh?.connected === true ? `已连接${dsh.version === undefined ? '' : ` · ${dsh.version}`}` : '未连接'}
          {dsh?.url === null || dsh?.url === undefined ? '' : ` · ${dsh.url}`}
        </p>
        <div className="provider-row">
          <input
            className="text-input"
            placeholder="粘贴 DSH 的访问链接（http://127.0.0.1:3080/?token=…）"
            value={dshLink}
            onChange={(event) => setDshLink(event.target.value)}
            data-testid="dsh-link"
          />
          <button
            type="button"
            className="button primary"
            data-testid="dsh-connect"
            onClick={() => {
              setDshError(null);
              void api
                .dshConnect(dshLink)
                .then(() => reload())
                .catch((cause: unknown) => setDshError(String(cause)));
            }}
          >
            连接 DSH
          </button>
        </div>
        {dshError !== null ? <div className="error-card">{dshError}</div> : null}
        {dsh?.url !== null && dsh?.url !== undefined ? (
          <a className="link-button" href={dsh.url} target="_blank" rel="noreferrer">
            打开 DSH 原版界面
          </a>
        ) : null}
      </section>
      <p className="muted">Provider 只保存名称、端点、协议与模型列表；Key 存在服务器本地（0600），永远不会出现在接口响应里。</p>

      <table className="provider-table" data-testid="provider-list">
        <thead>
          <tr>
            <th>名称</th>
            <th>来源</th>
            <th>端点</th>
            <th>协议</th>
            <th>模型</th>
            <th>Key</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => (
            <tr key={provider.id}>
              <td>{provider.name}</td>
              <td>{sourceLabel(provider.source)}</td>
              <td className="mono">{provider.endpoints?.['openai-responses'] ?? provider.endpoints?.['anthropic-messages'] ?? provider.baseUrl}</td>
              <td>{provider.protocols.join(', ')}</td>
              <td>{provider.models.join(', ') || '—'}</td>
              <td>{provider.hasKey ? `…${provider.keyHint ?? ''}` : (provider.note ?? '无')}</td>
              <td>
                <button type="button" className="link-button" onClick={() => void api.deleteProvider(provider.id).then(reload)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
          {providers.length === 0 ? (
            <tr>
              <td colSpan={7} className="muted">
                还没有 Provider
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h2>新增 Provider</h2>
      <div className="provider-form">
        <label className="field">
          <span>名称</span>
          <input className="text-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} data-testid="provider-name" />
        </label>
        <label className="field">
          <span>Base URL</span>
          <input className="text-input" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} data-testid="provider-baseurl" />
        </label>
        <label className="field">
          <span>API Key（保存后不再回显）</span>
          <input className="text-input" type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} data-testid="provider-key" />
        </label>
        <label className="field">
          <span>模型（逗号分隔）</span>
          <input className="text-input" value={form.models} onChange={(event) => setForm({ ...form, models: event.target.value })} data-testid="provider-models" />
        </label>
        <label className="field">
          <span>Codex 模型元数据路径（可选）</span>
          <input className="text-input" value={form.codexCatalogPath} onChange={(event) => setForm({ ...form, codexCatalogPath: event.target.value })} />
        </label>
        <div className="field">
          <span>协议</span>
          {PROTOCOLS.map((protocol) => (
            <label key={protocol.id} className="checkbox">
              <input
                type="checkbox"
                checked={form.protocols.includes(protocol.id)}
                onChange={() =>
                  setForm({
                    ...form,
                    protocols: form.protocols.includes(protocol.id)
                      ? form.protocols.filter((item) => item !== protocol.id)
                      : [...form.protocols, protocol.id],
                  })
                }
              />
              {protocol.label}
            </label>
          ))}
        </div>
        <button type="button" className="button primary" onClick={() => void submit()} data-testid="provider-create">
          新增
        </button>
        {error !== null ? <div className="error-card">{error}</div> : null}
      </div>
    </div>
  );
}
