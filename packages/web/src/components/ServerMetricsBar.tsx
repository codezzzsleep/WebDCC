import { useEffect, useState } from 'react';
import { api, type SystemMetrics } from '../lib/api.js';
import { Icon } from './Icon.js';

function bytes(value: number): string {
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function rate(value: number): string {
  if (value < 1024) return `${Math.round(value)} B/s`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB/s`;
  return `${(value / 1024 ** 2).toFixed(1)} MB/s`;
}

function tone(percent: number): string {
  return percent >= 90 ? 'danger' : percent >= 75 ? 'warning' : '';
}

export function ServerMetricsBar(): React.ReactElement | null {
  return <ServerMetricsStatus />;
}

/** 全局服务器状态放在侧栏品牌下方，不遮挡会话内容。 */
export function ServerMetricsStatus({ collapsed = false, onExpand }: { collapsed?: boolean; onExpand?: () => void }): React.ReactElement | null {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = (): void => {
      void api.systemMetrics().then((next) => { if (alive) setMetrics(next); }).catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  if (metrics === null) return null;
  if (collapsed) {
    return (
      <button
        type="button"
        className={`server-metrics-collapsed ${tone(metrics.cpu.usagePercent)}`}
        aria-label="查看服务器资源使用情况"
        title={`服务器 · CPU ${metrics.cpu.usagePercent.toFixed(1)}% · 内存 ${metrics.memory.usedPercent.toFixed(1)}%`}
        onClick={() => onExpand?.()}
      >
        <span className="server-metrics-dot" aria-hidden="true" />
        <Icon name="activity" size={18} />
      </button>
    );
  }
  return (
    <section className="server-metrics" aria-label="服务器资源使用情况">
      <button type="button" className="server-metrics-summary" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className="server-metrics-summary-head">
          <span className={`server-metrics-dot ${tone(Math.max(metrics.cpu.usagePercent, metrics.memory.usedPercent, metrics.disk.usedPercent))}`} aria-hidden="true" />
          <strong>服务器</strong>
          <small>{expanded ? '收起详情' : '查看详情'}</small>
          <Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={13} />
        </span>
        <span className="server-metrics-summary-row">
          <span className={`server-metric ${tone(metrics.cpu.usagePercent)}`}><b>CPU</b> {metrics.cpu.usagePercent.toFixed(1)}%</span>
          <span className={`server-metric ${tone(metrics.memory.usedPercent)}`}><b>内存</b> {metrics.memory.usedPercent.toFixed(1)}%</span>
        </span>
        <span className="server-metrics-summary-row">
          <span className="server-metric"><b>网络</b> ↓ {rate(metrics.network.rxBytesPerSec)} ↑ {rate(metrics.network.txBytesPerSec)}</span>
          <span className={`server-metric ${tone(metrics.disk.usedPercent)}`}><b>磁盘</b> {metrics.disk.usedPercent.toFixed(1)}%</span>
        </span>
      </button>
      {expanded ? (
        <div className="server-metrics-details" role="status">
          <div className="server-metrics-detail"><b>CPU</b><span>{metrics.cpu.usagePercent.toFixed(1)}% · 负载 {metrics.cpu.load1.toFixed(2)}</span></div>
          <div className="server-metrics-detail"><b>内存</b><span>{metrics.memory.usedPercent.toFixed(1)}% · {bytes(metrics.memory.usedBytes)}/{bytes(metrics.memory.totalBytes)}</span></div>
          <div className="server-metrics-detail"><b>网络</b><span>↓ {rate(metrics.network.rxBytesPerSec)} · ↑ {rate(metrics.network.txBytesPerSec)}</span></div>
          <div className="server-metrics-detail"><b>磁盘</b><span>{metrics.disk.usedPercent.toFixed(1)}% · 剩余 {bytes(metrics.disk.availableBytes)}</span></div>
          <small className="server-metrics-updated">每 2 秒更新 · {new Date(metrics.at).toLocaleTimeString()}</small>
        </div>
      ) : null}
    </section>
  );
}
