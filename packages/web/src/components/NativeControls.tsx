import { useEffect, useRef, useState } from 'react';
import type { NativeActionReceipt, NativeActionResponse, NativeControlSnapshot } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { ElicitationForm } from './ElicitationForm.js';
import { NativeSurface, NativeProcessSurface } from './NativeSurface.js';
import { NativeDshSurface } from './NativeDshSurface.js';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
interface Action { type: string; label: string; supported: boolean; requiresIdle?: boolean; schema: Record<string, unknown> }
const labels: Record<NativeActionReceipt['state'], string> = { dispatching: '正在执行，等待原生结果', submitted: '已提交，原生终态尚未确认', completed: '原生调用已返回，请核对操作结果', failed: '执行前已拒绝，请核对后重试', uncertain: '结果未确认，请查询原生状态，勿重复执行' };

/** Reads never activate a writer; each action has an explicit submit button. */
export function NativeControls({ sessionId }: { sessionId: string }): React.ReactElement {
  const generation = useRef({ sessionId, value: 0 });
  if (generation.current.sessionId !== sessionId) generation.current = { sessionId, value: generation.current.value + 1 };
  const [snapshot, setSnapshot] = useState<NativeControlSnapshot>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [receipt, setReceipt] = useState<NativeActionReceipt>();
  const [result, setResult] = useState<unknown>();
  const [history, setHistory] = useState<unknown>();
  const refresh = async (): Promise<void> => {
    const current = generation.current;
    const value = await api.nativeControls(sessionId, true);
    if (generation.current !== current || current.sessionId !== sessionId) return;
    setSnapshot(value);
    let commandId: string | null = null;
    try { commandId = sessionStorage.getItem(`native-action:${sessionId}`); } catch { /* optional read recovery */ }
    if (commandId) await api.nativeActionReceipt(sessionId, commandId).then(value => { if (generation.current === current) setReceipt(value); }).catch(() => undefined);
  };
  useEffect(() => {
    let live = true;
    setSnapshot(undefined); setError(''); setReceipt(undefined); setResult(undefined); setHistory(undefined);
    setSelected(''); setValues({}); setBusy(false);
    void api.nativeControls(sessionId, true).then(value => { if (live) setSnapshot(value); }).catch(failure => { if (live) setError(failure instanceof Error ? failure.message : '原生读取失败'); });
    let commandId: string | null = null;
    try { commandId = sessionStorage.getItem(`native-action:${sessionId}`); } catch { /* Storage is optional for read-only UI. */ }
    if (commandId) void api.nativeActionReceipt(sessionId, commandId).then(value => { if (live) setReceipt(value); }).catch(() => undefined);
    return () => { live = false; };
  }, [sessionId]);
  const submit = async (action: { type: string; [key: string]: unknown }, connect = false): Promise<void> => {
    if (busy) return;
    const current = generation.current;
    const active = (): boolean => generation.current === current && current.sessionId === sessionId;
    setBusy(true); setError(''); setResult(undefined);
    const commandId = crypto.randomUUID();
    // Recovery keeps only the operation identity, never its form content.
    try {
      sessionStorage.setItem(`native-action:${sessionId}`, commandId);
      for (const [name, schema] of Object.entries(object(selectedAction?.schema['properties']))) {
        if (object(schema)['generated'] === 'commandId' && action[name] === undefined) action[name] = commandId;
      }
      const response: NativeActionResponse = connect ? await api.connectNativeControls(sessionId, commandId)
        : await api.nativeAction(sessionId, { commandId, revision: snapshot?.revision, action });
      if (!active()) return;
      setReceipt(response.receipt); setResult(response.result);
      setValues({});
      await refresh().catch(() => { setSnapshot(undefined); });
    } catch (failure) {
      if (!active()) return;
      setError(failure instanceof Error ? failure.message : '原生操作失败');
      await api.nativeActionReceipt(sessionId, commandId).then(value => { if (active()) setReceipt(value); }).catch(() => undefined);
      if (!active()) return;
      await refresh().catch(() => undefined);
    } finally { if (active()) setBusy(false); }
  };
  const catalog = object(snapshot?.catalog);
  const state = object(snapshot?.state);
  const actions = Array.isArray(catalog['actions']) ? catalog['actions'] as Action[] : [];
  const selectedAction = actions.find(action => action.type === selected);
  const fields = Object.entries(object(selectedAction?.schema['properties'])).filter(([name, schema]) => !['type', 'revision'].includes(name) && object(schema)['readOnly'] !== true);
  const required = new Set(Array.isArray(selectedAction?.schema['required']) ? selectedAction.schema['required'] as string[] : []);
  const execute = (): void => {
    if (!selectedAction) return;
    try {
      const action: { type: string; [key: string]: unknown } = { type: selectedAction.type };
      if (snapshot?.agent === 'claude-code' && ['rename', 'tag', 'delete'].includes(selectedAction.type)) action['revision'] = object(catalog['metadata'])['revision'];
      for (const [name, schema] of Object.entries(object(selectedAction.schema['properties']))) {
        if (object(schema)['readOnly'] === true && object(schema)['default'] !== undefined) action[name] = object(schema)['default'];
      }
      for (const [name, definition] of fields) {
        const schema = object(definition); const value = values[name];
        if (value === undefined || value === '' && !required.has(name)) {
          if (schema['type'] === 'boolean' && required.has(name)) action[name] = false;
          else if (required.has(name)) throw new Error(`请填写 ${String(schema['title'] ?? name)}`);
          continue;
        }
        action[name] = Array.isArray(schema['enum']) ? schema['enum'].find(option => String(option) === String(value))
          : schema['type'] === 'boolean' ? value : schema['type'] === 'integer' || schema['type'] === 'number' ? Number(value)
          : schema['type'] === 'string' ? value : JSON.parse(String(value)) as unknown;
      }
      void submit(action);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '请检查表单格式'); }
  };
  const interactions = Array.isArray(state['interactions']) ? state['interactions'].map(object).filter(value => value['kind'] === 'elicitation') : [];
  return <section aria-label="原生控制" className="native-controls" style={{ padding: 16, display: 'grid', gap: 12 }}>
    <p style={{ margin: 0 }}>读取当前 Agent 的原生状态，明确选择操作后提交。历史与配置沿用当前会话。</p>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button className="btn" type="button" disabled={busy} onClick={() => { setBusy(true); setError(''); void refresh().catch(failure => setError(String(failure))).finally(() => setBusy(false)); }}>刷新原生状态</button>
      {snapshot === undefined ? <button className="btn primary" type="button" disabled={busy} onClick={() => { void submit({ type: 'connect' }, true); }}>连接原生控制</button> : null}
    </div>
    {error ? <p role="alert">{error}</p> : null}
    {receipt ? <p role="status" data-testid="native-action-receipt">{labels[receipt.state]} · {receipt.type}</p> : null}
    {snapshot ? <>
      <p style={{ margin: 0 }}>{snapshot.agent} · 原生会话 {snapshot.nativeId ?? '尚未建立'}</p>
      <label>原生操作<select className="text-input" value={selected} disabled={busy} onChange={event => { setSelected(event.target.value); setValues({}); setResult(undefined); }}>
        <option value="">请选择操作</option>{actions.map(action => <option key={action.type} value={action.type} disabled={!action.supported}>{action.label}{action.supported ? '' : '（尚不可用）'}</option>)}
      </select></label>
      {selectedAction ? <form onSubmit={event => { event.preventDefault(); execute(); }}>
        {fields.map(([name, definition]) => {
          const schema = object(definition); const options = schema['enum'];
          return <label key={name} style={{ display: 'block', marginBottom: 8 }}>{String(schema['title'] ?? name)}{required.has(name) ? '（必填）' : ''}
            {schema['type'] === 'boolean' ? <input type="checkbox" checked={values[name] === true} disabled={busy} onChange={event => setValues(previous => ({ ...previous, [name]: event.target.checked }))} />
              : Array.isArray(options) ? <select className="text-input" value={String(values[name] ?? '')} disabled={busy} onChange={event => setValues(previous => ({ ...previous, [name]: event.target.value }))}><option value="">请选择</option>{options.map(value => <option key={String(value)} value={String(value)}>{String(value)}</option>)}</select>
                : schema['type'] === 'string' || schema['type'] === 'integer' || schema['type'] === 'number' ? <input className="text-input" type={schema['format'] === 'password' || schema['writeOnly'] === true ? 'password' : schema['type'] === 'string' ? 'text' : 'number'} value={String(values[name] ?? '')} disabled={busy} onChange={event => setValues(previous => ({ ...previous, [name]: event.target.value }))} />
                  : <textarea className="text-input" aria-label={String(schema['title'] ?? name)} value={String(values[name] ?? '')} disabled={busy} onChange={event => setValues(previous => ({ ...previous, [name]: event.target.value }))} placeholder="JSON" />}
          </label>;
        })}
        <button className="btn primary" type="submit" disabled={busy || !selectedAction.supported || selectedAction.requiresIdle === true && state['turnActive'] === true}>提交{selectedAction.label}</button>
      </form> : null}
      {interactions.map(interaction => {
        const payload = object(interaction['payload']); const requestId = String(interaction['requestId']); const mode = payload['mode'];
        if (interaction['status'] !== 'pending') return <p key={requestId}>原生请求 {requestId}：{String(interaction['status'])}，等待原生确认。</p>;
        return <div key={requestId}><strong>{String(payload['message'] ?? '原生 MCP 请求')}</strong><ElicitationForm busy={busy} form={mode === 'url'
          ? { kind: 'url', url: String(payload['url'] ?? ''), elicitationId: String(payload['elicitationId'] ?? requestId), serverName: String(payload['serverName'] ?? 'MCP') }
          : { kind: 'form', schema: object(payload['requestedSchema']), serverName: String(payload['serverName'] ?? 'MCP') }}
          submit={answer => { void submit({ type: 'elicitation', requestId, ...answer }); }} /></div>;
      })}
      <details><summary>原生状态与能力</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 400, overflow: 'auto' }}>{JSON.stringify({ state: snapshot.state, catalog: snapshot.catalog }, null, 2)}</pre></details>
      <button className="btn" type="button" disabled={busy} onClick={() => { setBusy(true); void api.nativeHistory(sessionId).then(setHistory).catch(failure => setError(String(failure))).finally(() => setBusy(false)); }}>读取原生历史</button>
      {history === undefined ? null : <details open><summary>原生历史（当前页）</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto' }}>{JSON.stringify(history, null, 2)}</pre></details>}
      {result === undefined ? null : <details open><summary>本次原生返回</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 400, overflow: 'auto' }}>{JSON.stringify(result, null, 2)}</pre></details>}
    </> : null}
    {snapshot?.agent === 'codex' || snapshot?.agent === 'claude-code' ? <details><summary>原生 CLI</summary><NativeSurface sessionId={sessionId} agent={snapshot.agent} /></details> : null}
    {snapshot?.agent === 'codex' ? <details><summary>原生进程终端</summary><NativeProcessSurface sessionId={sessionId} /></details> : null}
    {snapshot?.agent === 'dsh' ? <details><summary>DSH 原生页面</summary><NativeDshSurface sessionId={sessionId} /></details> : null}
  </section>;
}
