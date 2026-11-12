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
const REASONING_OPTIONS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type DshProviderView = {
  writable: boolean;
  providerKey: string;
  provider: Record<string, unknown>;
  defaultModel: { provider: string; model: string; reasoningEffort?: string };
  official: boolean;
  reasoningEfforts: string[];
  defaultReasoning?: string;
  contextWindow?: number;
  maxTokens?: number;
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

function ModelRow({ model, onEdit, onDelete, readOnly = false }: { model: ModelDetail; onEdit: () => void; onDelete?: () => void; readOnly?: boolean }): React.ReactElement {
  return <div className="model-row"><span className="model-mark"><Icon name="sparkle" size={14} /></span><span className="model-row-main"><strong>{model.name}</strong><code>{model.id}</code>{model.reasoningEfforts === undefined || model.reasoningEfforts.length === 0 ? null : <small>思考：{model.reasoningEfforts.join(' · ')}</small>}</span>{readOnly ? <span className="badge off">只读</span> : <span className="model-row-actions"><button type="button" className="btn small ghost" onClick={onEdit}>编辑</button>{onDelete === undefined ? null : <button type="button" className="btn small ghost danger-text" onClick={onDelete}>删除</button>}</span>}</div>;
}

function ModelForm({ draft, saving, onChange, onCancel, onSave }: { draft: ModelDetail; saving: boolean; onChange: (draft: ModelDetail) => void; onCancel: () => void; onSave: (draft: ModelDetail) => void }): React.ReactElement {
  return <div className="model-form"><div className="form-grid"><label className="field"><span>模型 ID / slug</span><input className="text-input" value={draft.id} onChange={(event) => onChange({ ...draft, id: event.target.value })} placeholder="例如 deepseek-v4.1-flash" /></label><label className="field"><span>显示名称</span><input className="text-input" value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} placeholder="例如 DeepSeek V4.1 Flash" /></label></div><ReasoningEffortPicker values={draft.reasoningEfforts ?? []} onChange={(reasoningEfforts) => onChange({ ...draft, reasoningEfforts })} /><div className="row-actions"><button type="button" className="btn primary" disabled={saving || draft.id.trim() === ''} onClick={() => onSave(draft)}>保存 Model</button><button type="button" className="btn" onClick={onCancel}>取消</button></div></div>;
}

function ReasoningEffortPicker({ values, onChange }: { values: string[]; onChange: (values: string[]) => void }): React.ReactElement {
  const custom = values.filter((value) => !(REASONING_OPTIONS as readonly string[]).includes(value));
  const toggle = (value: string): void => onChange(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  return <fieldset className="reasoning-picker"><legend>思考强度（可选，可多选）</legend><div className="reasoning-options">{REASONING_OPTIONS.map((value) => <label key={value} className="checkbox"><input type="checkbox" checked={values.includes(value)} onChange={() => toggle(value)} />{value}</label>)}</div><label className="field"><span>自定义等级（逗号分隔）</span><input className="text-input" value={custom.join(', ')} onChange={(event) => { const next = event.target.value.split(',').map((item) => item.trim()).filter(Boolean); onChange([...values.filter((item) => (REASONING_OPTIONS as readonly string[]).includes(item)), ...next]); }} placeholder="例如 reasoning-v2" /></label></fieldset>;
}

type DshModelDetail = ModelDetail & { contextWindow?: number; maxTokens?: number };

function ProviderModelRows({ provider, editable, onEdit }: { provider: DshProviderView; editable: boolean; onEdit: (model: DshModelDetail) => void }): React.ReactElement {
  const models = Array.isArray(provider.provider['models'])
    ? (provider.provider['models'] as Record<string, unknown>[]).filter((model) => typeof model['id'] === 'string').map((model) => ({
      id: String(model['id']),
      name: String(model['name'] ?? model['id']),
      reasoningEfforts: model['reasoningEfforts'] !== null && typeof model['reasoningEfforts'] === 'object' ? Object.keys(model['reasoningEfforts'] as Record<string, unknown>) : undefined,
      ...(Number.isSafeInteger(model['contextWindow']) && Number(model['contextWindow']) > 0 ? { contextWindow: Number(model['contextWindow']) } : {}),
      ...(Number.isSafeInteger(model['maxTokens']) && Number(model['maxTokens']) > 0 ? { maxTokens: Number(model['maxTokens']) } : {}),
    }))
    : provider.defaultModel.model === '' ? [] : [{ id: provider.defaultModel.model, name: provider.defaultModel.model }];
  return <div className="model-list">{models.length === 0 ? <div className="model-empty">DSH 未返回模型。</div> : models.map((model) => <ModelRow key={model.id} model={model} onEdit={() => onEdit(model)} readOnly={!editable} />)}</div>;
}

function formatCapacity(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 10 ? millions.toFixed(0) : millions.toFixed(2).replace(/\.00$/, '')}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function DshHarness({ dsh, dshLink, setDshLink, dshError, setDshError, provider, onReload }: { dsh: { connected: boolean; mode: string; url: string | null; version?: string } | null; dshLink: string; setDshLink: (value: string) => void; dshError: string | null; setDshError: (value: string | null) => void; provider: DshProviderView | null; onReload: () => void }): React.ReactElement {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ model: '', reasoning: '', efforts: '', contextWindow: '', maxTokens: '' });
  useEffect(() => {
    if (provider === null) return;
    setDraft({
      model: provider.defaultModel.model,
      reasoning: provider.defaultModel.reasoningEffort ?? provider.defaultReasoning ?? '',
      efforts: provider.reasoningEfforts.join(', '),
      contextWindow: provider.contextWindow === undefined ? '' : String(provider.contextWindow),
      maxTokens: provider.maxTokens === undefined ? '' : String(provider.maxTokens),
    });
  }, [provider]);
  const save = (): void => {
    if (provider === null || draft.model.trim() === '') return;
    setSaving(true); setError(null);
    const efforts = draft.efforts.split(',').map((value) => value.trim()).filter(Boolean);
    void api.updateDshProvider({
      providerKey: provider.providerKey,
      baseURL: String(provider.provider['baseURL'] ?? ''),
      model: draft.model.trim(),
      ...(draft.reasoning === '' ? {} : { reasoning: draft.reasoning }),
      reasoningEfforts: efforts,
      ...(draft.contextWindow === '' ? {} : { contextWindow: Number(draft.contextWindow) }),
      ...(draft.maxTokens === '' ? {} : { maxTokens: Number(draft.maxTokens) }),
    }).then(() => { setEditing(false); onReload(); }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setSaving(false));
  };
  const editModel = (model: DshModelDetail): void => {
    if (provider === null) return;
    setDraft({
      model: model.id,
      reasoning: provider.defaultModel.model === model.id ? provider.defaultModel.reasoningEffort ?? provider.defaultReasoning ?? '' : provider.defaultReasoning ?? '',
      efforts: model.reasoningEfforts?.join(', ') ?? provider.reasoningEfforts.join(', '),
      contextWindow: model.contextWindow === undefined ? (provider.contextWindow === undefined ? '' : String(provider.contextWindow)) : String(model.contextWindow),
      maxTokens: model.maxTokens === undefined ? (provider.maxTokens === undefined ? '' : String(provider.maxTokens)) : String(model.maxTokens),
    });
    setEditing(true);
  };
  const editable = provider !== null && !provider.official && provider.writable;
  return <div className="dsh-harness-stack" data-testid="harness-provider-dsh">
    <section className="panel panel-pad">
      <div className="dsh-connection-head"><div><h2>DeepSeek Harness</h2><p className="muted">官方 Provider 使用 Harness 原生能力；第三方 Provider 使用自己的模型声明。</p></div><span className={'badge ' + (dsh?.connected === true ? '' : 'warn')}>{dsh?.connected === true ? '已连接' : '未连接'}</span></div>
      {dsh?.connected !== true ? <><details><summary className="link-button">自动发现失败？手动连接</summary><div className="row-actions" style={{ marginTop: 10 }}><input className="text-input" style={{ flex: '1 1 320px', width: 'auto' }} placeholder="粘贴 DSH 启动时打印的访问链接" value={dshLink} onChange={(event) => setDshLink(event.target.value)} /><button type="button" className="btn primary" disabled={dshLink.trim() === ''} onClick={() => { setDshError(null); void api.dshConnect(dshLink.trim()).then(() => { setDshLink(''); onReload(); }).catch((cause: unknown) => setDshError(cause instanceof Error ? cause.message : String(cause))); }}>连接 DSH</button></div></details>{dshError !== null ? <div className="error-card" role="alert">{dshError}</div> : null}</> : null}
      {dsh?.url !== null && dsh?.url !== undefined ? <a className="btn" href={dsh.url} target="_blank" rel="noreferrer">打开 DSH 原版界面</a> : null}
    </section>
    {provider !== null ? <section className={'panel provider-tree ' + (open ? 'open' : '')}>
      <button type="button" className="provider-tree-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} /><span className="provider-tree-title"><strong>{String(provider.provider['displayName'] ?? provider.providerKey)}</strong><small>{String(provider.provider['baseURL'] ?? 'DSH 原生配置')}</small></span><span className={'badge ' + (provider.official ? '' : 'warn')}>{provider.official ? '官方 Provider' : '第三方 Provider'}</span></button>
      {open ? <div className="provider-tree-body"><div className="provider-facts"><span>DSH 当前 Provider · {provider.providerKey}</span><span className="provider-note">{provider.official ? '思考等级、上下文和输出上限来自 DeepSeek 官方适配器' : '思考等级、上下文和输出上限来自此 Provider 的模型声明'}</span>{editable ? <button type="button" className="btn small ghost" onClick={() => setEditing((value) => !value)}>{editing ? '收起编辑' : '调整第三方能力'}</button> : null}</div>
        <div className="model-tree"><div className="model-tree-head"><div><strong>Model</strong><small>当前模型能力</small></div><span className="badge off">{provider.defaultModel.model || '未选择模型'}</span></div><ProviderModelRows provider={provider} editable={editable} onEdit={editModel} /></div>
        <div className="dsh-capabilities"><div><b>思考等级</b><span>{provider.reasoningEfforts.length === 0 ? '未声明' : provider.reasoningEfforts.join(' · ')}</span></div><div><b>上下文</b><span>{provider.contextWindow === undefined ? '未声明' : formatCapacity(provider.contextWindow)}</span></div><div><b>输出上限</b><span>{provider.maxTokens === undefined ? '未声明' : formatCapacity(provider.maxTokens)}</span></div></div>
        {editing && !provider.official ? <div className="dsh-capability-editor"><div className="form-grid"><label className="field"><span>模型 ID</span><input className="text-input" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label><label className="field"><span>默认思考等级</span><input className="text-input" value={draft.reasoning} onChange={(event) => setDraft({ ...draft, reasoning: event.target.value })} placeholder="留空表示不指定" /></label><label className="field"><span>上下文长度</span><input className="text-input" inputMode="numeric" value={draft.contextWindow} onChange={(event) => setDraft({ ...draft, contextWindow: event.target.value })} placeholder="1000000" /></label><label className="field"><span>输出上限</span><input className="text-input" inputMode="numeric" value={draft.maxTokens} onChange={(event) => setDraft({ ...draft, maxTokens: event.target.value })} placeholder="128000" /></label></div><ReasoningEffortPicker values={draft.efforts.split(',').map((item) => item.trim()).filter(Boolean)} onChange={(values) => setDraft({ ...draft, efforts: values.join(', ') })} /><div className="row-actions"><button type="button" className="btn primary" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存第三方能力'}</button></div>{error !== null ? <div className="error-card" role="alert">{error}</div> : null}</div> : null}
      </div> : null}
    </section> : null}
  </div>;
}
