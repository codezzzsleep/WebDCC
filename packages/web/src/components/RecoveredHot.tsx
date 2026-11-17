import type { LiveItem } from '@webdcc/protocol';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';

export function HotRecoveryNotice({ sessionId }: { sessionId: string }): React.ReactElement | null {
  useStoreVersion();
  const recovery = store.getHotRecovery(sessionId);
  if (recovery === undefined || recovery.coverage === 'complete') return null;
  return <div className="timeline-inner" role="status" data-testid="hot-recovery-incomplete">
    部分先前输出缺少可验证的恢复信息，请核对原生记录。{recovery.hasMore ? '已达到恢复读取上限。' : ''}
  </div>;
}

/** Display original mapped data without live animations or executable actions. */
export function RecoveredHotItem({ item }: { item: LiveItem }): React.ReactElement {
  const data = item.data as { text?: string; command?: string; outputTail?: string };
  return <div className="step-row" data-testid="recovered-hot-item" data-item-key={item.itemKey}>
    <div className="step-line"><span className="label">观测已丢失 · 已保留的输出</span>{data.command === undefined ? null : <span className="detail">{data.command}</span>}</div>
    {data.text === undefined ? null : <pre className="output">{data.text}</pre>}
    {data.outputTail === undefined ? null : <pre className="output">{data.outputTail}</pre>}
    <details><summary>查看已保留内容</summary><pre className="output">{JSON.stringify(item.data, null, 2)}</pre></details>
  </div>;
}
