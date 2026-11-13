import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { WatchdogSettings } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { useWatchdog, watchdogStatus } from '../lib/watchdog.js';
import { Icon } from '../components/Icon.js';

export function WatchdogPage(): React.ReactElement {
  const { view, error: loadError, setView } = useWatchdog();
  const [form, setForm] = useState<WatchdogSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (view !== null) setForm((current) => current ?? view.settings); }, [view]);

  const save = async (patch: Partial<WatchdogSettings>): Promise<void> => {
    setBusy(true); setError(null);
    try { const updated = await api.updateWatchdog(patch); setView(updated); setForm(updated.settings); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return (
    <main className="main" data-testid="watchdog-page">
      <div className="mobile-only session-header"><div className="session-header-row"><button type="button" className="icon-btn drawer-toggle" aria-label="会话列表" onClick={() => store.setDrawer(true)}><Icon name="menu" size={18} /></button></div></div>
      <div className="settings"><div className="settings-inner">
        <div><h1>Watchdog 看门狗</h1><p className="lead">全局保护 WebDCC 中的 Codex 会话，在失败后自动接续未完成的任务。</p></div>
        <section className="panel watchdog-settings">
          <div className="panel-head">
            <div><h2>Codex 自动恢复</h2><p className="muted">默认关闭。启用后会自动发送“继续”或建立接续会话，产生相应模型用量。</p></div>
            <button type="button" role="switch" aria-label="启用 Codex Watchdog" aria-checked={view?.settings.enabled ?? false} disabled={view === null || busy} className={`btn ${view?.settings.enabled ? 'primary' : ''}`} onClick={() => void save({ enabled: !(view?.settings.enabled ?? false) })} data-testid="watchdog-toggle">
              {view?.settings.enabled ? '已开启' : '已关闭'}
            </button>
          </div>
          <ul className="watchdog-explanation">
            <li>限流或流中断：等待退避后，在原会话继续。</li>
            <li>资源归属不匹配：建立平级的新 Codex 会话，用旧会话 ID 读取完整记录后继续。</li>
            <li>续跑和转交都可不限次数，也可分别填写上限；手动介入会取消等待。</li>
          </ul>
          <p className="muted">关闭开关会取消待执行的恢复。已经开始的轮次可在对应会话中停止。认证、余额、权限及其他未知错误需要手动处理。</p>
          {form === null ? <p className="muted">正在读取设置…</p> : (
            <form onSubmit={(event) => { event.preventDefault(); void save({ maxAttempts: form.maxAttempts, maxHandoffs: form.maxHandoffs, baseDelaySeconds: form.baseDelaySeconds, maxDelaySeconds: form.maxDelaySeconds }); }}>
              <div className="form-grid">
                {([
                  ['maxAttempts', '续跑上限', '不限续跑次数', 1, 5], ['maxHandoffs', '转交上限', '不限转交次数', 0, 3],
                ] as const).map(([key, label, unlimited, min, fallback]) => <div className="field" key={key}><label className="field"><span>{label}</span><input className="text-input" type="number" min={min} step={1} required={form[key] !== null} disabled={form[key] === null} value={form[key] ?? ''} placeholder="不限次数" onChange={(event) => setForm({ ...form, [key]: Number(event.target.value) })} /></label><label className="checkbox"><input type="checkbox" checked={form[key] === null} onChange={(event) => setForm({ ...form, [key]: event.target.checked ? null : fallback })} />{unlimited}</label></div>)}
                {([
                  ['baseDelaySeconds', '初始等待（秒）', 5, 3600], ['maxDelaySeconds', '最大退避等待（秒）', 5, 3600],
                ] as const).map(([key, label, min, max]) => <label className="field" key={key}><span>{label}</span><input className="text-input" type="number" min={min} max={max} required value={form[key]} onChange={(event) => setForm({ ...form, [key]: Number(event.target.value) })} /></label>)}
              </div>
              <div className="row-actions"><button type="submit" className="btn" disabled={busy}>保存恢复设置</button><span className="muted">保留退避等待；放宽上限会继续已因上限停止的恢复。</span></div>
            </form>
          )}
          {error !== null || loadError !== null ? <div className="error-card" role="alert">{error ?? loadError}</div> : null}
        </section>
        <section className="panel watchdog-settings">
          <h2>恢复记录</h2>
          {view?.jobs.length === 0 ? <p className="muted">还没有自动恢复记录。只处理启用后新发生的失败。</p> : null}
          <div className="watchdog-job-list">
            {view?.jobs.slice(0, 30).map((job) => <article className="watchdog-job" key={job.sessionId}>
              <div className="row-actions"><Link to="/s/$sid" params={{ sid: job.sessionId }} search={{}}>{store.getSession(job.sessionId)?.title ?? 'Codex 会话'}</Link><span className="badge">{watchdogStatus[job.status]}</span><span className="muted">续跑 {job.retries} 次 · 转交 {job.handoffs} 次</span></div>
              <p>{job.detail}</p>
              {job.nextAttemptAt === null ? null : <p className="muted">预计恢复：{new Date(job.nextAttemptAt).toLocaleString()}</p>}
              <div className="row-actions">{job.targetSessionId === undefined ? null : <Link to="/s/$sid" params={{ sid: job.targetSessionId }} search={{}} className="btn small">打开接续会话</Link>}
                {job.status === 'scheduled' || job.status === 'recovering' ? <button type="button" className="btn small" disabled={busy} onClick={() => { setBusy(true); void api.cancelWatchdog(job.sessionId).then(setView).catch((cause: unknown) => setError(String(cause))).finally(() => setBusy(false)); }}>取消后续恢复</button> : null}
              </div>
            </article>)}
          </div>
        </section>
      </div></div>
    </main>
  );
}
