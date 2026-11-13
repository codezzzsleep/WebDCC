import { useEffect, useRef, useState } from 'react';
import type { FsReadResponse } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { Markdown } from './Markdown.js';
import { ImagePreview } from './ImagePreview.js';
import { isImageUrl } from '../lib/workspace-url.js';

interface Draft { version: string; baseContent: string; content: string; }
const drafts = new Map<string, Draft>();
const PREFIX = 'wdcc-file-draft:';
let unloadInstalled = false;
const normalise = (text: string): string => text.replace(/\r\n/g, '\n');
function hasDrafts(): boolean {
  if (drafts.size > 0) return true;
  try { for (let i = 0; i < sessionStorage.length; i += 1) if (sessionStorage.key(i)?.startsWith(PREFIX)) return true; } catch { /* memory is still available */ }
  return false;
}
function putDraft(key: string, value: Draft | null): void {
  if (value === null) drafts.delete(key); else drafts.set(key, value);
  try { if (value === null) sessionStorage.removeItem(PREFIX + key); else sessionStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* keep the in-memory buffer */ }
  if (!unloadInstalled && typeof window !== 'undefined') {
    unloadInstalled = true;
    window.addEventListener('beforeunload', event => { if (hasDrafts()) { event.preventDefault(); event.returnValue = ''; } });
  }
}
function getDraft(key: string): Draft | undefined {
  const cached = drafts.get(key);
  if (cached !== undefined) return cached;
  try {
    const text = sessionStorage.getItem(PREFIX + key);
    if (text === null) return undefined;
    const value = JSON.parse(text) as Draft;
    if (typeof value.version === 'string' && typeof value.baseContent === 'string' && typeof value.content === 'string') { drafts.set(key, value); return value; }
  } catch { /* damaged browser cache is ignored */ }
  return undefined;
}
// Drafts survive dock/page navigation, so the guard belongs to the application
// lifetime rather than only to the currently mounted textarea.
if (typeof window !== 'undefined') {
  unloadInstalled = true;
  window.addEventListener('beforeunload', event => { if (hasDrafts()) { event.preventDefault(); event.returnValue = ''; } });
}

export function FileEditor({ workspaceId, initial }: { workspaceId: string; initial: FsReadResponse }): React.ReactElement {
  const key = `${workspaceId}:${initial.path}`;
  const cached = getDraft(key);
  const [file, setFile] = useState<FsReadResponse>(() => cached === undefined ? initial : { ...initial, version: cached.version, content: cached.baseContent });
  const [text, setText] = useState(() => cached?.content ?? normalise(initial.content));
  const [editing, setEditing] = useState(cached !== undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(() => cached !== undefined && cached.version !== initial.version ? '磁盘文件已更新，保留了你的未保存编辑。' : null);
  const [saved, setSaved] = useState(false);
  const textRef = useRef(text); textRef.current = text;
  const fileRef = useRef(file); fileRef.current = file;
  const dirty = text !== normalise(file.content);
  const image = isImageUrl(file.path);

  useEffect(() => {
    if (initial.version === fileRef.current.version) return;
    if (textRef.current !== normalise(fileRef.current.content)) { setError('磁盘文件已更新，保留了你的未保存编辑。'); return; }
    setFile(initial); setText(normalise(initial.content)); textRef.current = normalise(initial.content);
  }, [initial]);

  const update = (value: string): void => {
    setText(value); textRef.current = value; setSaved(false);
    const base = fileRef.current;
    putDraft(key, value === normalise(base.content) || base.version === undefined ? null : { version: base.version, baseContent: base.content, content: value });
  };
  const save = async (): Promise<void> => {
    if (saving || !file.editable || file.version === undefined || !dirty) return;
    const sent = textRef.current; const base = fileRef.current;
    if (base.version === undefined) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const result = await api.saveWorkspaceFile(workspaceId, { path: base.path, content: sent, version: base.version });
      if (typeof result.version !== 'string' || typeof result.content !== 'string') throw new Error('保存响应缺少文件版本');
      const latest = getDraft(key)?.content ?? textRef.current;
      const remaining = latest === sent ? normalise(result.content) : latest;
      putDraft(key, remaining === normalise(result.content) ? null : { version: result.version, baseContent: result.content, content: remaining });
      setFile(result); fileRef.current = result; setText(remaining); textRef.current = remaining; setSaved(true);
    } catch (cause) {
      setError((cause as { status?: number }).status === 409 ? '文件已被外部修改，保留了你的编辑内容。请重新加载后再保存。' : `保存失败：${cause instanceof Error ? cause.message.replace(/^\d+ /, '') : String(cause)}`);
    } finally { setSaving(false); }
  };
  const reload = async (leaveEditing = false): Promise<void> => {
    if (dirty && !window.confirm('重新加载将放弃这份未保存的编辑，继续吗？')) return;
    try {
      const result = await api.fs(workspaceId, file.path);
      if (!('content' in result)) throw new Error('路径已变成目录');
      putDraft(key, null); setFile(result); fileRef.current = result; setText(normalise(result.content)); textRef.current = normalise(result.content); setError(null); setSaved(false);
      if (leaveEditing) setEditing(false);
    } catch (cause) { setError(`读取失败：${cause instanceof Error ? cause.message.replace(/^\d+ /, '') : String(cause)}`); }
  };

  return (
    <section className="file-preview" data-testid="file-preview">
      <div className="file-editor-head">
        <span className="file-editor-name">{file.path}</span>
        {dirty ? <span className="muted" role="status">未保存 · 草稿已暂存</span> : saved ? <span className="muted" role="status">已保存</span> : null}
        <span className="spacer" />
        {image ? <a href={api.rawUrl(workspaceId, file.path)} target="_blank" rel="noreferrer">打开原图</a> : !editing ? <button type="button" className="btn small" disabled={!file.editable} onClick={() => setEditing(true)}>编辑</button> : <>
          <button type="button" className="btn primary small" disabled={saving || !dirty || !file.editable} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
          <button type="button" className="btn small" disabled={saving} onClick={() => void reload(true)}>取消编辑</button>
        </>}
      </div>
      {error !== null ? <div className="file-editor-error" role="alert">{error} <button type="button" className="link-button" disabled={saving} onClick={() => void reload()}>重新加载</button></div> : null}
      {file.readOnlyReason !== undefined && !image ? <p className="muted">{file.readOnlyReason}</p> : null}
      {image ? <ImagePreview src={api.rawUrl(workspaceId, file.path)} alt={file.path} /> : editing ? <textarea className="text-input file-editor-input" aria-label={`编辑 ${file.path}`} value={text} spellCheck={false} wrap="off" readOnly={!file.editable} onChange={event => update(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); } }} /> : <Markdown text={`\`\`\`\n${file.content}\n\`\`\``} />}
    </section>
  );
}
