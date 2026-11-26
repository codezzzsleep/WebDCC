import { randomUuid } from '../lib/uuid.js';
import { useEffect, useRef, useState } from 'react';
import type { DshSubagentInputRequest, DshSubagentSummary, NativeActionReceipt } from '@webdcc/protocol';
import { api } from '../lib/api.js';

type Attempt = Omit<DshSubagentInputRequest, 'text'> & { text?: string };
function restore(key: string): { text: string; attempt?: Attempt } {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? '{}') as { text?: unknown; attempt?: Attempt };
    const attempt = value.attempt;
    return { text: typeof value.text === 'string' ? value.text : '',
      ...(typeof attempt?.commandId === 'string' && ['queue', 'steer'].includes(attempt.delivery) ? { attempt } : {}) };
  } catch { return { text: '' }; }
}

/** An input receipt is acceptance, independent of the child's eventual result. */
export function DshChildComposer({ sessionId, child, disabled, onReadCurrent }: {
  sessionId: string; child: DshSubagentSummary; disabled: boolean; onReadCurrent: () => void;
}): React.ReactElement | null {
  const key = `wdcc:dsh-child-input:${sessionId}:${child.parentSessionId}:${child.childId}`;
  const [text, setText] = useState(() => restore(key).text);
  const [attempt, setAttempt] = useState<Attempt | undefined>(() => restore(key).attempt);
  const [receipt, setReceipt] = useState<NativeActionReceipt>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true); const sending = useRef(false); const generation = useRef(0);
  const attemptId = useRef(attempt?.commandId);

  const save = (draft: string, pending: Attempt | undefined): void => {
    try { sessionStorage.setItem(key, JSON.stringify({ text: draft, attempt: pending })); } catch { /* In-memory pending data is retained. */ }
  };
  const accept = (value: NativeActionReceipt, expected: Attempt): void => {
    const target = value.reference?.dshChild;
    if (value.commandId !== expected.commandId || value.sessionId !== sessionId || value.type !== 'dsh-child-prompt'
      || target !== undefined && (target.childSessionId !== child.childId || target.parentSessionId !== child.parentSessionId || target.nativeRequestId !== expected.commandId))
      throw new Error('子消息回执属于不同会话或输入，请刷新核对');
    if (value.state === 'completed' && (typeof target?.messageId !== 'string' || target.messageId === '')) throw new Error('原生接收身份尚未确认');
    setReceipt(value); setError(undefined);
    if (value.state === 'completed') {
      if (expected.text !== undefined) {
        setText(current => current === expected.text ? '' : current);
        setAttempt(current => current?.commandId === expected.commandId ? { ...current, text: undefined } : current);
      }
    }
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { save(text, attempt); }, [key, text, attempt]);
  useEffect(() => {
    if (attempt === undefined || sending.current) return;
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const expected = ++generation.current;
    const read = async (): Promise<void> => {
      try {
        const result = await api.subagentInputReceipt(sessionId, child.childId, attempt.commandId);
        if (!active || expected !== generation.current || attemptId.current !== attempt.commandId) return;
        accept(result.receipt, attempt);
        if (result.receipt.state === 'dispatching' || result.receipt.state === 'uncertain' || result.receipt.state === 'submitted') timer = setTimeout(() => void read(), 3000);
      } catch (cause) { if (active && expected === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [attempt?.commandId, sessionId, child.childId, child.parentSessionId, refresh]);

  const submit = async (delivery: 'queue' | 'steer', retry = false): Promise<void> => {
    if (sending.current) return;
    const pending = retry ? attempt : { commandId: randomUuid(), text, delivery, clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    if (pending?.text === undefined || pending.text.trim() === '') return;
    sending.current = true; setBusy(true); setError(undefined); setReceipt(undefined); generation.current++;
    attemptId.current = pending.commandId; save(text, pending); setAttempt(pending);
    try {
      const result = await api.sendSubagent(sessionId, child.childId, pending.text, pending);
      if (!mounted.current || attemptId.current !== pending.commandId) return;
      if (!('receipt' in result)) throw new Error('子消息接收回执未确认');
      accept(result.receipt, pending); onReadCurrent();
    } catch (cause) { if (mounted.current) setError(`${cause instanceof Error ? cause.message : String(cause)}。正文已保留，请核对接收状态。`); }
    finally { sending.current = false; if (mounted.current) { setBusy(false); setRefresh(value => value + 1); } }
  };
  if (child.mode !== 'continuable') return null;
  const unresolved = attempt !== undefined && attempt.text !== undefined && receipt?.state !== 'failed';
  return <div className="dsh-child-controls" data-testid="dsh-child-composer">
    <label>消息 · {child.name ?? child.label ?? child.childId}<textarea className="text-input" value={text} rows={3} disabled={disabled || busy}
      onChange={event => setText(event.target.value)} aria-label={`子消息 · ${child.name ?? child.label ?? child.childId}`} /></label>
    <div className="row-actions">
      <button type="button" className="btn small" disabled={disabled || busy || unresolved || text.trim() === ''} onClick={() => void submit('queue')}>发送到子 Agent 队列</button>
      <button type="button" className="btn small ghost" disabled={disabled || busy || unresolved || text.trim() === '' || child.state?.running !== true} onClick={() => void submit('steer')}>介入子 Agent 当前轮</button>
    </div>
    <p className="muted">队列按原生顺序处理；介入会尽量在当前轮生效，时机不允许时由原生排队。</p>
    {busy ? <p role="status">正在提交子消息…</p> : null}
    {receipt?.state === 'completed' ? <p role="status">原生已接收这条子消息；执行结果请查看子会话。</p> : null}
    {receipt?.state === 'dispatching' ? <p role="status">子消息已登记，原生接收待确认。</p> : null}
    {receipt?.state === 'uncertain' || receipt?.state === 'submitted' ? <p role="alert">子消息接收结果待核对，刷新会先查询原生队列或历史。</p> : null}
    {receipt?.state === 'failed' ? <p role="alert">{receipt.reference?.dshChild?.rejection?.code === 'subagent/delivery-unavailable'
      ? '原生当前无法交付子消息，请核对原生根会话是否可用。正文保留，重试是一条新的输入。'
      : receipt.reference?.dshChild?.rejection?.message ?? '子消息未被原生接收，正文已保留。'}</p> : null}
    {error === undefined ? null : <p role="alert">{error}</p>}
    {attempt === undefined ? null : <div className="row-actions">
      <button type="button" className="btn small ghost" disabled={busy} onClick={() => setRefresh(value => value + 1)}>核对子消息接收状态</button>
      {attempt.text !== undefined && receipt?.state !== 'failed' ? <button type="button" className="btn small ghost" disabled={busy || disabled} onClick={() => void submit(attempt.delivery, true)}>重试同一子消息</button> : null}
    </div>}
  </div>;
}
