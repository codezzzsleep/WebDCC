import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMeta, FsListResponse, FsReadResponse } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';
import { agentInfo } from '../lib/format.js';

interface ComposerProps {
  sessionId: string;
  workspaceId: string;
  agent: string;
  meta?: AgentMeta;
  onSend?: (text: string) => void;
}

interface MentionState {
  open: boolean;
  query: string;
  start: number;
}

export function Composer({ sessionId, workspaceId, agent, meta, onSend }: ComposerProps): React.ReactElement {
  useStoreVersion();
  const session = store.getSession(sessionId);
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [mention, setMention] = useState<MentionState>({ open: false, query: '', start: 0 });
  const [files, setFiles] = useState<{ name: string; path: string }[]>([]);
  const [accessOpen, setAccessOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void store.loadDraft(sessionId).then((draft) => setText(draft.text));
  }, [sessionId]);

  useEffect(() => {
    if (!mention.open) return;
    void api
      .fs(workspaceId, '')
      .then((result) => {
        if ('entries' in result) setFiles(result.entries.filter((entry) => entry.type === 'file').map((entry) => ({ name: entry.name, path: entry.path })));
      })
      .catch(() => setFiles([]));
  }, [mention.open, workspaceId]);

  const running = session?.status === 'running' || session?.status === 'waiting';
  const accessModes = meta?.accessModes ?? [];
  const currentMode = accessModes.find((mode) => mode.id === session?.accessMode) ?? accessModes[0];

  const conversations = useMemo(() => {
    const list = store.getSessions().filter((item) => item.workspaceId === workspaceId && item.id !== sessionId);
    if (mention.query === '') return list;
    return list.filter((item) => (item.title ?? '').toLowerCase().includes(mention.query.toLowerCase()));
  }, [mention.query, sessionId, workspaceId, store.getVersion()]);

  const filteredFiles = useMemo(() => {
    if (mention.query === '') return files.slice(0, 8);
    return files.filter((file) => file.path.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 8);
  }, [files, mention.query]);

  const updateText = (value: string): void => {
    setText(value);
    store.setDraft(sessionId, value, images);
    const cursor = textareaRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const at = before.lastIndexOf('@');
    if (at >= 0 && !/\s/.test(before.slice(at + 1))) {
      setMention({ open: true, query: before.slice(at + 1), start: at });
    } else {
      setMention({ open: false, query: '', start: 0 });
    }
  };

  const insertMention = (insert: string): void => {
    const cursor = textareaRef.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}${insert}${text.slice(cursor)}`;
    setText(next);
    store.setDraft(sessionId, next, images);
    setMention({ open: false, query: '', start: 0 });
    textareaRef.current?.focus();
  };

  const submit = (): void => {
    const value = text.trim();
    if (value === '' || running) return;
    store.sendMessage(sessionId, text, images);
    setText('');
    setImages([]);
    store.setDraft(sessionId, '', []);
    onSend?.(text);
  };

  const pickFile = (): void => fileInputRef.current?.click();

  const uploadFiles = async (list: FileList | null): Promise<void> => {
    if (list === null) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        const buffer = await file.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const init = await fetch('/api/uploads', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: file.name, size: file.size, sha256, mime: file.type || 'application/octet-stream' }),
        }).then((response) => response.json() as Promise<{ uploadId: string; chunkSize: number; existingFileId?: string }>);
        if (init.existingFileId !== undefined) {
          setImages((prev) => [...prev, init.existingFileId as string]);
          continue;
        }
        const chunkSize = init.chunkSize;
        for (let index = 0; index * chunkSize < buffer.byteLength; index += 1) {
          await fetch(`/api/uploads/${init.uploadId}/chunks/${index}`, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/octet-stream' },
            body: buffer.slice(index * chunkSize, (index + 1) * chunkSize),
          });
        }
        const complete = await fetch(`/api/uploads/${init.uploadId}/complete`, { method: 'POST', credentials: 'same-origin' }).then(
          (response) => response.json() as Promise<{ fileId: string }>,
        );
        setImages((prev) => [...prev, complete.fileId]);
      }
    } finally {
      setUploading(false);
    }
  };

  const stats = statsFor(sessionId);

  return (
    <div className="composer" data-testid="composer">
      {mention.open ? (
        <div className="mention-menu" data-testid="at-menu">
          <div className="mention-group">
            <div className="mention-title">文件与文件夹</div>
            {filteredFiles.length === 0 ? <div className="muted">没有匹配的文件</div> : null}
            {filteredFiles.map((file) => (
              <button key={file.path} type="button" className="mention-item" onClick={() => insertMention(file.path)}>
                {file.name}
                <span className="muted">{file.path}</span>
              </button>
            ))}
          </div>
          <div className="mention-group">
            <div className="mention-title">对话</div>
            {conversations.length === 0 ? <div className="muted">同一工作区没有其他会话</div> : null}
            {conversations.map((item) => (
              <button
                key={item.id}
                type="button"
                className="mention-item"
                onClick={() => {
                  const final = store
                    .getEvents(item.id)
                    .filter((event) => event.kind === 'assistant.message')
                    .at(-1);
                  const text = final === undefined ? '' : (final.data as { text: string }).text;
                  insertMention(text);
                }}
              >
                {agentInfo(item.agent).mark} {item.title ?? '新会话'}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="composer-box">
        {images.length > 0 ? (
          <div className="attachments">
            {images.map((fileId) => (
              <span key={fileId} className="attachment-chip">
                图片 {fileId.slice(0, 6)}
                <button type="button" className="icon-button tiny" onClick={() => setImages((prev) => prev.filter((id) => id !== fileId))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          data-testid="composer-input"
          className="composer-input"
          placeholder="发消息或创建任务, / 调用指令, @ 文件或对话"
          value={text}
          rows={Math.min(10, Math.max(1, text.split('\n').length))}
          onChange={(event) => updateText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
            if (event.key === 'Escape') setMention({ open: false, query: '', start: 0 });
          }}
        />
        <div className="composer-bar">
          <div className="composer-bar-left">
            <button type="button" className="icon-button" onClick={pickFile} title="添加图片" disabled={uploading}>
              ＋
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => {
                void uploadFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <span className="menu-anchor">
              <button type="button" className="mode-button" onClick={() => setAccessOpen((value) => !value)} data-testid="access-mode">
                {currentMode?.label ?? '默认访问模式'}
              </button>
              {accessOpen ? (
                <div className="menu below" onMouseLeave={() => setAccessOpen(false)}>
                  {accessModes.map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      className={mode.id === currentMode?.id ? 'active' : ''}
                      onClick={() => {
                        setAccessOpen(false);
                        // 访问模式切换在 M6 接入（需要各 adapter 的实现）
                      }}
                    >
                      {mode.label}
                      <span className="muted"> {mode.id}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </span>
          </div>
          <div className="composer-bar-right">
            <span className="model-name">{session?.model ?? meta?.models?.[0]?.label ?? '默认模型'}</span>
            {running ? (
              <button type="button" className="button stop" onClick={() => store.interrupt(sessionId)} data-testid="stop-button">
                停止
              </button>
            ) : (
              <button type="button" className="button primary" onClick={submit} data-testid="send-button">
                发送
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="composer-stats">{stats}</div>
    </div>
  );
}

function statsFor(sessionId: string): string {
  const events = store.getEvents(sessionId);
  const turns = new Set(events.map((event) => event.turnId)).size;
  const steps = events.filter((event) => event.kind === 'command' || event.kind === 'tool.call').length;
  const usage = events.filter((event) => event.kind === 'usage').at(-1);
  const data = usage?.data as { inputTokens?: number; outputTokens?: number } | undefined;
  const tokens = (data?.inputTokens ?? 0) + (data?.outputTokens ?? 0);
  return `${turns} 轮 · ${steps} 步${tokens > 0 ? ` · ${tokens} tokens` : ''}`;
}
