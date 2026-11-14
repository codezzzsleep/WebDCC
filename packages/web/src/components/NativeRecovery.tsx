import { useEffect, useRef, useState } from 'react';
import type { ReconciliationView } from '@webdcc/protocol';
import { api } from '../lib/api.js';

export function NativeRecovery({ sessionId, onApplied }: { sessionId: string; onApplied: () => void }): React.ReactElement {
  const [view, setView] = useState<ReconciliationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => {
    const current = ++request.current; setView(null); setBusy(false); setError('');
    void api.reconciliation(sessionId).then(result => { if (current === request.current) setView(result.reconciliation); })
      .catch(failure => { if (current === request.current) setError(String(failure)); });
    return () => { request.current++; };
  }, [sessionId]);
  const run = async (apply: boolean): Promise<void> => {
    const current = ++request.current; setBusy(true); setError('');
    try {
      const result = apply && view !== null ? await api.applyReconciliation(sessionId, view.revision) : await api.reconcile(sessionId);
      if (current !== request.current) return;
      setView(result); if (result.applied) onApplied();
    } catch (failure) {
      if (current === request.current) { setError(failure instanceof Error ? failure.message : String(failure)); if (apply) setView(previous => previous === null ? null : { ...previous, canApply: false }); }
    } finally { if (current === request.current) setBusy(false); }
  };
  return <section aria-label="执行恢复"><h2>核对原生执行</h2>
    <p>读取原生记录，确认上次执行是否结束。恢复只收敛已确认的轮次，排队输入继续保留，发送由你另行发起。</p>
    <button className="btn" disabled={busy} onClick={() => { void run(false); }}>读取原生状态</button>
    {busy ? <p role="status">正在核对…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {view === null ? null : <div>
      <p>读取时间：{view.observedAt}；托管进程：{view.writer === 'exited' ? '已退出' : view.writer === 'running' ? '运行中' : '未确认'}</p>
      <p>原生会话：{view.observation.nativeId}；工作区：{view.observation.cwd ?? '未确认'}</p>
      {view.observation.notes.map((note, index) => <p key={index}>{note}</p>)}
      {view.outcomes.length > 0 ? <ul>{view.outcomes.map(outcome => <li key={outcome.turnId}>轮次 {outcome.nativeTurnId}：{outcome.status}</li>)}</ul> : null}
      {view.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
      {view.applied ? <p role="status">已恢复确认的终态，队列未自动发送。</p> : <button className="btn" disabled={busy || !view.canApply} onClick={() => { void run(true); }}>恢复已确认的结果</button>}
    </div>}
  </section>;
}
