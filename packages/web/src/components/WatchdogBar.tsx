import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { api } from '../lib/api.js';
import { useWatchdog, watchdogStatus } from '../lib/watchdog.js';
import { Icon } from './Icon.js';

export function WatchdogBar({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const { view, setView } = useWatchdog();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const job = view?.jobs.find((item) => item.sessionId === sessionId);
  if (view === null || (!view.settings.enabled && job === undefined)) return null;
  const seconds = job?.nextAttemptAt == null ? null : Math.max(0, Math.ceil((Date.parse(job.nextAttemptAt) - Date.now()) / 1000));
  return <div className="watchdog-bar" role="status" data-testid="watchdog-bar">
    <Icon name="shield" />
    <span><strong>Watchdog{job === undefined ? ' 已开启' : ` · ${watchdogStatus[job.status]}`}</strong>{job === undefined ? null : <span> {job.detail}{seconds === null ? '' : `（约 ${seconds} 秒后）`}</span>}</span>
    <div className="row-actions">
      {job?.targetSessionId === undefined ? null : <Link to="/s/$sid" params={{ sid: job.targetSessionId }} search={{}} className="btn small">打开接续会话</Link>}
      {job?.status === 'scheduled' || job?.status === 'recovering' ? <button type="button" className="btn small" disabled={busy} onClick={() => { setBusy(true); void api.cancelWatchdog(sessionId).then(setView).catch((cause: unknown) => setError(String(cause))).finally(() => setBusy(false)); }}>取消后续恢复</button> : null}
      <Link to="/settings/watchdog" className="link">设置</Link>
    </div>
    {error === null ? null : <span role="alert">{error}</span>}
  </div>;
}
