import { useEffect, useState } from 'react';
import { api, type SystemMetrics } from '../lib/api.js';

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
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
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
  return (
    <div className="server-metrics-bar" role="status" aria-label="服务器资源使用情况">
      <span className={`server-metric ${tone(metrics.cpu.usagePercent)}`}><b>CPU</b> {metrics.cpu.usagePercent.toFixed(1)}% <small>负载 {metrics.cpu.load1.toFixed(2)}</small></span>
      <span className={`server-metric ${tone(metrics.memory.usedPercent)}`}><b>内存</b> {metrics.memory.usedPercent.toFixed(1)}% <small>{bytes(metrics.memory.usedBytes)}/{bytes(metrics.memory.totalBytes)}</small></span>
      <span className="server-metric"><b>网络</b> ↓ {rate(metrics.network.rxBytesPerSec)} ↑ {rate(metrics.network.txBytesPerSec)}</span>
      <span className={`server-metric ${tone(metrics.disk.usedPercent)}`}><b>磁盘</b> {metrics.disk.usedPercent.toFixed(1)}% <small>剩余 {bytes(metrics.disk.availableBytes)}</small></span>
    </div>
  );
}
