import { useEffect, useRef, useState } from 'react';
import type { DshProviderCreate, DshProviderUpdate, DshSettingsPreview, DshSettingsView } from '@webdcc/protocol';
import { api } from '../lib/api.js';

export function DshProviderCredentials({ view, onReload }: { view: DshSettingsView; onReload: () => void }): React.ReactElement {
  const storedRef = typeof view.provider['apiKeyEnv'] === 'string' ? view.provider['apiKeyEnv'] : '';
  const [ref, setRef] = useState(storedRef), [key, setKey] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [binding, setBinding] = useState<{ input: DshProviderUpdate; preview: DshSettingsPreview } | null>(null);
  const [confirmKey, setConfirmKey] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setStatus('');
    try { await action(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const previewRef = () => {
    const first = (view.provider['models'] as { id: string }[] | undefined)?.[0]?.id ?? '';
    const input: DshProviderUpdate = { targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: view.providerKey, model: first, apiKeyEnv: ref };
    void run(async () => { const preview = await api.previewDshProvider(input); if (mounted.current) setBinding({ input, preview }); });
  };
  const saveKey = () => void run(async () => {
    await api.updateDshCredential({ targetId: view.target.id, expectedRevision: view.providerRevision, providerKey: view.providerKey, apiKeyEnv: storedRef, apiKey: key });
    if (mounted.current) { setKey(''); setConfirmKey(false); setStatus(`DSH 已确认密钥保存到 ${storedRef}`); }
  });
  return <section className="panel panel-pad" data-testid="dsh-credentials">
    <h3>API 密钥</h3><p className="muted">密钥保存在当前 DSH Host；页面只显示凭据引用。更换引用后，再设置它的密钥。</p>
    <label className="field"><span>凭据引用 apiKeyEnv</span><input className="text-input" value={ref} disabled={busy} onChange={event => { setRef(event.target.value); setBinding(null); }} placeholder="MY_PROVIDER_API_KEY" /></label>
    <button type="button" className="btn" disabled={busy || ref === storedRef || ref === ''} onClick={previewRef}>查看引用变更</button>
    {binding === null ? null : <div data-testid="dsh-reference-preview"><p>目标 Host：{binding.preview.target.url}</p><p>Provider：{view.providerKey}</p><p>引用：{storedRef || '未指定'} → {ref}</p>
      <button type="button" className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.updateDshProvider(binding.input); if (mounted.current) onReload(); })}>确认引用变更</button>
      <button type="button" className="btn" disabled={busy} onClick={() => { setBinding(null); setRef(storedRef); }}>取消引用变更</button></div>}
    <label className="field"><span>新的 API 密钥</span><input className="text-input" type="password" autoComplete="new-password" value={key} disabled={busy || storedRef === '' || ref !== storedRef} onChange={event => { setKey(event.target.value); setConfirmKey(false); }} /></label>
    <button type="button" className="btn" disabled={busy || key === '' || ref !== storedRef} onClick={() => setConfirmKey(true)}>检查密钥保存目标</button>
    {confirmKey ? <div data-testid="dsh-key-preview"><p>将密钥保存到 {view.target.url} 的 {view.providerKey} · {storedRef}。</p>
      <button type="button" className="btn primary" disabled={busy} onClick={saveKey}>确认保存密钥</button>
      <button type="button" className="btn" disabled={busy} onClick={() => { setKey(''); setConfirmKey(false); }}>取消密钥保存</button></div> : null}
    {status === '' ? null : <p role="status">{status}</p>}{error === '' ? null : <div role="alert" className="error-card">{error}</div>}
  </section>;
}

export function DshCreateProvider({ view, onSaved }: { view: DshSettingsView; onSaved: (providerKey: string) => void }): React.ReactElement {
  const [draft, setDraft] = useState({ providerKey: '', model: '', baseURL: '', apiKeyEnv: '', api: 'openai-completions' as DshProviderCreate['api'] });
  const [preview, setPreview] = useState<{ input: DshProviderCreate; view: DshSettingsPreview } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const change = (field: keyof typeof draft, value: string) => { setDraft({ ...draft, [field]: value }); setPreview(null); };
  const check = () => {
    const input: DshProviderCreate = { ...draft, targetId: view.target.id, expectedRevision: view.providerRevision };
    setBusy(true); setError('');
    void api.previewCreateDshProvider(input).then(result => setPreview({ input, view: result })).catch(cause => setError(String(cause))).finally(() => setBusy(false));
  };
  const create = () => {
    if (preview === null) return;
    setBusy(true); setError('');
    void api.createDshProvider(preview.input).then(result => onSaved(result.providerKey)).catch(cause => setError(String(cause))).finally(() => setBusy(false));
  };
  return <details className="panel panel-pad" data-testid="dsh-create-provider"><summary>新增 DSH Provider</summary>
    <p>先创建 Provider 和独立凭据引用，再为该引用设置 API 密钥。</p>
    <div className="form-grid">{(['providerKey', 'baseURL', 'model', 'apiKeyEnv'] as const).map(field => <label className="field" key={field}><span>{{ providerKey: 'Provider ID', baseURL: 'Base URL', model: '初始模型 ID', apiKeyEnv: '独立凭据引用' }[field]}</span><input className="text-input" value={draft[field]} disabled={busy} onChange={event => change(field, event.target.value)} /></label>)}
      <label className="field"><span>接口类型</span><select value={draft.api} disabled={busy} onChange={event => change('api', event.target.value)}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label></div>
    <button type="button" className="btn" disabled={busy || Object.values(draft).some(value => value === '')} onClick={check}>查看新增配置</button>
    {preview === null ? null : <div><p>目标 Host：{preview.view.target.url}</p><pre>{JSON.stringify(preview.view.changes, null, 2)}</pre><button type="button" className="btn primary" disabled={busy} onClick={create}>确认创建 Provider</button><button type="button" className="btn" disabled={busy} onClick={() => setPreview(null)}>取消创建</button></div>}
    {error === '' ? null : <div className="error-card" role="alert">{error}</div>}
  </details>;
}
