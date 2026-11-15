import { useEffect, useRef, useState } from 'react';
import type { NativeActionReceipt, NativeActionResponse, SlashControlRequest, SlashControlResult } from '@webdcc/protocol';
import { api } from '../lib/api.js';

export function SlashControl({ sessionId, request, onAccepted, onClose, initialResponse }: { sessionId: string; request: SlashControlRequest; onAccepted(): void; onClose(): void; initialResponse?: NativeActionResponse }) {
  const [result, setResult] = useState<SlashControlResult>();
  const [receipt, setReceipt] = useState<NativeActionReceipt>();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [objective, setObjective] = useState('');
  const callback = useRef(onAccepted); callback.current = onAccepted;
  const readResult = async (response: NativeActionResponse): Promise<NativeActionResponse> => {
    const deadline = Date.now() + 10_000;
    while (response.receipt.state === 'dispatching' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 150));
      response = await api.slashControlResult(sessionId, response.receipt.commandId);
    }
    return response;
  };
  const send = async (input: SlashControlRequest): Promise<void> => {
    setBusy(true); setError('');
    try {
      try { sessionStorage.setItem(`native-action:${sessionId}`, input.commandId); sessionStorage.setItem(`slash-action:${sessionId}`, input.commandId); } catch { /* Server receipt remains authoritative. */ }
      const response = await readResult(await api.slashControl(sessionId, input));
      setReceipt(response.receipt);
      const value = response.result as SlashControlResult | undefined;
      setResult(value); setObjective(value?.objective ?? '');
      if (!value?.form && !value?.failed && ['completed', 'submitted'].includes(response.receipt.state)) callback.current();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      await api.nativeActionReceipt(sessionId, input.commandId).then(setReceipt).catch(() => undefined);
    } finally { setBusy(false); }
  };
  useEffect(() => {
    if (initialResponse) { const value = initialResponse.result as SlashControlResult | undefined; setReceipt(initialResponse.receipt); setResult(value); setObjective(value?.objective ?? ''); }
    else void send(request);
  }, [sessionId, request.commandId]);
  const next = async (options: Partial<SlashControlRequest>): Promise<void> => {
    const catalog = await api.slashCommands(sessionId);
    const { contentParts: _parts, ...original } = request;
    // The edited objective is a new user input. Never reuse text/attachment
    // metadata describing the command that opened this form.
    await send({ ...original, ...options, revision: catalog.revision, commandId: crypto.randomUUID() });
  };
  return <section aria-label="原生指令结果" className="panel" style={{ padding: 12 }}>
    <div className="row-actions"><strong>{request.line || '原生指令结果'}</strong><button type="button" disabled={busy} onClick={() => { try { sessionStorage.removeItem(`slash-action:${sessionId}`); } catch { /* Optional browser pointer. */ } onClose(); }}>关闭指令结果</button></div>
    {busy ? <p role="status">正在读取原生指令结果…</p> : null}
    {receipt ? <p role="status">{receipt.state === 'submitted' ? '已提交，等待原生完成' : receipt.state === 'uncertain' ? '结果未确认，请读取原生状态，勿重复执行' : receipt.state === 'completed' ? '原生调用已返回' : receipt.state === 'failed' ? '原生指令未成功' : '等待原生结果'}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {result?.text ? <pre style={{ whiteSpace: 'pre-wrap' }}>{result.text}</pre> : null}
    {result?.form === 'goal-replace' ? <><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(result.result, null, 2)}</pre><button type="button" disabled={busy} onClick={() => void next({ line: `/goal ${objective}`, replaceGoal: true }).catch(failure => setError(String(failure)))}>确认替换原生目标</button></> : null}
    {result?.form === 'goal-edit' || result?.form === 'rename' ? <form onSubmit={event => { event.preventDefault(); void next({ line: result.form === 'rename' ? `/rename ${objective}` : `/goal ${objective}`, editGoal: result.form === 'goal-edit' }).catch(failure => setError(String(failure))); }}>
      <label>{result.form === 'rename' ? '原生标题' : '原生目标'}<textarea aria-label={result.form === 'rename' ? '原生标题' : '原生目标'} value={objective} disabled={busy} onChange={event => setObjective(event.target.value)} /></label>
      <button type="submit" disabled={busy || !objective.trim()}>提交原生修改</button>
    </form> : null}
    {receipt?.state === 'uncertain' ? <button type="button" onClick={() => void api.nativeControls(sessionId).then(value => setResult({ text: JSON.stringify(value.state, null, 2) })).catch(failure => setError(String(failure)))}>读取原生状态</button> : null}
    {receipt && ['dispatching', 'submitted'].includes(receipt.state) ? <button type="button" disabled={busy} onClick={() => void api.slashControlResult(sessionId, receipt.commandId).then(readResult).then(response => { setReceipt(response.receipt); setResult(response.result as SlashControlResult | undefined); }).catch(failure => setError(String(failure)))}>读取指令回执</button> : null}
  </section>;
}
