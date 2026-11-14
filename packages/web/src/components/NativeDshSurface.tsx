import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export function NativeDshSurface({ sessionId }: { sessionId: string }): React.ReactElement {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void api.nativeDshSurface().then(value => { if (live) { setAvailable(value.status === 'ready'); if (value.status !== 'ready') setError('尚未配置可访问的独立原生页面地址。'); } }).catch(failure => { if (live) setError(String(failure)); });
    return () => { live = false; };
  }, []);
  const open = async (): Promise<void> => {
    setBusy(true); setError('');
    // Open during the click gesture; credentials are exchanged in a POST body.
    const name = `dsh-native-${crypto.randomUUID()}`;
    const popup = window.open('about:blank', name);
    if (!popup) { setError('浏览器阻止了新窗口，请允许后再打开。'); setBusy(false); return; }
    popup.opener = null;
    try {
      const ticket = await api.openNativeDshSurface(sessionId);
      const form = document.createElement('form'); form.method = 'POST'; form.action = ticket.actionUrl; form.target = name;
      const input = document.createElement('input'); input.type = 'hidden'; input.name = 'ticket'; input.value = ticket.ticket;
      form.append(input); document.body.append(form); form.submit(); form.remove(); input.value = '';
    } catch (failure) { popup.close(); setError(failure instanceof Error ? failure.message : '原生页面打开失败'); }
    finally { setBusy(false); }
  };
  return <section aria-label="DSH 原生页面" style={{ padding: 16 }}>
    <p>原生页面目前仅供查看；写操作需要完成原生会话接管验证。</p>
    <button type="button" className="btn" disabled={busy || !available} onClick={() => { void open(); }}>查看 DSH 原生页面</button>
    {error ? <p role="status">{error}</p> : null}
  </section>;
}
