import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMeta } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';
import { agentInfo } from '../lib/format.js';

interface ComposerProps {
  sessionId: string;
  workspaceId: string;
  meta?: AgentMeta;
  runningAsRoot?: boolean;
  onSend?: (text: string) => void;
}

interface MentionState {
  open: boolean;
  query: string;
  start: number;
}

export function Composer({ sessionId, workspaceId, meta, runningAsRoot = false, onSend }: ComposerProps): React.ReactElement {
  useStoreVersion();
  const session = store.getSession(sessionId);
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [mention, setMention] = useState<MentionState>({ open: false, query: '', start: 0 });
  const [files, setFiles] = useState<{ name: string; path: string }[]>([]);
  const [accessOpen, setAccessOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashCommands, setSlashCommands] = useState<{ name: string; description?: string }[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (session === undefined) return;
    void api
      .models(session.agent, session.providerId ?? null)
      .then((list) => setModels(list))
      .catch(() => setModels([]));
  }, [session?.agent, session?.providerId, sessionId]);

  useEffect(() => {
    if (!slashOpen) return;
    void api
      .slashCommands(sessionId)
      .then((result) => setSlashCommands(result.commands))
      .catch(() => setSlashCommands([]));
  }, [slashOpen, sessionId]);

  const running = session?.status === 'running' || session?.status === 'waiting';
  const accessModes = meta?.accessModes ?? [];
  const rootBlocked = runningAsRoot && session?.agent === 'claude-code';
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
    // "/" 开头：打开斜杠命令菜单（F8）；Codex 不提供菜单（SL-03）
    setSlashOpen(value.startsWith('/') && !value.includes('\n') && session?.agent !== 'codex');
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
  const pickAttach = (): void => attachInputRef.current?.click();

  /** 分片上传一个文件，返回 fileId（断点续传：按服务端已收到的分片续传） */
  const uploadOne = async (file: File): Promise<string> => {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const init = (await fetch('/api/uploads', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: file.name, size: file.size, sha256, mime: file.type || 'application/octet-stream' }),
    }).then(async (response) => {
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))) as unknown as string);
      return response.json() as Promise<{ uploadId: string; chunkSize: number; received: number[]; existingFileId?: string }>;
    })) as { uploadId: string; chunkSize: number; received: number[]; existingFileId?: string };
    if (init.existingFileId !== undefined) return init.existingFileId;
    const chunkSize = init.chunkSize;
    const total = Math.ceil(buffer.byteLength / chunkSize);
    const sent = new Set(init.received);
    for (let index = 0; index < total; index += 1) {
      if (sent.has(index)) continue;
      const chunk = buffer.slice(index * chunkSize, (index + 1) * chunkSize);
      // 断网时重试同一个分片（A6f：服务端不会留下重复分片）
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const response = await fetch(`/api/uploads/${init.uploadId}/chunks/${index}`, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/octet-stream' },
            body: chunk,
          });
          if (response.ok) break;
        } catch {
          // 继续重试
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        const status = (await fetch(`/api/uploads/${init.uploadId}`, { credentials: 'same-origin' }).then((r) => r.json())) as {
          received: number[];
        };
        if (status.received.includes(index)) break;
      }
    }
    const complete = (await fetch(`/api/uploads/${init.uploadId}/complete`, { method: 'POST', credentials: 'same-origin' }).then((response) =>
      response.json(),
    )) as { fileId: string };
    return complete.fileId;
  };

  const uploadFiles = async (list: FileList | null): Promise<void> => {
    if (list === null) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        const fileId = await uploadOne(file);
        setImages((prev) => [...prev, fileId]);
      }
    } finally {
      setUploading(false);
    }
  };

  /** 其他文件：复制到 <工作区>/.webdcc/uploads/，把相对路径插进输入框（F7） */
  const attachFiles = async (list: FileList | null): Promise<void> => {
    if (list === null) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        if (file.size > 100 * 1024 * 1024) {
          window.alert(`文件超过 100 MB 上限：${file.name}`);
          continue;
        }
        const fileId = await uploadOne(file);
        const attached = (await fetch(`/api/workspaces/${workspaceId}/attach`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileId, name: file.name }),
        }).then((response) => response.json())) as { path: string };
        const cursor = textareaRef.current?.selectionStart ?? text.length;
        const next = `${text.slice(0, cursor)}${attached.path} ${text.slice(cursor)}`;
        setText(next);
        store.setDraft(sessionId, next, images);
      }
    } finally {
      setUploading(false);
    }
  };

  const stats = statsFor(sessionId);

  return (
    <div className="composer" data-testid="composer">
      {slashOpen ? (
        <div className="mention-menu" data-testid="slash-menu">
          <div className="mention-title">斜杠命令</div>
          {slashCommands.length === 0 ? <div className="muted">这个 Agent 没有可用的斜杠命令</div> : null}
          {slashCommands
            .filter((command) => command.name.startsWith(text.split('\n')[0] ?? ''))
            .slice(0, 10)
            .map((command) => (
              <button
                key={command.name}
                type="button"
                className="mention-item"
                onClick={() => {
                  setText(command.name);
                  store.setDraft(sessionId, command.name, images);
                  setSlashOpen(false);
                  textareaRef.current?.focus();
                }}
              >
                {command.name}
                {command.description === undefined ? null : <span className="muted">{command.description}</span>}
              </button>
            ))}
        </div>
      ) : null}
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
            <button type="button" className="icon-button" onClick={pickAttach} title="添加文件" disabled={uploading} data-testid="add-file">
              📎
            </button>
            <input
              ref={attachInputRef}
              type="file"
              multiple
              hidden
              data-testid="add-file-input"
              onChange={(event) => {
                void attachFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <span className="menu-anchor">
              <button type="button" className="mode-button" onClick={() => setAccessOpen((value) => !value)} data-testid="access-mode">
                {currentMode?.label ?? '默认访问模式'}
              </button>
              {accessOpen ? (
                <div className="menu below" onMouseLeave={() => setAccessOpen(false)}>
                  {accessModes.map((mode) => {
                    // 以 root 运行时 Claude Code 不允许 bypassPermissions（MODE-claude-01）
                    const blocked = mode.id === 'bypassPermissions' && rootBlocked;
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        className={mode.id === currentMode?.id ? 'active' : ''}
                        data-testid={`access-mode-${mode.id}`}
                        disabled={blocked}
                        title={blocked ? '以 root 运行时 Claude Code 不允许此模式' : undefined}
                        onClick={() => {
                          setAccessOpen(false);
                          store.setAccessMode(sessionId, mode.id);
                        }}
                      >
                        {mode.label}
                        <span className="muted"> {mode.id}</span>
                        {blocked ? <span className="muted">（以 root 运行时 Claude Code 不允许此模式）</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </span>
          </div>
          <div className="composer-bar-right">
            <select
              className="model-menu"
              data-testid="model-menu"
              value={session?.model ?? ''}
              onChange={(event) => {
                const next = event.target.value;
                if (next !== '') store.setModel(sessionId, next);
              }}
            >
              <option value="">{session?.model ?? '默认模型'}</option>
              {(models ?? []).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
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
  // "N 轮"只统计包含 user.message 的轮次（F4）
  const turns = new Set(
    events.filter((event) => event.kind === 'user.message' && event.turnId !== null).map((event) => event.turnId as string),
  ).size;
  const steps = events.filter((event) => event.kind === 'command' || event.kind === 'tool.call').length;
  const usage = events.filter((event) => event.kind === 'usage').at(-1);
  const data = usage?.data as { inputTokens?: number; outputTokens?: number } | undefined;
  const tokens = (data?.inputTokens ?? 0) + (data?.outputTokens ?? 0);
  return `${turns} 轮 · ${steps} 步${tokens > 0 ? ` · ${tokens} tokens` : ''}`;
}
