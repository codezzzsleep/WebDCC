import { useEffect, useState } from 'react';
import type { DshQuestionIdentity } from '@webdcc/protocol';
import type { DshWaitEntry } from '../lib/dsh-question-waits.js';
import { store } from '../lib/store.js';

export function useDshQuestionWait(sessionId: string, questionId: string, identity: DshQuestionIdentity | undefined, active: boolean, canClaim: boolean): DshWaitEntry | undefined {
  const [entry, setEntry] = useState<DshWaitEntry>();
  useEffect(() => {
    if (identity === undefined || !active) { setEntry(undefined); return; }
    const card = store.dshQuestionWaits.ensure(sessionId, questionId, identity, false);
    setEntry(card);
    return () => { card.card.releaseFocus(); };
  }, [sessionId, questionId, identity, active]);
  useEffect(() => {
    if (identity !== undefined && active) store.dshQuestionWaits.ensure(sessionId, questionId, identity, canClaim);
  }, [sessionId, questionId, identity, active, canClaim]);
  return entry;
}

export function DshQuestionWait({ entry }: { entry: DshWaitEntry }): React.ReactElement {
  const snapshot = entry.card.snapshot();
  const paused = snapshot.waitState === 'waiting' || snapshot.waitState === 'editing';
  return <div data-testid="dsh-question-wait" data-wait-state={snapshot.waitState} data-channel={snapshot.channel}>
    {snapshot.phase === 'continued' ? <p role="status">原生已继续执行，你仍可以回答本次问题。</p>
      : snapshot.countdown !== undefined ? <p role="status">{paused ? snapshot.waitState === 'waiting' ? '已暂停自动继续，等待你回答。' : '正在编辑回答，自动继续已暂停。'
        : `${Math.ceil(snapshot.countdown.remainingMs / 1000)} 秒后原生继续执行${snapshot.countdown.running ? '' : '（聚焦时暂停）'}`}</p>
      : <p role="status">{entry.error ?? '正在核对原生问题的等待状态…'}</p>}
    {snapshot.countdown !== undefined && !paused ? <button type="button" className="btn" onClick={() => {
      entry.card.takeTime(); store.dshQuestionWaits.drafts.save(entry.sessionId, entry.identity, 'waiting');
    }}>多给我一些时间</button> : null}
    {entry.error !== undefined && snapshot.phase === 'open' ? <button type="button" className="btn" disabled={store.connectionState !== 'online'}
      onClick={() => store.dshQuestionWaits.retry(entry)}>重新连接问题</button> : null}
  </div>;
}
