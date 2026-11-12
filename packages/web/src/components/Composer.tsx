import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderDto } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';
import { AGENT_IDS, agentAvailable, agentText, modelGroups, type ModelChoice } from '../lib/agents.js';
import { useAppData } from '../lib/appData.js';
import { AgentMark } from './AgentMark.js';
import { Icon } from './Icon.js';

type ComposerMode =
  | {
      kind: 'session';
      sessionId: string;
      /** "在另一个 Agent 中继续…" */
      onContinueIn: (agent: string) => void;
    }
  | {
      kind: 'new';
      agent: string;
      onAgentChange: (agent: string) => void;
      choice: ModelChoice;
      onChoice: (choice: ModelChoice) => void;
      accessMode: string | undefined;
      onAccessMode: (mode: string) => void;
      onSubmit: (text: string, images: string[]) => Promise<void>;
    };

interface ComposerProps {
  mode: ComposerMode;
  workspaceId: string;
}

interface MentionState {
  open: boolean;
  query: string;
  start: number;
}

type MenuName = 'harness' | 'mode' | 'model' | 'reasoning' | 'attach' | null;
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export function Composer({ mode, workspaceId }: ComposerProps): React.ReactElement {
  useStoreVersion();
  const { meta, providers } = useAppData();
  const isSession = mode.kind === 'session';
  const sessionId = mode.kind === 'session' ? mode.sessionId : null;
  const session = sessionId === null ? undefined : store.getSession(sessionId);
  const agent = mode.kind === 'session' ? (session?.agent ?? 'dsh') : mode.agent;
  const agentMeta = meta?.agents[agent];

  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [mention, setMention] = useState<MentionState>({ open: false, query: '', start: 0 });
  const [files, setFiles] = useState<{ name: string; path: string }[]>([]);
  const [menu, setMenu] = useState<MenuName>(null);
  const [uploading, setUploading] = useState(false);
  const [sessionModels, setSessionModels] = useState<string[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashCommands, setSlashCommands] = useState<{ name: string; description?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freeModel, setFreeModel] = useState('');
  const [sessionReasoning, setSessionReasoning] = useState('medium');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // 草稿：会话里的输入框跟着会话走（换设备也在）
  useEffect(() => {
    if (sessionId === null) return;
    setText(store.getDraft(sessionId).text);
    void store.loadDraft(sessionId).then((draft) => setText(draft.text));
  }, [sessionId]);

  useEffect(() => {
    if (session?.agent === 'codex') setSessionReasoning(session.reasoningEffort ?? 'medium');
  }, [sessionId, session?.agent, session?.reasoningEffort]);

  useEffect(() => {
    if (!mention.open || workspaceId === '') return;
    void api
      .fs(workspaceId, '')
      .then((result) => {
        if ('entries' in result) setFiles(result.entries.filter((entry) => entry.type === 'file').map((entry) => ({ name: entry.name, path: entry.path })));
      })
      .catch(() => setFiles([]));
  }, [mention.open, workspaceId]);

  // 会话里：同一 Provider 下可以换模型
  useEffect(() => {
    if (session === undefined) return;
    void api
      .models(session.agent, session.providerId ?? null)
      .then(setSessionModels)
      .catch(() => setSessionModels([]));
  }, [session?.agent, session?.providerId, sessionId]);

  useEffect(() => {
    if (!slashOpen || sessionId === null) return;
    void api
      .slashCommands(sessionId)
      .then((result) => setSlashCommands(result.commands))
      .catch(() => setSlashCommands([]));
  }, [slashOpen, sessionId]);

  // 点菜单外面关闭菜单
  useEffect(() => {
    if (menu === null) return;
    const onDown = (event: MouseEvent): void => {
      if (barRef.current !== null && !barRef.current.contains(event.target as Node)) setMenu(null);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const running = session?.status === 'running' || session?.status === 'waiting';
  const accessModes = agentMeta?.accessModes ?? [];
  const rootBlocked = meta?.runningAsRoot === true && agent === 'claude-code';
  const accessModeId = mode.kind === 'session' ? session?.accessMode : mode.accessMode;
  const currentMode = accessModes.find((item) => item.id === accessModeId) ?? accessModes[0];

  const providerOf = (id: string | null | undefined): ProviderDto | undefined => providers.find((provider) => provider.id === id);
  const currentProviderId = mode.kind === 'session' ? (session?.providerId ?? null) : mode.choice.providerId;
  const currentModel = mode.kind === 'session' ? (session?.model ?? '') : mode.choice.model;
  const currentReasoning = mode.kind === 'session' ? sessionReasoning : (mode.choice.reasoningEffort ?? 'medium');
  const currentProvider = providerOf(currentProviderId);
  const providerLabel = currentProvider?.name ?? agentText(agent).nativeLabel;

  const groups = useMemo(() => {
    const all = modelGroups(agent, agentMeta, providers);
    if (mode.kind === 'new') return all;
    // 会话里 Provider 已经固定：只列这一组，模型以服务端给出的为准
    const own = all.find((group) => group.providerId === (session?.providerId ?? null));
    const base = own ?? { key: 'own', providerId: session?.providerId ?? null, title: providerLabel, models: [], disabled: false };
    return [{ ...base, models: sessionModels.length > 0 ? sessionModels : base.models }];
  }, [agent, agentMeta, providers, mode.kind, session?.providerId, sessionModels, providerLabel]);

  const conversations = useMemo(() => {
    const list = store.getSessions().filter((item) => item.workspaceId === workspaceId && item.id !== sessionId);
    if (mention.query === '') return list.slice(0, 8);
    return list.filter((item) => (item.title ?? '').toLowerCase().includes(mention.query.toLowerCase())).slice(0, 8);
  }, [mention.query, sessionId, workspaceId, store.getVersion()]);

  const filteredFiles = useMemo(() => {
    if (mention.query === '') return files.slice(0, 8);
    return files.filter((file) => file.path.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 8);
  }, [files, mention.query]);

  const persist = (value: string, nextImages: string[] = images): void => {
    if (sessionId !== null) store.setDraft(sessionId, value, nextImages);
  };

  const updateText = (value: string): void => {
    setText(value);
    persist(value);
    // "/" 开头：列出该 Agent 自己的命令（F8）；Codex 的斜杠命令属于它的终端界面，不提供菜单（SL-03）
    setSlashOpen(value.startsWith('/') && !value.includes('\n') && !value.includes(' '));
    const cursor = textareaRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const at = before.lastIndexOf('@');
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1] ?? ' ')) && !/\s/.test(before.slice(at + 1))) {
      setMention({ open: true, query: before.slice(at + 1), start: at });
    } else {
      setMention({ open: false, query: '', start: 0 });
    }
  };

  const insertAtMention = (insert: string): void => {
    const cursor = textareaRef.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}${insert}${text.slice(cursor)}`;
    setText(next);
    persist(next);
    setMention({ open: false, query: '', start: 0 });
    textareaRef.current?.focus();
  };

  const submit = async (): Promise<void> => {
    const value = text;
    if (value.trim() === '' || busy) return;
    if (value.trim() === '/model') {
      setText('');
      setSlashOpen(false);
      setMenu('model');
      return;
    }
    setError(null);
    if (mode.kind === 'session') {
      if (running || sessionId === null) return;
      store.sendMessage(sessionId, value, images);
      setText('');
      setImages([]);
      store.setDraft(sessionId, '', []);
      return;
    }
    setBusy(true);
    try {
      await mode.onSubmit(value, images);
      setText('');
      setImages([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  /** 分片上传一个文件，返回 fileId（断点续传：按服务端已收到的分片续传） */
  const uploadOne = async (file: File): Promise<string> => {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const response = await fetch('/api/uploads', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: file.name, size: file.size, sha256, mime: file.type || 'application/octet-stream' }),
    });
    if (!response.ok) throw new Error(`上传失败：${response.status}`);
    const init = (await response.json()) as { uploadId: string; chunkSize: number; received: number[]; existingFileId?: string };
    if (init.existingFileId !== undefined) return init.existingFileId;
    const total = Math.ceil(buffer.byteLength / init.chunkSize);
    const sent = new Set(init.received);
    for (let index = 0; index < total; index += 1) {
      if (sent.has(index)) continue;
      const chunk = buffer.slice(index * init.chunkSize, (index + 1) * init.chunkSize);
      // 断网时重试同一个分片（A6f：服务端不会留下重复分片）
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const put = await fetch(`/api/uploads/${init.uploadId}/chunks/${index}`, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/octet-stream' },
            body: chunk,
          });
          if (put.ok) break;
        } catch {
          // 继续重试
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        const status = (await fetch(`/api/uploads/${init.uploadId}`, { credentials: 'same-origin' })
          .then((r) => r.json())
          .catch(() => ({ received: [] }))) as { received: number[] };
        if (status.received.includes(index)) break;
      }
    }
    const complete = (await fetch(`/api/uploads/${init.uploadId}/complete`, { method: 'POST', credentials: 'same-origin' }).then((r) =>
      r.json(),
    )) as { fileId: string };
    return complete.fileId;
  };

  const uploadImages = async (list: FileList | null): Promise<void> => {
    if (list === null) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        const fileId = await uploadOne(file);
        setImages((prev) => {
          const next = [...prev, fileId];
          persist(text, next);
          return next;
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploading(false);
    }
  };

  /** 其他文件：复制到 <工作区>/.webdcc/uploads/，把相对路径插进输入框（F7） */
  const attachFiles = async (list: FileList | null): Promise<void> => {
    if (list === null || workspaceId === '') return;
    setUploading(true);
    try {
      let next = text;
      for (const file of Array.from(list)) {
        if (file.size > 100 * 1024 * 1024) {
          setError(`文件超过 100 MB 上限：${file.name}`);
          continue;
        }
        const fileId = await uploadOne(file);
        const attached = (await fetch(`/api/workspaces/${workspaceId}/attach`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileId, name: file.name }),
        }).then((response) => response.json())) as { path: string };
        const cursor = textareaRef.current?.selectionStart ?? next.length;
        next = `${next.slice(0, cursor)}${attached.path} ${next.slice(cursor)}`;
      }
      setText(next);
      persist(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploading(false);
    }
  };

  const pickModel = (providerId: string | null, model: string): void => {
    setMenu(null);
    if (mode.kind === 'new') {
      mode.onChoice({ ...mode.choice, providerId, model });
    } else if (sessionId !== null && model !== '' && model !== session?.model) {
      store.setModel(sessionId, model);
    }
  };

  const pickReasoning = (effort: string): void => {
    setMenu(null);
    if (mode.kind === 'new') mode.onChoice({ ...mode.choice, reasoningEffort: effort });
    else if (sessionId !== null) {
      setSessionReasoning(effort);
      store.setReasoningEffort(sessionId, effort);
    }
  };

  const pending = sessionId === null ? [] : store.getPending(sessionId).filter((item) => item.status !== 'sent');
  // F14：非 OpenAI 模型、又没有模型目录时，Codex 会用兜底元数据，工具可能不全
  const catalogHint =
    agent === 'codex' &&
    currentProvider !== undefined &&
    currentProvider.codexCatalogPath === undefined &&
    !(currentModel === '' ? currentProvider.models : [currentModel]).some((model) => model.startsWith('gpt-'));
  const stats = sessionId === null ? null : statsFor(sessionId);
  const sendDisabled = text.trim() === '' || busy || uploading || (mode.kind === 'new' && workspaceId === '');

  return (
    <div className="composer-wrap" data-testid="composer">
      <div className="composer">
        {images.length > 0 ? (
          <div className="attachments">
            {images.map((fileId) => (
              <span key={fileId} className="attachment-chip">
                <Icon name="image" size={13} />
                图片 {fileId.slice(-6)}
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="移除图片"
                  onClick={() =>
                    setImages((prev) => {
                      const next = prev.filter((id) => id !== fileId);
                      persist(text, next);
                      return next;
                    })
                  }
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <label className="visually-hidden" htmlFor={`composer-${sessionId ?? 'new'}`}>
          消息
        </label>
        <textarea
          id={`composer-${sessionId ?? 'new'}`}
          ref={textareaRef}
          data-testid={isSession ? 'composer-input' : 'new-session-input'}
          className="composer-input"
          placeholder={`发消息给 ${agentText(agent).name}，/ 调用它的指令，@ 引用文件或会话`}
          value={text}
          rows={Math.min(10, Math.max(isSession ? 1 : 2, text.split('\n').length))}
          onChange={(event) => updateText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
            if (event.key === 'Escape') {
              setMention({ open: false, query: '', start: 0 });
              setSlashOpen(false);
            }
          }}
        />

        <div className="composer-bar" ref={barRef}>
          {/* 附件 */}
          <span className="menu-anchor">
            <button
              type="button"
              className="round-btn"
              aria-label="添加附件"
              aria-haspopup="menu"
              aria-expanded={menu === 'attach'}
              disabled={uploading}
              onClick={() => setMenu(menu === 'attach' ? null : 'attach')}
              data-testid="attach-button"
            >
              <Icon name="plus" size={16} strokeWidth={1.9} />
            </button>
            {menu === 'attach' ? (
              <div className="menu up left" role="menu">
                <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); imageInputRef.current?.click(); }}>
                  <Icon name="image" />
                  添加图片
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  disabled={workspaceId === ''}
                  onClick={() => {
                    setMenu(null);
                    attachInputRef.current?.click();
                  }}
                  data-testid="add-file"
                >
                  <Icon name="paperclip" />
                  <span className="menu-item-body">
                    添加文件
                    <span className="menu-item-sub">放进工作区的 .webdcc/uploads，并把路径插进输入框</span>
                  </span>
                </button>
              </div>
            ) : null}
          </span>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            data-testid="add-image-input"
            onChange={(event) => {
              void uploadImages(event.target.files);
              event.target.value = '';
            }}
          />
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

          {/* Agent */}
          <span className="menu-anchor">
            <button
              type="button"
              className="pill harness"
              aria-haspopup="menu"
              aria-expanded={menu === 'harness'}
              onClick={() => setMenu(menu === 'harness' ? null : 'harness')}
              data-testid="harness-pill"
              data-agent={agent}
            >
              <AgentMark agent={agent} strong />
              <span className="pill-text">{agentText(agent).name}</span>
              {isSession ? <Icon name="lock" size={12} strokeWidth={2} className="lock" label="会话创建后固定" /> : <Icon name="chevronDown" size={12} strokeWidth={2} className="caret" />}
            </button>
            {menu === 'harness' ? (
              <div className="menu up left" role="menu" style={{ width: 340 }} data-testid="harness-menu">
                {mode.kind === 'session' ? (
                  <>
                    <div className="menu-head">
                      <strong>这个会话由 {agentText(agent).name} 运行</strong>
                      <span>每个会话就是该 Agent 自己的一条原生线程，创建后不能换 Agent。要换，就开一个接续会话。</span>
                    </div>
                    <div className="menu-sep" />
                    {AGENT_IDS.filter((id) => id !== agent).map((id) => (
                      <button
                        key={id}
                        type="button"
                        role="menuitem"
                        className="menu-item"
                        disabled={!agentAvailable(id, meta)}
                        onClick={() => {
                          setMenu(null);
                          mode.onContinueIn(id);
                        }}
                        data-testid={`continue-in-${id}`}
                      >
                        <AgentMark agent={id} size="md" />
                        <span className="menu-item-body">
                          在 {agentText(id).name} 中继续…
                          <span className="menu-item-sub">
                            {agentAvailable(id, meta) ? '新建接续会话，把最后一条回答放进输入框（可改，不会自动发送）' : '这个 Agent 现在不可用'}
                          </span>
                        </span>
                      </button>
                    ))}
                  </>
                ) : (
                  AGENT_IDS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={id === agent}
                      className="menu-item"
                      disabled={!agentAvailable(id, meta)}
                      onClick={() => {
                        setMenu(null);
                        mode.onAgentChange(id);
                      }}
                    >
                      <AgentMark agent={id} size="md" />
                      <span className="menu-item-body">
                        {agentText(id).name}
                        <span className="menu-item-sub">{agentText(id).strength}</span>
                      </span>
                      {id === agent ? <Icon name="check" size={15} strokeWidth={2.2} className="check" /> : null}
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </span>

          {/* 访问模式 */}
          {accessModes.length > 0 ? (
            <span className="menu-anchor">
              <button
                type="button"
                className="pill"
                aria-haspopup="menu"
                aria-expanded={menu === 'mode'}
                onClick={() => setMenu(menu === 'mode' ? null : 'mode')}
                data-testid="access-mode"
              >
                <Icon name="shield" size={14} strokeWidth={1.9} />
                <span className="pill-text">{currentMode?.label ?? '默认访问模式'}</span>
                <Icon name="chevronDown" size={12} strokeWidth={2} className="caret" />
              </button>
              {menu === 'mode' ? (
                <div className="menu up left" role="menu" style={{ width: 300 }}>
                  <div className="menu-group-title">{agentText(agent).name} 自己的访问模式</div>
                  {accessModes.map((item) => {
                    // 以 root 运行时 Claude Code 不允许 bypassPermissions（MODE-claude-01）
                    const blocked = item.id === 'bypassPermissions' && rootBlocked;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={item.id === currentMode?.id}
                        className="menu-item"
                        disabled={blocked}
                        title={blocked ? '以 root 运行时 Claude Code 不允许此模式' : undefined}
                        data-testid={`access-mode-${item.id}`}
                        onClick={() => {
                          setMenu(null);
                          if (mode.kind === 'session') {
                            if (sessionId !== null) store.setAccessMode(sessionId, item.id);
                          } else {
                            mode.onAccessMode(item.id);
                          }
                        }}
                      >
                        <span className="menu-item-body">
                          {item.label}
                          <span className="menu-item-sub">{blocked ? '以 root 运行时 Claude Code 不允许此模式' : item.id}</span>
                        </span>
                        {item.id === currentMode?.id ? <Icon name="check" size={15} strokeWidth={2.2} className="check" /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </span>
          ) : null}

          <span className="grow" />

          {/* Provider · 模型 */}
          <span className="menu-anchor">
            <button
              type="button"
              className="pill"
              aria-haspopup="menu"
              aria-expanded={menu === 'model'}
              onClick={() => {
                setFreeModel('');
                setMenu(menu === 'model' ? null : 'model');
              }}
              data-testid="model-menu"
              data-provider={currentProvider?.name ?? ''}
              data-model={currentModel}
              title={`${providerLabel}${currentModel === '' ? '' : ` · ${currentModel}`}`}
            >
              <span className="pill-text" data-testid="model-label">
                {currentModel === '' ? '默认模型' : currentModel}
              </span>
              <span className="pill-sub pill-text">{providerLabel}</span>
              <Icon name="chevronDown" size={12} strokeWidth={2} className="caret" />
            </button>
            {menu === 'model' ? (
              <div className="menu up right" role="menu" style={{ width: 340 }}>
                {groups.map((group) => (
                  <div key={group.key} role="group" aria-label={group.title}>
                    <div className="menu-group-title">
                      {group.title}
                      {group.disabled ? <small>{group.reason}</small> : group.note === undefined ? null : <small>{group.note}</small>}
                    </div>
                    {!group.disabled && group.models.length === 0 && group.providerId !== null ? (
                      <form
                        className="menu-item"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (freeModel.trim() !== '') pickModel(group.providerId, freeModel.trim());
                        }}
                      >
                        <input
                          className="text-input"
                          style={{ height: 30 }}
                          placeholder="这个 Provider 没有模型列表，填模型名后回车"
                          value={freeModel}
                          onChange={(event) => setFreeModel(event.target.value)}
                          data-testid="model-input"
                          aria-label={`${group.title} 的模型名`}
                        />
                      </form>
                    ) : null}
                    {!group.disabled && group.models.length === 0 && group.providerId === null ? (
                      <button type="button" className="menu-item" onClick={() => pickModel(null, '')} data-testid="model-option" data-provider-name="" data-model="">
                        使用 {agentText(agent).name} 自己的默认模型
                        {currentProviderId === null && currentModel === '' ? <Icon name="check" size={15} strokeWidth={2.2} className="check" /> : null}
                      </button>
                    ) : null}
                    {group.models.map((model) => {
                      const checked = group.providerId === currentProviderId && model === currentModel;
                      return (
                        <button
                          key={`${group.key}:${model}`}
                          type="button"
                          role="menuitemradio"
                          aria-checked={checked}
                          className="menu-item"
                          disabled={group.disabled}
                          onClick={() => pickModel(group.providerId, model)}
                          data-testid="model-option"
                          data-provider-name={group.providerId === null ? '' : group.title}
                          data-model={model}
                        >
                          {model}
                          {checked ? <Icon name="check" size={15} strokeWidth={2.2} className="check" /> : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
                {isSession ? <div className="menu-note">同一 Provider 内可随时换模型；换 Provider 要开接续会话。</div> : null}
              </div>
            ) : null}
          </span>

          {agent === 'codex' ? (
            <span className="menu-anchor">
              <button type="button" className="pill" aria-haspopup="menu" aria-expanded={menu === 'reasoning'} onClick={() => setMenu(menu === 'reasoning' ? null : 'reasoning')} data-testid="reasoning-menu">
                <span className="pill-text">思考 {currentReasoning}</span><Icon name="chevronDown" size={12} strokeWidth={2} className="caret" />
              </button>
              {menu === 'reasoning' ? (
                <div className="menu up right" role="menu" style={{ width: 220 }}>
                  <div className="menu-group-title">Codex 思考强度</div>
                  {REASONING_EFFORTS.map((effort) => <button key={effort} type="button" role="menuitemradio" aria-checked={effort === currentReasoning} className="menu-item" onClick={() => pickReasoning(effort)}>{effort}{effort === currentReasoning ? <Icon name="check" size={15} strokeWidth={2.2} className="check" /> : null}</button>)}
                </div>
              ) : null}
            </span>
          ) : null}

          {running ? (
            <button type="button" className="send-btn stop-btn" onClick={() => sessionId !== null && store.interrupt(sessionId)} aria-label="停止" title="停止" data-testid="stop-button">
              <Icon name="stop" size={16} />
            </button>
          ) : (
            <button
              type="button"
              className="send-btn"
              onClick={() => void submit()}
              disabled={sendDisabled}
              aria-label="发送"
              title="发送（Enter）"
              data-testid={isSession ? 'send-button' : 'new-session-send'}
            >
              <Icon name="arrowUp" size={17} strokeWidth={2.2} />
            </button>
          )}

          {slashOpen ? (
            <div className="menu up left mention-menu" role="menu" data-testid="slash-menu">
              <div className="menu-group-title">{agentText(agent).name} 的指令</div>
              {agent === 'codex' && text === '/model' ? (
                <button type="button" className="menu-item" onClick={() => { setSlashOpen(false); setMenu('model'); }}>
                  <span className="mono" style={{ fontSize: 13 }}>/model</span>
                  <span className="menu-item-sub">打开 Provider 和模型选择</span>
                </button>
              ) : null}
              {slashCommands.length === 0 && !(agent === 'codex' && text === '/model') ? <div className="menu-note">这个 Agent 现在没有可用的斜杠命令</div> : null}
              {slashCommands
                .filter((command) => command.name.startsWith(text))
                .slice(0, 12)
                .map((command) => (
                  <button
                    key={command.name}
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setText(command.name);
                      persist(command.name);
                      setSlashOpen(false);
                      textareaRef.current?.focus();
                    }}
                  >
                    <span className="mono" style={{ fontSize: 13 }}>
                      {command.name}
                    </span>
                    {command.description === undefined ? null : <span className="menu-item-sub">{command.description}</span>}
                  </button>
                ))}
            </div>
          ) : null}

          {mention.open ? (
            <div className="menu up left mention-menu" role="menu" data-testid="at-menu">
              <div className="menu-group-title">文件</div>
              {filteredFiles.length === 0 ? <div className="menu-note">没有匹配的文件</div> : null}
              {filteredFiles.map((file) => (
                <button key={file.path} type="button" className="menu-item" onClick={() => insertAtMention(file.path)}>
                  <Icon name="fileText" />
                  <span className="menu-item-body">
                    {file.name}
                    <span className="menu-item-sub">{file.path}</span>
                  </span>
                </button>
              ))}
              <div className="menu-sep" />
              <div className="menu-group-title">
                会话
                <small>插入该会话最后一条回答的原文</small>
              </div>
              {conversations.length === 0 ? <div className="menu-note">同一工作区没有其他会话</div> : null}
              {conversations.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    const final = store
                      .getEvents(item.id)
                      .filter((event) => event.kind === 'assistant.message')
                      .at(-1);
                    insertAtMention(final === undefined ? '' : (final.data as { text: string }).text);
                  }}
                >
                  <AgentMark agent={item.agent} />
                  {item.title ?? '新会话'}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {error !== null ? (
        <div className="composer-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="composer-stats">
        {pending.length > 0 ? <span className="outbox-status">{pending.length} 条待发送</span> : null}
        {catalogHint ? (
          <span className="outbox-status" data-testid="catalog-hint">
            需要模型目录，否则工具可能不可用
          </span>
        ) : null}
        {stats !== null ? <span>{stats}</span> : <span>由 {agentText(agent).name} 运行 · 发送后生成会话地址</span>}
      </div>
    </div>
  );
}

function statsFor(sessionId: string): string {
  const events = store.getEvents(sessionId);
  // "N 轮"只统计包含 user.message 的轮次（F4）
  const turns = new Set(
    events.filter((event) => event.kind === 'user.message' && event.turnId !== null).map((event) => event.turnId as string),
  ).size;
  const steps = events.filter((event) => event.kind === 'command' || event.kind === 'tool.call' || event.kind === 'file.change' || event.kind === 'file.read').length;
  const usage = events.filter((event) => event.kind === 'usage').at(-1);
  const data = usage?.data as { inputTokens?: number; outputTokens?: number } | undefined;
  const tokens = (data?.inputTokens ?? 0) + (data?.outputTokens ?? 0);
  return `${turns} 轮 · ${steps} 步${tokens > 0 ? ` · ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : tokens} tok` : ''}`;
}
