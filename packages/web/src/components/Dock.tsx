import { useEffect, useState } from 'react';
import type { FsListResponse, FsReadResponse } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';
import { Markdown } from './Markdown.js';
import { Timeline } from './Timeline.js';

export type DockState =
  | { kind: 'session'; sessionId: string }
  | { kind: 'diff'; fileId: string; path: string; sessionId: string }
  | { kind: 'files'; workspaceId: string };

interface DockProps {
  state: DockState;
  onClose: () => void;
  onPromote: (sessionId: string) => void;
  onOpenDiff?: (fileId: string, path: string) => void;
  onHandoff: (text: string) => void;
}

export function Dock({ state, onClose, onPromote, onHandoff }: DockProps): React.ReactElement {
  useStoreVersion();
  const sameAsMain = state.kind === 'session' && state.sessionId === currentMainSessionId();
  return (
    <aside className="dock" data-testid="dock">
      <div className="dock-tabs">
        <button type="button" className="icon-button dock-back" data-testid="dock-back" title="返回" onClick={onClose}>
          ←
        </button>
        <span className="dock-tab active">
          {state.kind === 'session' ? '会话' : state.kind === 'diff' ? `改动 · ${state.path}` : '工作区文件'}
        </span>
        <span className="spacer" />
        <button type="button" className="icon-button" onClick={onClose} title="关闭停靠区">
          ×
        </button>
      </div>
      <div className="dock-body">
        {sameAsMain ? <div className="dock-notice" data-testid="dock-same-session">已经在主栏里了</div> : null}
        {state.kind === 'session' && !sameAsMain ? <DockSession sessionId={state.sessionId} onPromote={onPromote} onHandoff={onHandoff} /> : null}
        {state.kind === 'diff' ? <DiffView fileId={state.fileId} path={state.path} /> : null}
        {state.kind === 'files' ? <FilesView workspaceId={state.workspaceId} /> : null}
      </div>
    </aside>
  );
}

function DockSession({ sessionId, onPromote, onHandoff }: { sessionId: string; onPromote: (id: string) => void; onHandoff: (text: string) => void }): React.ReactElement {
  const session = store.getSession(sessionId);
  useEffect(() => {
    void store.ensureSession(sessionId);
  }, [sessionId]);
  return (
    <div className="dock-session">
      <div className="dock-session-header">
        <span className="session-title">{session?.title ?? '会话'}</span>
        <button type="button" className="link-button" onClick={() => onPromote(sessionId)}>
          移到主栏
        </button>
      </div>
      <Timeline sessionId={sessionId} onOpenDiff={() => undefined} onHandoff={onHandoff} />
    </div>
  );
}

function DiffView({ fileId, path }: { fileId: string; path: string }): React.ReactElement {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch(`/files/${fileId}`, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(`${response.status}`))))
      .then(async (text) => {
        const { html: renderDiff } = await import('diff2html');
        if (cancelled) return;
        setHtml(renderDiff(text, { drawFileList: false, matching: 'lines', outputFormat: 'side-by-side' }));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);
  if (error !== null) return <div className="muted">无法加载 diff：{error}</div>;
  if (html === null) return <div className="muted">加载中…</div>;
  return (
    <div className="diff-view">
      <div className="muted">{path}</div>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function FilesView({ workspaceId }: { workspaceId: string }): React.ReactElement {
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<FsListResponse | FsReadResponse | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    void api
      .fs(workspaceId, path)
      .then((result) => {
        setListing(result);
        setPreview(null);
      })
      .catch(() => setListing(null));
  }, [workspaceId, path]);
  return (
    <div className="files-view">
      <div className="crumbs">
        <button type="button" className="link-button" onClick={() => setPath('')}>
          工作区
        </button>
        {path.split('/').filter(Boolean).map((part, index, all) => (
          <span key={index}>
            /{' '}
            <button type="button" className="link-button" onClick={() => setPath(all.slice(0, index + 1).join('/'))}>
              {part}
            </button>
          </span>
        ))}
      </div>
      {listing !== null && 'entries' in listing ? (
        <ul className="file-list">
          {listing.entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  if (entry.type === 'dir') setPath(entry.path);
                  else
                    void api
                      .fs(workspaceId, entry.path)
                      .then((result) => setPreview('content' in result ? result.content : ''))
                      .catch(() => setPreview('（无法预览）'));
                }}
              >
                {entry.type === 'dir' ? '▸ ' : '· '}
                {entry.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {preview !== null ? (
        <div className="file-preview">
          <Markdown text={`\`\`\`\n${preview}\n\`\`\``} />
        </div>
      ) : null}
    </div>
  );
}


function currentMainSessionId(): string | null {
  const match = /^\/s\/([^/?+]+)/.exec(window.location.pathname);
  return match?.[1] ?? null;
}
