import { useEffect, useRef, useState } from 'react';
import type { FsListResponse, FsReadResponse } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';
import { agentText } from '../lib/agents.js';
import { AgentMark } from './AgentMark.js';
import { Icon } from './Icon.js';
import { Timeline } from './Timeline.js';
import { FileEditor } from './FileEditor.js';

export type DockState =
  | { kind: 'session'; sessionId: string }
  | { kind: 'diff'; fileId: string; path: string; sessionId: string }
  | { kind: 'files'; workspaceId: string };

interface DockProps {
  state: DockState;
  mainSessionId: string;
  onClose: () => void;
  onPromote: (sessionId: string) => void;
  onHandoff: (text: string) => void;
}

/** 右侧停靠区：并排对照另一个会话，或查看 diff、工作区文件。手机上全屏打开 */
export function Dock({ state, mainSessionId, onClose, onPromote, onHandoff }: DockProps): React.ReactElement {
  useStoreVersion();
  const session = state.kind === 'session' ? store.getSession(state.sessionId) : undefined;
  const sameAsMain = state.kind === 'session' && state.sessionId === mainSessionId;

  useEffect(() => {
    if (state.kind === 'session') void store.ensureSession(state.sessionId);
  }, [state]);

  return (
    <aside className="dock" data-testid="dock" aria-label="停靠区">
      <div className="dock-head">
        <button type="button" className="icon-btn dock-back" data-testid="dock-back" aria-label="返回主栏" onClick={onClose}>
          <Icon name="arrowLeft" size={18} />
        </button>
        {state.kind === 'session' ? (
          <>
            <AgentMark agent={session?.agent ?? ''} />
            <span className="title">{session?.title ?? '会话'}</span>
            <span className="sub">{agentText(session?.agent ?? '').name}</span>
          </>
        ) : state.kind === 'diff' ? (
          <>
            <Icon name="fileCode" />
            <span className="title">{state.path}</span>
            <span className="sub">改动</span>
          </>
        ) : (
          <>
            <Icon name="folder" />
            <span className="title">工作区文件</span>
          </>
        )}
        <span className="spacer" />
        {state.kind === 'session' && !sameAsMain ? (
          <button type="button" className="btn small" onClick={() => onPromote(state.sessionId)}>
            移到主栏
          </button>
        ) : null}
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭停靠区" title="关闭" data-testid="dock-close">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="dock-body">
        {sameAsMain ? (
          <div className="dock-notice" data-testid="dock-same-session">
            已经在主栏里了
          </div>
        ) : null}
        {state.kind === 'session' && !sameAsMain ? <Timeline sessionId={state.sessionId} onOpenDiff={() => undefined} onHandoff={onHandoff} compact /> : null}
        {state.kind === 'diff' ? <DiffView fileId={state.fileId} path={state.path} /> : null}
        {state.kind === 'files' ? <FilesView workspaceId={state.workspaceId} /> : null}
      </div>
      {state.kind === 'session' && !sameAsMain ? <div className="dock-foot">并排只是对照着看；要给它发消息，就"移到主栏"。</div> : null}
    </aside>
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
        setHtml(renderDiff(text, { drawFileList: false, matching: 'lines', outputFormat: 'line-by-line' }));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);
  if (error !== null) return <div className="dock-notice">无法加载 diff：{error}</div>;
  if (html === null) return <div className="dock-notice">加载中…</div>;
  return (
    <div className="diff-view" aria-label={`${path} 的改动`}>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function FilesView({ workspaceId }: { workspaceId: string }): React.ReactElement {
  const [location, setLocation] = useState({ workspaceId, path: '' });
  const path = location.workspaceId === workspaceId ? location.path : '';
  const setPath = (next: string): void => setLocation({ workspaceId, path: next });
  const [listing, setListing] = useState<FsListResponse | FsReadResponse | null>(null);
  const [preview, setPreview] = useState<{ workspaceId: string; file: FsReadResponse } | null>(null);
  const generation = useRef(0);
  const currentWorkspace = useRef(workspaceId); currentWorkspace.current = workspaceId;
  const [creating, setCreating] = useState<'file' | 'dir' | null>(null);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  useEffect(() => {
    const epoch = ++generation.current;
    if (workspaceId === '') {
      setListing(null);
      return;
    }
    void api
      .fs(workspaceId, path)
      .then((result) => {
        if (generation.current !== epoch) return;
        setListing(result);
        setPreview(null);
      })
      .catch(() => { if (generation.current === epoch) setListing(null); });
    return () => { if (generation.current === epoch) generation.current += 1; };
  }, [workspaceId, path]);
  return (
    <div className="files-view">
      <div className="crumbs">
        <button type="button" className="link-button" onClick={() => setPath('')}>
          工作区
        </button>
        {path
          .split('/')
          .filter(Boolean)
          .map((part, index, all) => (
            <span key={index}>
              /{' '}
              <button type="button" className="link-button" onClick={() => setPath(all.slice(0, index + 1).join('/'))}>
                {part}
              </button>
            </span>
          ))}
      </div>
      <div className="row-actions" style={{ marginBottom: 10 }}>
        <button type="button" className="btn small" onClick={() => { setCreating('file'); setNewName(''); setCreateError(null); }}>
          新建文件
        </button>
        <button type="button" className="btn small" onClick={() => { setCreating('dir'); setNewName(''); setCreateError(null); }}>
          新建文件夹
        </button>
      </div>
      {creating !== null ? (
        <form
          className="row-actions"
          onSubmit={(event) => {
            event.preventDefault();
            const name = newName.trim();
            if (name === '') return;
            setCreateError(null);
            void api.createWorkspaceEntry(workspaceId, { path: path === '' ? name : `${path}/${name}`, kind: creating })
              .then(() => { setCreating(null); setNewName(''); return api.fs(workspaceId, path); })
              .then(setListing)
              .catch((cause: unknown) => setCreateError(cause instanceof Error ? cause.message : String(cause)));
          }}
        >
          <input className="text-input" autoFocus value={newName} placeholder={creating === 'file' ? '文件名，例如 notes.md' : '文件夹名'} onChange={(event) => setNewName(event.target.value)} />
          <button type="submit" className="btn primary">创建</button>
          <button type="button" className="btn" onClick={() => setCreating(null)}>取消</button>
          {createError !== null ? <span className="status-failed">{createError}</span> : null}
        </form>
      ) : null}
      {listing !== null && 'entries' in listing ? (
        <ul className="file-list">
          {listing.entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() => {
                  if (entry.type === 'dir') setPath(entry.path);
                  else {
                    const epoch = ++generation.current;
                    void api
                      .fs(workspaceId, entry.path)
                      .then((result) => { if (generation.current === epoch && currentWorkspace.current === workspaceId && 'content' in result) setPreview({ workspaceId, file: result }); })
                      .catch(() => { if (generation.current === epoch) setPreview({ workspaceId, file: { path: entry.path, content: '（无法预览）', truncated: false, editable: false } }); });
                  }
                }}
              >
                <Icon name={entry.type === 'dir' ? 'folder' : 'fileText'} />
                {entry.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {preview !== null && preview.workspaceId === workspaceId ? <FileEditor key={`${workspaceId}:${preview.file.path}`} workspaceId={workspaceId} initial={preview.file} /> : null}
    </div>
  );
}
