import type { RecoveredCompletion } from '@webdcc/protocol';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';

export function CompletedRecoveryNotice({ sessionId }: { sessionId: string }): React.ReactElement | null {
  useStoreVersion(); const recovery = store.getCompletedRecovery(sessionId);
  if (recovery === undefined || recovery.coverage === 'complete') return null;
  return <div className="timeline-inner" role="status" data-testid="completed-recovery-incomplete">
    部分原生输出的恢复信息不完整，请核对原记录。{recovery.hasMore ? '已达到恢复读取上限。' : ''}
  </div>;
}

export function RecoveredCompletionCard({ item }: { item: RecoveredCompletion }): React.ReactElement {
  const data = item.data as { text?: string; command?: string; outputTail?: string; output?: unknown };
  const text = data.text ?? data.outputTail ?? (typeof data.output === 'string' ? data.output : undefined);
  return <div className="step-row" data-testid="recovered-completion" data-projection-id={item.projectionId}>
    <div className="step-line"><span className="label">已保留的原生输出</span>{data.command === undefined ? null : <span className="detail">{data.command}</span>}</div>
    {item.conflict ? <p role="status">该条目有多个不同的原生记录，已全部保留。</p> : null}
    {text === undefined ? null : <pre className="output">{text}</pre>}
    <details><summary>查看已保留内容</summary><pre className="output">{JSON.stringify({ data: item.data, ...(item.native === undefined ? {} : { native: item.native }) }, null, 2)}</pre></details>
  </div>;
}
