import { useEffect, useMemo, useState } from 'react';
import type { ProviderDto } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { AGENT_IDS, agentText, isCompatible, sourceLabel, type AgentKey } from '../lib/agents.js';
import { refreshDsh, refreshProviders, useAppData } from '../lib/appData.js';
import { store } from '../lib/store.js';
import { AgentMark } from '../components/AgentMark.js';
import { Icon } from '../components/Icon.js';

const PROTOCOLS = [
  { id: 'openai-responses', label: 'OpenAI Responses' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
];

type ModelDetail = { id: string; name: string; reasoningEfforts?: string[] };
type DshProviderView = {
  writable: boolean;
  providerKey: string;
  provider: Record<string, unknown>;
  defaultModel: { provider: string; model: string; reasoningEffort?: string };
};

function modelDetails(provider: ProviderDto): ModelDetail[] {
  return provider.models.map((id) => provider.modelDetails?.find((model) => model.id === id) ?? { id, name: id });
}

function endpoint(provider: ProviderDto, agent: AgentKey): string {
  return provider.endpoints?.[agent === 'codex' ? 'openai-responses' : 'anthropic-messages'] ?? provider.baseUrl;
}

function agentStatus(agent: AgentKey, meta: ReturnType<typeof useAppData>['meta'], dsh: ReturnType<typeof useAppData>['dsh'], providers: ProviderDto[]): { label: string; detail: string; enabled: boolean } {
  const info = meta?.agents[agent];
  const installed = info !== undefined && info.installed !== false;
  if (agent === 'dsh') return { label: installed && dsh?.connected === true ? '已连接' : '未连接', detail: installed && dsh?.connected === true ? 'DSH 原生 Provider' : '连接 DSH 后查看配置', enabled: installed && dsh?.connected === true };
  const count = providers.filter((provider) => isCompatible(agent, provider)).length;
  return { label: installed ? '可用' : '不可用', detail: count + ' 个 Provider', enabled: installed };
}

/** 三层结构：Harness → Provider → Model。 */
export function ProvidersPage(): React.ReactElement {
  const { meta, providers, dsh } = useAppData();
  const [harness, setHarness] = useState<AgentKey>('codex');
  const [dshLink, setDshLink] = useState('');
  const [dshError, setDshError] = useState<string | null>(null);
  const [dshProvider, setDshProvider] = useState<DshProviderView | null>(null);
  const [scanInfo, setScanInfo] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const reload = (): void => {
    void refreshProviders();
    void refreshDsh();
    if (dsh?.connected === true) void api.dshProvider().then(setDshProvider).catch(() => setDshProvider(null));
  };
  useEffect(() => {
    if (dsh?.connected !== true) { setDshProvider(null); return; }
    void api.dshProvider().then(setDshProvider).catch(() => setDshProvider(null));
  }, [dsh?.connected]);

  const compatible = useMemo(() => providers.filter((provider) => isCompatible(harness, provider)), [harness, providers]);
  return (
    <main className="main" data-testid="providers-page">
      <div className="mobile-only session-header" style={{ borderBottom: 0 }}><div className="session-header-row"><button type="button" className="icon-btn drawer-toggle" aria-label="会话列表" onClick={() => store.setDrawer(true)}><Icon name="menu" size={18} /></button></div></div>
      <div className="settings"><div className="settings-inner providers-settings">
        <div><h1>Harness · Provider · Model</h1><p className="lead">先选择 Harness，再管理它的 Provider；同一个 Base URL 可以拥有多个独立模型。</p>{meta !== null ? <p className="muted" style={{ fontSize: 12 }}>版本 {meta.version} · commit {meta.commit} · 构建于 {meta.builtAt}</p> : null}</div>
        <div className="harness-tabs" role="tablist" aria-label="选择 Harness">
          {AGENT_IDS.map((id) => {
            const status = agentStatus(id, meta, dsh, providers);
            return <button key={id} type="button" role="tab" aria-selected={harness === id} className={'harness-tab ' + (harness === id ? 'active' : '')} onClick={() => setHarness(id)}><AgentMark agent={id} size="md" strong={harness === id} /><span className="harness-tab-body"><strong>{agentText(id).name}</strong><small>{status.detail}</small></span><span className={'badge ' + (status.enabled ? '' : 'off')}>{status.label}</span></button>;
          })}
        </div>
        {harness === 'dsh' ? <DshHarness dsh={dsh} dshLink={dshLink} setDshLink={setDshLink} dshError={dshError} setDshError={setDshError} provider={dshProvider} onReload={reload} /> : (
          <section className="panel provider-tree-panel" aria-label={agentText(harness).name + ' Provider'} data-testid={'harness-provider-' + harness}>
            <div className="panel-head"><div><h2>{agentText(harness).name} <span className="muted">/ Provider</span></h2><small className="panel-subtitle">连接信息在 Provider 层，模型信息在 Model 层</small></div><div className="row-actions">{scanInfo !== null ? <span className="muted" style={{ fontSize: 12 }}>{scanInfo}</span> : null}<button type="button" className="btn small ghost" data-testid="provider-scan" onClick={() => void api.providerScan().then((result) => { setScanInfo('扫描完成，新增 ' + result.imported + ' 个 Provider'); reload(); }).catch((cause: unknown) => setScanInfo(String(cause)))}><Icon name="refresh" size={14} /> 扫描</button><button type="button" className="btn small ghost" data-testid="provider-restore" onClick={() => void api.providerRestore().then((result) => { setScanInfo('已恢复 ' + result.imported + ' 个 Provider'); reload(); }).catch((cause: unknown) => setScanInfo(String(cause)))}>恢复已忽略</button><button type="button" className="btn small" onClick={() => setShowCreate((value) => !value)}>{showCreate ? '收起' : '新增 Provider'}</button></div></div>
            {showCreate ? <CreateProviderForm agent={harness} onSaved={() => { setShowCreate(false); reload(); }} /> : null}
            <div className="provider-tree-list">{compatible.length === 0 ? <div className="empty-state provider-empty"><strong>还没有 {agentText(harness).name} Provider</strong><span>点击“新增 Provider”填写连接信息，之后在 Provider 里面添加 Model。</span></div> : null}{compatible.map((provider) => <ProviderTree key={provider.id} provider={provider} agent={harness} onSaved={reload} />)}</div>
          </section>
        )}
      </div></div>
    </main>
  );
}

function CreateProviderForm({ agent, onSaved }: { agent: AgentKey; onSaved: () => void }): React.ReactElement {
  const [form, setForm] = useState({ name: '', baseUrl: '', apiKey: '', protocols: [agent === 'codex' ? 'openai-responses' : 'anthropic-messages'], codexCatalogPath: '', models: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (protocol: string): void => setForm((current) => ({ ...current, protocols: current.protocols.includes(protocol) ? current.protocols.filter((item) => item !== protocol) : [...current.protocols, protocol] }));
  const submit = (): void => {
    if (form.name.trim() === '' || form.baseUrl.trim() === '' || form.protocols.length === 0) return;
    setSaving(true); setError(null);
    const modelIds = form.models.split(',').map((value) => value.trim()).filter(Boolean);
    void api.createProvider({ name: form.name.trim(), baseUrl: form.baseUrl.trim(), protocols: form.protocols, models: modelIds, ...(modelIds.length === 0 ? {} : { modelDetails: modelIds.map((id) => ({ id, name: id })) }), ...(form.apiKey === '' ? {} : { apiKey: form.apiKey }), ...(form.codexCatalogPath === '' ? {} : { codexCatalogPath: form.codexCatalogPath.trim() }) }).then(onSaved).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setSaving(false));
  };
  return <div className="provider-create-form"><div className="form-grid"><label className="field"><span>Provider 名称</span><input className="text-input" data-testid="provider-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：TokenRhythm" /></label><label className="field"><span>Base URL</span><input className="text-input" data-testid="provider-baseurl" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://provider.example/v1" /></label><label className="field"><span>API Key（保存后不再显示）</span><input className="text-input" data-testid="provider-key" type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} /></label>{agent === 'codex' ? <label className="field"><span>Codex 模型目录（可选）</span><input className="text-input" value={form.codexCatalogPath} onChange={(event) => setForm({ ...form, codexCatalogPath: event.target.value })} /></label> : <div />}</div><div className="initial-model-box"><strong>Model（可选）</strong><small>可先填模型 ID，创建后仍可在 Provider 下逐个编辑。</small><input className="text-input" data-testid="provider-models" value={form.models} onChange={(event) => setForm({ ...form, models: event.target.value })} placeholder="多个模型 ID 用逗号分隔" /></div><fieldset className="provider-protocols"><legend>协议</legend>{PROTOCOLS.map((protocol) => <label key={protocol.id} className="checkbox"><input type="checkbox" checked={form.protocols.includes(protocol.id)} onChange={() => toggle(protocol.id)} />{protocol.label}</label>)}</fieldset><div className="row-actions"><button type="button" className="btn primary" data-testid="provider-create" disabled={saving || form.name.trim() === '' || form.baseUrl.trim() === '' || form.protocols.length === 0} onClick={submit}>{saving ? '保存中…' : '创建 Provider'}</button><span className="muted" style={{ fontSize: 12 }}>Provider 建立后，Model 可以单独维护。</span></div>{error !== null ? <div className="error-card" role="alert">{error}</div> : null}</div>;
}

function ProviderTree({ provider, agent, onSaved }: { provider: ProviderDto; agent: AgentKey; onSaved: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [editProvider, setEditProvider] = useState(false);
  const [modelDraft, setModelDraft] = useState<ModelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const models = modelDetails(provider);
  const saveProvider = (patch: { name: string; baseUrl: string; apiKey: string }): void => {
    if (patch.name.trim() === '' || patch.baseUrl.trim() === '') return;
    setSaving(true);
    void api.updateProvider(provider.id, { name: patch.name.trim(), baseUrl: patch.baseUrl.trim(), endpoints: Object.fromEntries(provider.protocols.map((protocol) => [protocol, patch.baseUrl.trim()])), ...(patch.apiKey === '' ? {} : { apiKey: patch.apiKey }) }).then(() => { setEditProvider(false); onSaved(); }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setSaving(false));
  };
  const saveModels = (next: ModelDetail[]): void => {
    setSaving(true); setError(null);
    void api.updateProvider(provider.id, { models: next.map((model) => model.id), modelDetails: next }).then(() => { setModelDraft(null); onSaved(); }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setSaving(false));
  };
  const saveModel = (draft: ModelDetail): void => {
    const id = draft.id.trim(); const name = draft.name.trim() || id;
    if (id === '') return;
    const duplicate = models.some((model) => model.id === id && (modelDraft === null || model.id !== modelDraft.id));
    if (duplicate) { setError('模型 ID 已存在：' + id); return; }
    const next = modelDraft !== null && models.some((model) => model.id === modelDraft.id) ? models.map((model) => model.id === modelDraft.id ? { ...draft, id, name } : model) : [...models, { ...draft, id, name }];
    saveModels(next);
  };
  const removeModel = (id: string): void => saveModels(models.filter((model) => model.id !== id));
  const removeProvider = (): void => { if (window.confirm('删除 Provider“' + provider.name + '”？')) void api.deleteProvider(provider.id).then(onSaved).catch((cause: unknown) => setError(String(cause))); };
  return <article className={'provider-tree ' + (open ? 'open' : '')} data-testid={'provider-' + provider.id}><button type="button" className="provider-tree-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} /><span className="provider-tree-title"><strong>{provider.name}</strong><small>{endpoint(provider, agent)}</small></span><span className="provider-tree-meta"><span className="badge">{models.length} 个 Model</span><span className={'badge ' + (provider.hasKey ? '' : 'warn')}>{provider.hasKey ? 'Key ····' + (provider.keyHint ?? '') : '缺少 Key'}</span></span></button>{open ? <div className="provider-tree-body"><div className="provider-facts"><span>{sourceLabel(provider.source)}</span>{provider.protocols.map((protocol) => <span key={protocol} className="protocol-chip">{protocol}</span>)}{provider.note !== undefined ? <span className="provider-note">{provider.note}</span> : null}<span className="provider-facts-actions"><button type="button" className="btn small ghost" onClick={() => setEditProvider((value) => !value)}>{editProvider ? '收起编辑' : '编辑 Provider'}</button><button type="button" className="btn small ghost danger-text" onClick={removeProvider}>删除</button></span></div>{editProvider ? <ProviderEditForm provider={provider} agent={agent} saving={saving} onSave={saveProvider} /> : null}<div className="model-tree"><div className="model-tree-head"><div><strong>Model</strong><small>模型 ID、显示名称和能力属于这一层</small></div><button type="button" className="btn small" onClick={() => { setError(null); setModelDraft({ id: '', name: '' }); }}>添加 Model</button></div><div className="model-list">{models.length === 0 && modelDraft === null ? <div className="model-empty">这个 Provider 还没有模型。点击“添加 Model”。</div> : null}{models.map((model) => <ModelRow key={model.id} model={model} onEdit={() => { setError(null); setModelDraft(model); }} onDelete={() => removeModel(model.id)} />)}{modelDraft !== null ? <ModelForm draft={modelDraft} saving={saving} onChange={setModelDraft} onCancel={() => setModelDraft(null)} onSave={saveModel} /> : null}</div>{error !== null ? <div className="error-card" role="alert">{error}</div> : null}</div></div> : null}</article>;
}

function ProviderEditForm({ provider, agent, saving, onSave }: { provider: ProviderDto; agent: AgentKey; saving: boolean; onSave: (patch: { name: string; baseUrl: string; apiKey: string }) => void }): React.ReactElement {
  const [draft, setDraft] = useState({ name: provider.name, baseUrl: endpoint(provider, agent), apiKey: '' });
  return <div className="provider-edit-form"><div className="form-grid"><label className="field"><span>Provider 名称</span><input className="text-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label className="field"><span>Base URL</span><input className="text-input" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label><label className="field"><span>替换 API Key（留空不修改）</span><input className="text-input" type="password" value={draft.apiKey} placeholder={provider.hasKey ? '已配置' : '未配置'} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /></label></div><div className="row-actions"><button type="button" className="btn primary" disabled={saving} onClick={() => onSave(draft)}>保存 Provider</button></div></div>;
}

function ModelRow({ model, onEdit, onDelete, readOnly = false }: { model: ModelDetail; onEdit: () => void; onDelete: () => void; readOnly?: boolean }): React.ReactElement {
  return <div className="model-row"><span className="model-mark"><Icon name="sparkle" size={14} /></span><span className="model-row-main"><strong>{model.name}</strong><code>{model.id}</code>{model.reasoningEfforts === undefined || model.reasoningEfforts.length === 0 ? null : <small>思考：{model.reasoningEfforts.join(' · ')}</small>}</span>{readOnly ? <span className="badge off">只读</span> : <span className="model-row-actions"><button type="button" className="btn small ghost" onClick={onEdit}>编辑</button><button type="button" className="btn small ghost danger-text" onClick={onDelete}>删除</button></span>}</div>;
}

function ModelForm({ draft, saving, onChange, onCancel, onSave }: { draft: ModelDetail; saving: boolean; onChange: (draft: ModelDetail) => void; onCancel: () => void; onSave: (draft: ModelDetail) => void }): React.ReactElement {
  const efforts = (draft.reasoningEfforts ?? []).join(', ');
  return <div className="model-form"><div className="form-grid"><label className="field"><span>模型 ID / slug</span><input className="text-input" value={draft.id} onChange={(event) => onChange({ ...draft, id: event.target.value })} placeholder="例如 deepseek-v4.1-flash" /></label><label className="field"><span>显示名称</span><input className="text-input" value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} placeholder="例如 DeepSeek V4.1 Flash" /></label><label className="field"><span>思考强度（可选）</span><input className="text-input" value={efforts} onChange={(event) => onChange({ ...draft, reasoningEfforts: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder="low, medium, high" /></label></div><div className="row-actions"><button type="button" className="btn primary" disabled={saving || draft.id.trim() === ''} onClick={() => onSave(draft)}>保存 Model</button><button type="button" className="btn" onClick={onCancel}>取消</button></div></div>;
}

function ProviderModelRows({ provider }: { provider: DshProviderView }): React.ReactElement {
  const models = Array.isArray(provider.provider['models']) ? (provider.provider['models'] as Record<string, unknown>[]).filter((model) => typeof model['id'] === 'string').map((model) => ({ id: String(model['id']), name: String(model['name'] ?? model['id']) })) : provider.defaultModel.model === '' ? [] : [{ id: provider.defaultModel.model, name: provider.defaultModel.model }];
  return <div className="model-list">{models.length === 0 ? <div className="model-empty">DSH 未返回模型。</div> : models.map((model) => <ModelRow key={model.id} model={model} onEdit={() => undefined} onDelete={() => undefined} readOnly />)}</div>;
}

function DshHarness({ dsh, dshLink, setDshLink, dshError, setDshError, provider, onReload }: { dsh: { connected: boolean; mode: string; url: string | null; version?: string } | null; dshLink: string; setDshLink: (value: string) => void; dshError: string | null; setDshError: (value: string | null) => void; provider: DshProviderView | null; onReload: () => void }): React.ReactElement {
  const [open, setOpen] = useState(true);
  return <div className="dsh-harness-stack" data-testid="harness-provider-dsh"><section className="panel panel-pad"><div className="dsh-connection-head"><div><h2>DeepSeek Harness</h2><p className="muted">DSH 的 Provider 由 DSH 原生设置管理，WebDCC 只显示当前配置。</p></div><span className={'badge ' + (dsh?.connected === true ? '' : 'warn')}>{dsh?.connected === true ? '已连接' : '未连接'}</span></div>{dsh?.connected !== true ? <><details><summary className="link-button">自动发现失败？手动连接</summary><div className="row-actions" style={{ marginTop: 10 }}><input className="text-input" style={{ flex: '1 1 320px', width: 'auto' }} placeholder="粘贴 DSH 启动时打印的访问链接" value={dshLink} onChange={(event) => setDshLink(event.target.value)} /><button type="button" className="btn primary" disabled={dshLink.trim() === ''} onClick={() => { setDshError(null); void api.dshConnect(dshLink.trim()).then(() => { setDshLink(''); onReload(); }).catch((cause: unknown) => setDshError(cause instanceof Error ? cause.message : String(cause))); }}>连接 DSH</button></div></details>{dshError !== null ? <div className="error-card" role="alert">{dshError}</div> : null}</> : null}{dsh?.url !== null && dsh?.url !== undefined ? <a className="btn" href={dsh.url} target="_blank" rel="noreferrer">打开 DSH 原版界面</a> : null}</section>{provider !== null ? <section className={'panel provider-tree ' + (open ? 'open' : '')}><button type="button" className="provider-tree-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} /><span className="provider-tree-title"><strong>{String(provider.provider['displayName'] ?? provider.providerKey)}</strong><small>{String(provider.provider['baseURL'] ?? 'DSH 原生配置')}</small></span><span className="badge off">只读</span></button>{open ? <div className="provider-tree-body"><div className="provider-facts"><span>DSH 当前 Provider · {provider.providerKey}</span><span className="provider-note">模型和思考强度请在 DSH 原版界面修改</span></div><div className="model-tree"><div className="model-tree-head"><div><strong>Model</strong><small>DSH 返回的当前模型目录</small></div></div><ProviderModelRows provider={provider} /></div></div> : null}</section> : null}</div>;
}
