import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { NativeRecoveryCapabilities, ReconciliationView } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { NativeDshSurface } from './NativeDshSurface.js';
import { NativeSurface } from './NativeSurface.js';

export function NativeRecovery({ sessionId, refreshRevision, onApplied }: { sessionId: string; refreshRevision: number; onApplied: () => void }): React.ReactElement {
  const [view, setView] = useState<ReconciliationView | null>(null);
  const [capabilities, setCapabilities] = useState<NativeRecoveryCapabilities>();
  const [ready, setReady] = useState(false);
  const [history, setHistory] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => {
    // Page refresh can retry a failed initial read while leaving an explicit review intact.
    if (ready) return;
    let cancelled = false;
    setError('');
    void api.reconciliation(sessionId).then(result => {
      if (cancelled) return;
      setView(result.reconciliation);
      setCapabilities(result.capabilities);
      setReady(true);
    }).catch(failure => { if (!cancelled) setError(String(failure)); });
    return () => { cancelled = true; };
  }, [sessionId, refreshRevision, ready]);
  const readHistory = async (options: { cursor?: string; offset?: number } = {}): Promise<void> => {
    const current = ++request.current; setBusy(true); setError('');
    try { const result = await api.nativeHistory(sessionId, options); if (current === request.current) setHistory(result); }
    catch (failure) { if (current === request.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (current === request.current) setBusy(false); }
  };
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
  const page = history !== null && typeof history === 'object' ? history as { hasMore?: boolean; nextCursor?: string; nextOffset?: number } : undefined;
  const nextPage = page?.hasMore === true ? typeof page.nextCursor === 'string' ? { cursor: page.nextCursor }
    : Number.isSafeInteger(page.nextOffset) ? { offset: page.nextOffset } : undefined : undefined;
  const canObserve = ready && capabilities?.canObserve !== false;
  return <section aria-label="执行恢复"><h2>核对原生执行</h2>
    <p>读取原生记录，确认上次执行是否结束。恢复只收敛已确认的轮次，排队输入继续保留，发送由你另行发起。</p>
    {capabilities?.canObserve === false ? <p role="status">{capabilities.reason}</p> : null}
    <button className="btn" disabled={busy || !canObserve} onClick={() => { void run(false); }}>读取原生状态</button>
    {capabilities?.canReadHistory ? <button className="btn" disabled={busy} onClick={() => { void readHistory(); }}>读取原生历史（仅查看）</button> : null}
    {history === undefined ? null : <details open><summary>本次原生历史窗口</summary>
      <p>此读取不会确认输入接收、解除原会话锁定或重发队列。每页按原生接口读取；不作为自动恢复证明。</p>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(history, null, 2)}</pre>
      {nextPage === undefined ? null : <button className="btn" disabled={busy} onClick={() => { void readHistory(nextPage); }}>读取下一页原生历史</button>}
    </details>}
    {capabilities?.canObserve === false ? <div>
      {capabilities.agent === 'dsh' ? <NativeDshSurface sessionId={sessionId} /> : capabilities.agent === 'codex' || capabilities.agent === 'claude-code' ? <NativeSurface sessionId={sessionId} agent={capabilities.agent} /> : null}
      <p>请先在原生入口核对旧任务。独立新会话与旧任务分开，原输入和队列仍保留。</p>
      <Link to="/new" search={{ w: capabilities.workspaceId, agent: capabilities.agent }} className="btn">新建独立会话</Link>
    </div> : null}
    {busy ? <p role="status">正在核对…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {view === null ? null : <div>
      <p>读取时间：{view.observedAt}；托管进程：{view.writer === 'exited' ? '已退出' : view.writer === 'running' ? '运行中' : '未确认'}</p>
      <p>原生会话：{view.observation.nativeId}；工作区：{view.observation.cwd ?? '未确认'}</p>
      {view.observation.notes.map((note, index) => <p key={index}>{note}</p>)}
      {view.outcomes.length > 0 ? <ul>{view.outcomes.map(outcome => <li key={outcome.turnId}>轮次 {outcome.nativeTurnId}：{outcome.status}</li>)}</ul> : null}
      {view.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
      {view.applied ? <p role="status">已恢复确认的终态，队列未自动发送。</p> : <button className="btn" disabled={busy || !canObserve || !view.canApply} onClick={() => { void run(true); }}>恢复已确认的结果</button>}
    </div>}
  </section>;
}
