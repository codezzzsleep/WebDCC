import { useEffect, useState } from 'react';
import type { DshQuestionRecoveryView, StoredEvent } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';

export function DshQuestionRecovery({ event, questionId }: { event: StoredEvent; questionId: string }): React.ReactElement {
  const [view, setView] = useState<DshQuestionRecoveryView>();
  const [error, setError] = useState(''); const [refresh, setRefresh] = useState(0);
  const submission = store.getInteractionSubmission(event.sessionId, 'answer', questionId);
  const isRetry = store.isDshQuestionRetry(event.sessionId, questionId);
  const retrying = isRetry && submission?.status === 'pending';
  useEffect(() => {
    let current = true; setView(undefined); setError('');
    void api.dshQuestionRecovery(event.sessionId, questionId).then(value => { if (current) setView(value); })
      .catch(error => { if (current) setError(String(error)); });
    return () => { current = false; };
  }, [event.sessionId, event.seq, questionId, refresh]);
  useEffect(() => {
    if (isRetry && submission !== undefined && ['failed', 'uncertain'].includes(submission.status)) {
      setView(undefined); setError(submission.error ?? '本组原回答提交结果待核对，请重新核对问题组');
    }
  }, [isRetry, submission]);
  if (view?.status === 'available') return <div className="approval-recovery" data-testid="dsh-question-recovery">
    <p>本组原回答：</p>
    <ol>{view.items.map(item => <li key={item.id}>
      <p>{item.prompt}</p>
      {item.selected.length === 0 ? null : <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.selected.join('、')}</p>}
      {item.custom === undefined ? null : <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.custom}</pre>}
    </li>)}</ol>
    <button type="button" className="btn" disabled={retrying} onClick={() => {
      if (!store.retryDshQuestion(event.sessionId, view)) setError('当前问题组需要重新核对');
    }}>{retrying ? '正在提交本组原回答…' : '重试本组原回答'}</button>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
  return <div className="approval-recovery" data-testid="dsh-question-recovery">
    <p role={error ? 'alert' : 'status'}>{error || (view?.status === 'unavailable' ? view.reason : '正在核对本组原回答…')}</p>
    {view !== undefined || error ? <button type="button" className="btn" onClick={() => setRefresh(value => value + 1)}>重新核对问题组</button> : null}
  </div>;
}
