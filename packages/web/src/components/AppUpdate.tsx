import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { updateApp } from '../lib/app-update.js';

declare const __WDCC_WEB_COMMIT__: string;
const clientCommit = typeof __WDCC_WEB_COMMIT__ === 'undefined' ? 'dev' : __WDCC_WEB_COMMIT__;

export function AppUpdate(): React.ReactElement | null {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!/^[a-f0-9]{40}$/.test(clientCommit)) return;
    let active = true;
    const check = (): void => {
      void api.meta().then(meta => {
        if (active && /^[a-f0-9]{40}$/.test(meta.commit)) setAvailable(meta.commit !== clientCommit);
      }).catch(() => undefined);
    };
    check(); const timer = setInterval(check, 60_000);
    window.addEventListener('focus', check); window.addEventListener('online', check);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', check); window.removeEventListener('online', check); };
  }, []);
  if (!available) return null;
  return <div className="app-update" role="status" data-testid="app-update">
    <span>页面有新版本，更新后可使用最新修复。</span>
    <button className="btn small" disabled={busy} onClick={() => {
      setBusy(true); setError(''); void updateApp().catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); });
    }}>{busy ? '正在保存草稿…' : '保存草稿并更新'}</button>
    {error ? <span role="alert">{error}</span> : null}
  </div>;
}
