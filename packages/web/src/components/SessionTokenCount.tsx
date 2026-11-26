import { useEffect, useRef, useState } from 'react';
import type { SessionUsageResponse } from '@webdcc/protocol';
import { api } from '../lib/api.js';

interface Props {
  sessionId: string;
  usageSeq: number;
  resetSeq: number;
  online: boolean;
  reconnectedAt: number;
}
interface Reading {
  usage: SessionUsageResponse;
  reconnectedAt: number;
}
const tokensFormat = new Intl.NumberFormat('zh-CN');

export function SessionTokenCount({ sessionId, usageSeq, resetSeq, online, reconnectedAt }: Props): React.ReactElement | null {
  const lastReading = useRef<Reading>(undefined);
  const [reading, setReading] = useState<Reading>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!online) return;
    const last = lastReading.current;
    if (last?.reconnectedAt === reconnectedAt && last.usage.resetSeq === resetSeq && last.usage.throughSeq >= usageSeq) return;
    const controller = new AbortController();
    // Coalesce adjacent turn markers and usage frames from the live stream.
    const timer = window.setTimeout(() => {
      setFailed(false);
      void api.sessionUsage(sessionId, controller.signal).then(usage => {
        if (controller.signal.aborted) return;
        const next = { usage, reconnectedAt };
        lastReading.current = next;
        setReading(next);
      }, () => {
        if (!controller.signal.aborted) setFailed(true);
      });
    }, 100);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [sessionId, usageSeq, resetSeq, online, reconnectedAt, retry]);

  const usage = reading?.usage.resetSeq === resetSeq ? reading.usage : undefined;
  const stale = !online || reading?.reconnectedAt !== reconnectedAt || usage === undefined || usage.throughSeq < usageSeq;
  return <>
    {usage?.totalTokens !== undefined ? <span data-testid="session-token-count">
      {stale || usage.partial ? '已观测' : '累计'} {tokensFormat.format(usage.totalTokens)} tok
      {stale ? '（截至上次同步）' : usage.partial ? '（部分用量）' : ''}
    </span> : usage?.partial ? <span data-testid="session-token-count">用量未完整记录</span> : null}
    {failed && online ? <button type="button" onClick={() => setRetry(value => value + 1)}>重试读取用量</button> : null}
  </>;
}
