import { useEffect, useState } from 'react';
import type { NativeTerminalResultsResponse } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';

export function NativeTerminalResults({ sessionId }: { sessionId: string }): React.ReactElement | null {
  useStoreVersion();
  const conversation = store.getSession(sessionId)?.conversation?.uuid;
  const nativeId = store.getSession(sessionId)?.nativeId;
  const uncertainTurns = JSON.stringify(store.getTurns(sessionId).filter(turn => turn.commandState === 'uncertain').map(turn => turn.turnId).sort());
  const throughEnvelopeId = Math.max(store.getHotRecovery(sessionId)?.throughEnvelopeId ?? 0, store.getCompletedRecovery(sessionId)?.throughEnvelopeId ?? 0);
  const scope = JSON.stringify([sessionId, conversation ?? null, nativeId ?? null, uncertainTurns, throughEnvelopeId, store.lastReconnectAt]);
  const connectionState = store.connectionState;
  const [view, setView] = useState<{ scope: string; result?: NativeTerminalResultsResponse; failed?: true }>();
  useEffect(() => {
    if (connectionState !== 'online') return;
    let current = true; const controller = new AbortController();
    void api.nativeTerminalResults(sessionId, controller.signal).then(result => {
      if (current) setView({ scope, result });
    }).catch(() => { if (current && !controller.signal.aborted) setView({ scope, failed: true }); });
    return () => { current = false; controller.abort(); };
  }, [sessionId, scope, connectionState]);
  if (view?.scope !== scope) return null;
  if (view.failed) return <div className="timeline-inner" role="status">原生轮次结果暂时无法读取，请稍后刷新。</div>;
  const result = view.result; if (result === undefined || result.outcomes.length === 0 && result.recovery.coverage === 'complete') return null;
  return <div className="timeline-inner">
    {result.recovery.coverage === 'partial' ? <p role="status" data-testid="native-terminal-recovery-incomplete">部分原生轮次结果的恢复信息不完整，请核对原记录。{result.recovery.hasMore ? '已达到读取上限。' : ''}</p> : null}
    {result.outcomes.map(item => <div className="step-row" key={item.outcomeId} data-testid="native-terminal-result" data-outcome-id={item.outcomeId}>
      <span className="label">原生已报告{{ completed: '完成', failed: '失败', interrupted: '中断' }[item.status]}</span>
      <p>网页轮次与输入状态仍按原记录保留。</p>
      {result.recovery.conflicts.some(conflict => conflict.scopeId === item.scopeId) ? <p role="status">该轮次存在不同结果记录，请核对原记录。</p> : null}
      <details><summary>查看原记录</summary><pre className="output">{JSON.stringify(item, null, 2)}</pre></details>
    </div>)}
  </div>;
}
