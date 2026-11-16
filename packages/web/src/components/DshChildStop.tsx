import { useEffect, useRef, useState } from 'react';
import type { DshSubagentSummary, NativeActionReceipt } from '@webdcc/protocol';
import { api } from '../lib/api.js';

function restore(key: string): { commandId?: string; cursor?: number } {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? '{}') as { commandId?: unknown; cursor?: unknown };
    return { ...(typeof value.commandId === 'string' ? { commandId: value.commandId } : {}),
      ...(typeof value.cursor === 'number' ? { cursor: value.cursor } : {}) };
  } catch { return {}; }
}

/** Stop has no native terminal identity: retain admission and observe state separately. */
export function DshChildStop({ sessionId, child, disabled, onReadCurrent }: {
  sessionId: string; child: DshSubagentSummary; disabled: boolean; onReadCurrent: () => void;
}): React.ReactElement {
  const storageKey = `wdcc:dsh-child-stop:${sessionId}:${child.parentSessionId}:${child.childId}`;
  const [attempt, setAttempt] = useState(() => restore(storageKey));
  const [receipt, setReceipt] = useState<NativeActionReceipt>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true); const submitting = useRef(false);
  const ended = child.state?.running === false || attempt.cursor !== undefined && child.lastTurn !== undefined && child.lastTurn.seq > attempt.cursor;

  const accept = (value: NativeActionReceipt, commandId: string): void => {
    if (value.commandId !== commandId || value.sessionId !== sessionId || value.type !== 'dsh-child-interrupt'
      || value.reference !== undefined && value.reference.id !== child.childId) throw new Error('停止请求回执身份不匹配');
    setReceipt(value); setError(undefined);
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (attempt.commandId === undefined || submitting.current) return;
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      try {
        const result = await api.nativeActionReceipt(sessionId, attempt.commandId!);
        if (!active) return;
        accept(result, attempt.commandId!);
        if (result.state === 'dispatching') timer = setTimeout(() => void read(), 2000);
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [attempt.commandId, sessionId, child.childId, child.parentSessionId]);

  const stop = async (): Promise<void> => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError(undefined); setReceipt(undefined);
    const commandId = crypto.randomUUID(); const next = { commandId, cursor: child.state?.cursor };
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* The in-memory identity remains available. */ }
    setAttempt(next);
    try {
      const result = await api.interruptSubagent(sessionId, child.childId, commandId);
      if (!mounted.current) return;
      if (!('receipt' in result)) throw new Error('原生停止回执未确认');
      accept(result.receipt, commandId); onReadCurrent();
    } catch (cause) { if (mounted.current) setError(`${cause instanceof Error ? cause.message : String(cause)}。停止结果需核对，刷新不会重新发送请求。`); }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  };
  const check = async (): Promise<void> => {
    if (attempt.commandId === undefined) return;
    setBusy(true);
    try { const result = await api.nativeActionReceipt(sessionId, attempt.commandId); if (mounted.current) { accept(result, attempt.commandId); onReadCurrent(); } }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  if (child.mode !== 'continuable') return <p className="muted">当前子会话模式仅提供查看，独立控制入口尚不可用。</p>;
  return <div className="dsh-child-controls" data-testid="dsh-child-stop">
    <button type="button" className="btn small ghost danger-text" onClick={() => void stop()}
      disabled={disabled || busy || child.state?.running !== true || attempt.commandId !== undefined && receipt?.state !== 'failed' && !ended}>
      停止子 Agent · {child.name ?? child.label ?? child.childId}
    </button>
    {busy ? <p role="status">正在核对子 Agent 停止请求…</p> : null}
    {receipt?.state === 'submitted' ? <p role="status">停止请求已被原生接受；子 Agent 状态仍由原生更新。</p> : null}
    {receipt?.state === 'dispatching' ? <p role="status">停止请求已登记，原生是否受理待确认。</p> : null}
    {receipt?.state === 'uncertain' ? <p role="alert">停止结果未确认，请核对子 Agent 当前状态。</p> : null}
    {receipt?.state === 'failed' ? <p role="alert">停止请求未通过核对，可以刷新后重新操作。</p> : null}
    {error === undefined ? null : <p role="alert">{error}</p>}
    {attempt.commandId === undefined ? null : <button type="button" className="btn small ghost" disabled={busy} onClick={() => void check()}>核对停止请求</button>}
  </div>;
}
