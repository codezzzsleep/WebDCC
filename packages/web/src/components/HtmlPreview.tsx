import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

export function HtmlPreview({ workspaceId, path, version, content, external, onExternal }: { workspaceId: string; path: string; version?: string; content?: string; external: boolean; onExternal: (enabled: boolean) => void }): React.ReactElement {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState('');
  const [resourceError, setResourceError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    let live = true;
    setUrl(undefined); setError(''); setResourceError(''); setLoading(true);
    void api.previewWorkspaceFile(workspaceId, path, content, external).then(value => { if (live) setUrl(value.url); })
      .catch(cause => { if (live) { setError(cause instanceof Error ? cause.message.replace(/^\d+ /, '') : '无法打开页面预览'); setLoading(false); } });
    return () => { live = false; };
  }, [workspaceId, path, version, content, revision, external]);
  useEffect(() => {
    const message = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== 'webdcc-preview-error' || typeof event.data.message !== 'string') return;
      setResourceError(event.data.message.slice(0, 240));
    };
    window.addEventListener('message', message);
    return () => window.removeEventListener('message', message);
  }, []);
  return <div className="html-file-preview" data-testid="html-preview">
    <div className="file-preview-actions">
      <span className="muted">{content === undefined ? '页面效果' : '正在预览未保存的编辑'}</span>
      <button type="button" className="btn small" onClick={() => setRevision(value => value + 1)}>刷新预览</button>
      <label><input type="checkbox" checked={external} onChange={event => onExternal(event.target.checked)} />允许页面联网</label>
      {url === undefined ? null : <a href={url} target="_blank" rel="noreferrer">新窗口预览</a>}
    </div>
    {loading ? <p role="status">正在加载页面…</p> : null}
    {error ? <p className="file-editor-error" role="alert">{error}</p> : null}
    {resourceError ? <p className="file-editor-error" role="status">{resourceError}</p> : null}
    {url === undefined ? null : <iframe ref={frame} src={url} title={`${path} 页面效果`} sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={() => setLoading(false)} />}
  </div>;
}
