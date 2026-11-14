import { useEffect, useMemo, useRef, useState } from 'react';
import type { InputContent, ModelOption, ProviderDto } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';
import { AGENT_IDS, agentAvailable, agentText, rememberAccessMode, rememberModel, rememberReasoning, modelGroups, type ModelChoice } from '../lib/agents.js';
import { useAppData } from '../lib/appData.js';
import { shortNumber } from '../lib/format.js';
import { AgentMark } from './AgentMark.js';
import { Icon } from './Icon.js';
import { InputPreparationStore } from '../lib/input-preparation-store.js';
import { DraftConflictError, DraftController } from '../lib/draft-controller.js';
import { UploadController, type UploadKind } from '../lib/upload-controller.js';
import { ComposerInputController, type ComposerInputCapabilities, type ComposerIntent, type PreparedPart } from '../lib/composer-input-controller.js';
import { SyncedInputDraftStore } from '../lib/synced-input-draft-store.js';
import { AttachmentPreview } from './InputAttachments.js';
import { attachmentDigest } from '../lib/input-digest.js';

type ComposerMode =
  | {
      kind: 'session';
      sessionId: string;
      /** "在所选 Agent 中继续…" */
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
      onSubmit: (text: string, contentParts: InputContent) => Promise<{ commandId: string }>;
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

type MenuName = 'harness' | 'mode' | 'model' | 'reasoning' | 'attach' | 'skill' | null;
const CODEX_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const CLAUDE_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export function Composer({ mode, workspaceId }: ComposerProps): React.ReactElement {
  useStoreVersion();
  const { meta, providers } = useAppData();
  const isSession = mode.kind === 'session';
  const sessionId = mode.kind === 'session' ? mode.sessionId : null;
  const session = sessionId === null ? undefined : store.getSession(sessionId);
  const agent = mode.kind === 'session' ? (session?.agent ?? 'dsh') : mode.agent;
  const agentMeta = meta?.agents[agent];

  const [text, setText] = useState('');
  const capabilitiesRef = useRef<ComposerInputCapabilities>({ contentTypes: ['text', 'image', 'file'], intents: ['send'], running: false });
  const [controls] = useState(() => {
    const backend = new InputPreparationStore<PreparedPart>();
    const uploads = new UploadController({ store: backend, scopeSession: id => id.startsWith('new:') ? undefined : id });
    const synced = new SyncedInputDraftStore(backend, uploads, id => store.getDraft(id));
    const drafts = new DraftController(synced);
    return { backend, uploads, drafts, synced, input: new ComposerInputController(drafts, uploads, () => capabilitiesRef.current) };
  });
  const [, setPreparationVersion] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [mention, setMention] = useState<MentionState>({ open: false, query: '', start: 0 });
  const [files, setFiles] = useState<{ name: string; path: string }[]>([]);
  const [menu, setMenu] = useState<MenuName>(null);
  const [sessionModels, setSessionModels] = useState<string[]>([]);
  const [skills, setSkills] = useState<{ skillId: string; name: string; description: string; enabled: boolean }[]>([]);
  const [skillStatus, setSkillStatus] = useState('');
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashCommands, setSlashCommands] = useState<{ name: string; description?: string }[]>([]);
  const [slashStatus, setSlashStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable' | 'error'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freeModel, setFreeModel] = useState('');
  const [sessionReasoning, setSessionReasoning] = useState('medium');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // 草稿：会话里的输入框跟着会话走（换设备也在）
  useEffect(() => {
    const changed = (): void => { setText(controls.drafts.snapshot()?.text ?? ''); setPreparationVersion(value => value + 1); };
    const offDrafts = controls.drafts.subscribe(changed);
    const offUploads = controls.uploads.subscribe(task => { changed(); void controls.synced.sync(task.sessionId); });
    const offSync = controls.synced.subscribe(changed);
    return () => { offDrafts(); offUploads(); offSync(); };
  }, [controls]);
  const draftSessionId = sessionId ?? `new:${workspaceId}`;
  useEffect(() => {
    setText(''); setError(null); setMenu(null); setMention({ open: false, query: '', start: 0 });
    void controls.drafts.open(draftSessionId).catch(cause => setError(String(cause)));
    void controls.uploads.restore(draftSessionId).catch(cause => setError(String(cause)));
  }, [draftSessionId, controls]);
  useEffect(() => {
    if (sessionId === null) return;
    return store.bindDraftRecovery(sessionId, input => {
      const current = controls.drafts.snapshot();
      if (current?.sessionId !== sessionId || controls.drafts.loading() || controls.input.busy()) return false;
      const selected = input.contentParts ?? { version: 1 as const, parts: [
        ...(input.text === '' ? [] : [{ type: 'text' as const, text: input.text }]),
        ...(input.images ?? []).map(fileId => ({ type: 'image' as const, fileId })),
      ] };
      if (current.text === '' && current.contentParts.parts.length === 0) controls.drafts.update(input.text, selected);
      else {
        const nextText = current.text === '' ? input.text : `${current.text}\n${input.text}`;
        controls.drafts.update(nextText, { version: 1, parts: [{ type: 'text', text: nextText }, ...current.contentParts.parts.filter(part => part.type !== 'text'), ...selected.parts.filter(part => part.type !== 'text')] });
      }
      return true;
    });
  }, [sessionId, controls]);

  useEffect(() => {
    if (session?.agent === 'codex' || session?.agent === 'claude-code') setSessionReasoning(session.reasoningEffort ?? 'medium');
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
    let active = true;
    setModelOptions([]);
    void api
      .modelOptions(agent, mode.kind === 'session' ? session?.providerId ?? null : mode.choice.providerId)
      .then(options => { if (active) setModelOptions(options); })
      .catch(() => undefined);
    if (session !== undefined) void api.models(session.agent, session.providerId ?? null).then(models => { if (active) setSessionModels(models); }).catch(() => { if (active) setSessionModels([]); });
    return () => { active = false; };
  }, [agent, session?.providerId, mode.kind, mode.kind === 'new' ? mode.choice.providerId : null, sessionId]);

  useEffect(() => {
    if (!slashOpen) return;
    if (sessionId === null) {
      setSlashCommands([]);
      setSlashStatus('unavailable');
      return;
    }
    setSlashStatus('loading');
    void api
      .slashCommands(sessionId)
      .then((result) => {
        setSlashCommands(result.commands);
        setSlashStatus('ready');
      })
      .catch(() => {
        setSlashCommands([]);
        setSlashStatus('error');
      });
  }, [slashOpen, sessionId]);
  useEffect(() => {
    if (menu !== 'skill' || sessionId === null || agent !== 'codex') return;
    let active = true; setSkills([]); setSkillStatus('正在读取原生技能目录');
    void api.nativeControls(sessionId, true).then(async snapshot => {
      const catalog = snapshot.catalog as { skills?: { available?: boolean; value?: { data?: { skills?: { name?: string; path?: string; description?: string; enabled?: boolean }[] }[] } } } | undefined;
      if (catalog?.skills?.available !== true) throw new Error('原生技能目录当前不可用');
      const options = await Promise.all((catalog.skills.value?.data ?? []).flatMap(entry => entry.skills ?? []).flatMap(skill =>
        typeof skill.name === 'string' && typeof skill.path === 'string' ? [attachmentDigest(new Blob([JSON.stringify([skill.name, skill.path])])).then(skillId => ({ skillId, name: skill.name!, description: skill.description ?? '', enabled: skill.enabled === true }))] : []));
      if (active) { setSkills([...new Map(options.map(option => [option.skillId, option])).values()]); setSkillStatus(options.length === 0 ? '当前原生目录没有可用技能' : ''); }
    }).catch(cause => { if (active) setSkillStatus(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [menu, sessionId, agent]);

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
  const permissions = mode.kind === 'session' ? session?.permissions : undefined;
  const effectiveMode = accessModes.find(item => item.id === permissions?.effective || item.id.replace(/^:/, '') === permissions?.effective?.replace(/^:/, ''));
  const accessLabel = mode.kind === 'session' && session === undefined ? '正在读取权限' : permissions === undefined ? currentMode?.label ?? '沿用原生权限'
    : `${effectiveMode?.label ?? permissions.effective ?? '实际权限待确认'}${permissions.phase === 'pending' ? ' · 待生效' : permissions.phase === 'failed' ? ' · 切换失败' : permissions.phase === 'unknown' ? ' · 待确认' : ''}`;

  const providerOf = (id: string | null | undefined): ProviderDto | undefined => providers.find((provider) => provider.id === id);
  const currentProviderId = mode.kind === 'session' ? (session?.providerId ?? null) : mode.choice.providerId;
  const currentModel = mode.kind === 'session' ? (session?.model ?? '') : mode.choice.model;
  const selectedModel = modelOptions.find(option => option.id === currentModel) ?? (currentModel === '' ? modelOptions.find(option => option.isDefault) : undefined);
  capabilitiesRef.current = { contentTypes: agent === 'codex' ? ['text', 'image', 'audio', 'skill'] : ['text', 'image', 'file'], inputModalities: selectedModel?.inputModalities,
    intents: running ? agent === 'codex' || agent === 'dsh' ? ['queue', 'steer'] : ['queue'] : ['send'], running,
    ...(mode.kind === 'new' && workspaceId === '' ? { unavailableReason: '请先选择工作区' } : {}) };
  const attachmentParts = (controls.drafts.snapshot()?.sessionId === draftSessionId ? controls.drafts.snapshot()?.contentParts.parts ?? [] : []).filter(part => part.type !== 'text');
  const uploadTasks = controls.uploads.list(draftSessionId);
  const uploading = selecting || attachmentParts.some(part => part.uploadTaskId !== undefined && ['queued', 'uploading', 'completing'].includes(controls.uploads.get(part.uploadTaskId)?.state ?? 'queued'));
  const currentReasoning = agent === 'dsh' && mode.kind === 'session'
    ? (session?.reasoningEffort ?? '未确定')
    : mode.kind === 'session' ? sessionReasoning : (mode.choice.reasoningEffort ?? 'medium');
  const reasoningEfforts = agent === 'claude-code' ? CLAUDE_REASONING_EFFORTS : CODEX_REASONING_EFFORTS;
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

  const persist = (value: string): void => {
    if (controls.drafts.snapshot()?.sessionId !== draftSessionId || controls.drafts.loading()) return;
    controls.drafts.update(value);
  };

  const updateText = (value: string): void => {
    setText(value);
    persist(value);
    // "/" 开头：列出该 Agent 自己的命令（F8）。
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

  const submit = async (intent: ComposerIntent = running ? 'queue' : 'send'): Promise<void> => {
    if (busy) return;
    if (text.trim() === '/model' && attachmentParts.length === 0) {
      setSlashOpen(false); setMenu('model'); return;
    }
    setError(null); setBusy(true);
    const expectedTurnId = intent === 'steer' ? store.getTurns(sessionId ?? '').findLast(turn => ['starting', 'running', 'waiting'].includes(turn.state) && turn.pending === undefined)?.turnId : undefined;
    try {
      const result = await controls.input.submit(intent, async input => {
        const contentParts = input.contentParts as InputContent;
        if (mode.kind === 'new') return mode.onSubmit(input.text, contentParts);
        return store.sendStructuredMessage(input.sessionId, input.text, contentParts, input.intent, expectedTurnId);
      });
      if (!result.submitted && result.reason !== undefined) setError(result.reason);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const attach = async (list: FileList | null, kind: UploadKind): Promise<void> => {
    if (list === null) return;
    setSelecting(true); setError(null);
    try {
      for (const file of Array.from(list)) {
        const selected = await controls.input.addAttachment(file, kind);
        if (selected.attached) void controls.uploads.resume(selected.task.id).catch(cause => {
          if (controls.drafts.snapshot()?.sessionId === selected.task.sessionId) setError(cause instanceof Error ? cause.message : String(cause));
        });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSelecting(false); }
  };
  const removeAttachment = (part: PreparedPart): void => {
    const current = controls.drafts.snapshot();
    if (current?.sessionId !== draftSessionId) return;
    controls.drafts.update(current.text, { version: 1, parts: current.contentParts.parts.filter(candidate =>
      part.uploadTaskId !== undefined ? candidate.uploadTaskId !== part.uploadTaskId
        : part.type === 'skill' ? candidate.skillId !== part.skillId
        : part.type === 'resource' ? candidate.uri !== part.uri
        : !(candidate.type === part.type && candidate.fileId === part.fileId)) });
    if (part.uploadTaskId !== undefined) void controls.uploads.cancel(part.uploadTaskId).catch(cause => setError(String(cause)));
  };

  const pickModel = (providerId: string | null, model: string): void => {
    setMenu(null);
    if (model !== '') rememberModel(agent, providerId, model);
    if (mode.kind === 'new') {
      mode.onChoice({ ...mode.choice, providerId, model });
    } else if (sessionId !== null && model !== '' && model !== session?.model) {
      store.setModel(sessionId, model);
    }
  };

  const pickReasoning = (effort: string): void => {
    setMenu(null);
    rememberReasoning(agent, effort);
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
  const sendIntent: ComposerIntent = running ? 'queue' : 'send';
  const blockedReason = controls.input.reason(sendIntent);
  const sendDisabled = busy || blockedReason !== undefined;

  return (
    <div className="composer-wrap" data-testid="composer">
      <div className="composer">
        {attachmentParts.length > 0 ? <div className="attachments" data-testid="composer-attachments">
          {attachmentParts.map((part, index) => {
            const task = part.uploadTaskId === undefined ? undefined : controls.uploads.get(part.uploadTaskId);
            const uploaded = task?.fileId === undefined ? part : { ...part, fileId: task.fileId };
            return <span className="attachment-chip" key={part.uploadTaskId ?? `${part.fileId}-${index}`}>
              <AttachmentPreview part={uploaded} blob={task?.blob} />
              {task !== undefined && task.state !== 'completed' ? <span role="status">{task.state === 'failed' ? task.error ?? '上传失败' : task.state === 'paused' ? '已暂停' : task.state === 'cancelled' ? '已取消' : `正在上传 ${task.received.length} 个分片`}</span> : null}
              {task?.state === 'uploading' ? <button type="button" onClick={() => void controls.uploads.pause(task.id)}>暂停</button> : null}
              {task !== undefined && ['paused', 'failed', 'queued'].includes(task.state) ? <button type="button" onClick={() => void controls.uploads.resume(task.id).catch(cause => setError(String(cause)))}>继续上传</button> : null}
              <button type="button" className="icon-btn" aria-label="移除附件" onClick={() => removeAttachment(part)}><Icon name="x" size={12} /></button>
            </span>;
          })}
        </div> : null}
        {uploadTasks.filter(task => task.state !== 'completed' && task.state !== 'cancelled' && !attachmentParts.some(part => part.uploadTaskId === task.id)).map(task => <div key={task.id} role="status">
          原会话的附件仍已保存：{task.name}
          <button type="button" onClick={() => { const token = controls.drafts.token(); if (token !== undefined) controls.input.appendPart(token, { type: task.kind, uploadTaskId: task.id, name: task.name, mime: task.mime, sha256: task.sha256, size: task.size }); }}>恢复到草稿</button>
          <button type="button" onClick={() => void controls.uploads.cancel(task.id)}>取消上传</button>
        </div>)}

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
          disabled={controls.drafts.loading() || controls.drafts.snapshot()?.sessionId !== draftSessionId}
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
              disabled={uploading || controls.drafts.loading()}
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
                  disabled={workspaceId === '' || agent === 'codex'}
                  onClick={() => {
                    setMenu(null);
                    attachInputRef.current?.click();
                  }}
                  data-testid="add-file"
                >
                  <Icon name="paperclip" />
                  <span className="menu-item-body">
                    添加文件
                    <span className="menu-item-sub">{agent === 'codex' ? '当前 Codex 原生输入未验证独立文件引用' : '作为原生附件发送，保留文件名和原始内容'}</span>
                  </span>
                </button>
                {agent === 'codex' && selectedModel?.inputModalities?.includes('audio') ? <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); audioInputRef.current?.click(); }}>添加音频</button> : null}
                {agent === 'codex' && sessionId !== null ? <button type="button" role="menuitem" className="menu-item" onClick={() => setMenu('skill')}>添加原生技能</button> : null}
              </div>
            ) : null}
            {menu === 'skill' ? <div className="menu up left" role="menu" data-testid="input-skill-menu">
              {skillStatus ? <div role="status" className="menu-note">{skillStatus}</div> : null}
              {skills.map(skill => <button type="button" role="menuitem" className="menu-item" key={skill.skillId} disabled={!skill.enabled} onClick={() => {
                const token = controls.drafts.token(); if (token !== undefined) controls.input.appendPart(token, { type: 'skill', skillId: skill.skillId, name: skill.name }); setMenu(null);
              }}><span className="menu-item-body">{skill.name}<span className="menu-item-sub">{skill.enabled ? skill.description : '已在原生端禁用'}</span></span></button>)}
            </div> : null}
          </span>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            data-testid="add-image-input"
            onChange={(event) => {
              void attach(event.target.files, 'image');
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
              void attach(event.target.files, 'file');
              event.target.value = '';
            }}
          />
          <input ref={audioInputRef} type="file" accept="audio/*" multiple hidden data-testid="add-audio-input" onChange={event => { void attach(event.target.files, 'audio'); event.target.value = ''; }} />

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
                      <span>新建接续会话可选择当前 Agent 或其他 Agent，最后一条回答会放入新会话的输入框。</span>
                    </div>
                    <div className="menu-sep" />
                    {AGENT_IDS.map((id) => (
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
                disabled={mode.kind === 'session' && session === undefined}
              >
                <Icon name="shield" size={14} strokeWidth={1.9} />
                <span className="pill-text" title={permissions?.error ?? (permissions?.phase === 'pending' ? `请求：${currentMode?.label ?? '沿用原生权限'}` : undefined)}>{accessLabel}</span>
                <Icon name="chevronDown" size={12} strokeWidth={2} className="caret" />
              </button>
              {menu === 'mode' ? (
                <div className="menu up left" role="menu" style={{ width: 300 }}>
                  <div className="menu-group-title">{agentText(agent).name} 自己的访问模式</div>
                  {accessModes.map((item) => {
                    // 以 root 运行时 Claude Code 不允许 bypassPermissions（MODE-claude-01）
                    const blocked = item.allowed === false || item.implemented === false || item.id === 'bypassPermissions' && rootBlocked;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={item.id === currentMode?.id}
                        className="menu-item"
                        disabled={blocked}
                        title={item.reason ?? (blocked ? '以 root 运行时 Claude Code 不允许此模式' : undefined)}
                        data-testid={`access-mode-${item.id}`}
                        onClick={() => {
                          setMenu(null);
                          if (mode.kind === 'session') {
                            rememberAccessMode(agent, item.id);
                            if (sessionId !== null) store.setAccessMode(sessionId, item.id);
                          } else {
                            mode.onAccessMode(item.id);
                          }
                        }}
                      >
                        <span className="menu-item-body">
                          {item.label}
                          <span className="menu-item-sub">{item.reason ?? (blocked ? '以 root 运行时 Claude Code 不允许此模式' : item.id)}</span>
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

          {agent === 'codex' || agent === 'claude-code' ? (
            <span className="menu-anchor">
              <button type="button" className="pill" aria-haspopup="menu" aria-expanded={menu === 'reasoning'} onClick={() => setMenu(menu === 'reasoning' ? null : 'reasoning')} data-testid="reasoning-menu">
                <span className="pill-text">思考 {currentReasoning}</span><Icon name="chevronDown" size={12} strokeWidth={2} className="caret" />
              </button>
              {menu === 'reasoning' ? (
                <div className="menu up right" role="menu" style={{ width: 220 }}>
                  <div className="menu-group-title">{agentText(agent).name} 思考强度</div>
                  {reasoningEfforts.map((effort) => <button key={effort} type="button" role="menuitemradio" aria-checked={effort === currentReasoning} className="menu-item" onClick={() => pickReasoning(effort)}>{effort}{effort === currentReasoning ? <Icon name="check" size={15} strokeWidth={2.2} className="check" /> : null}</button>)}
                </div>
              ) : null}
            </span>
          ) : null}
          {agent === 'dsh' && mode.kind === 'session' ? <span className="pill" title="DSH 的实际思考等级来自原生 request/header 回报"><span className="pill-text">思考 {currentReasoning}</span></span> : null}

          {running ? (
            <>
              <button
                type="button"
                className="send-btn"
                onClick={() => void submit()}
                disabled={sendDisabled}
                aria-label="排队发送"
                title="加入队列（Enter）"
                data-testid={isSession ? 'queue-send-button' : 'new-session-send'}
              >
                <Icon name="arrowUp" size={17} strokeWidth={2.2} />
              </button>
              {capabilitiesRef.current.intents.includes('steer') ? <button type="button" className="btn" onClick={() => void submit('steer')} disabled={busy || controls.input.reason('steer') !== undefined} title={controls.input.reason('steer')} data-testid="steer-send-button">介入当前轮</button> : null}
              <button type="button" className="send-btn stop-btn" onClick={() => sessionId !== null && store.interrupt(sessionId)} aria-label="强制打断" title="强制打断" data-testid="stop-button">
                <Icon name="stop" size={16} />
              </button>
            </>
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
              {agent === 'codex' && (text === '/' || text === '/model') ? (
                <button type="button" className="menu-item" onClick={() => { setSlashOpen(false); setMenu('model'); }}>
                  <span className="mono" style={{ fontSize: 13 }}>/model</span>
                  <span className="menu-item-sub">打开 Provider 和模型选择</span>
                </button>
              ) : null}
              {slashCommands.length === 0 && !(agent === 'codex' && (text === '/' || text === '/model')) ? <div className="menu-note">{sessionId === null ? '新会话尚未建立，发送第一条消息后才能读取原生命令目录' : slashStatus === 'loading' ? '正在读取原生命令目录…' : slashStatus === 'error' ? '原生命令目录读取失败，请稍后重试' : '该 Harness 没有返回可用的斜杠命令'}</div> : null}
              {slashCommands
                .filter((command) => command.name.startsWith(text) && !(agent === 'codex' && command.name === '/model' && text === '/model'))
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
      {controls.drafts.error() !== undefined ? <div className="composer-error" role="alert">
        {controls.drafts.error()?.message}<button type="button" onClick={() => void controls.drafts.retrySave().catch(cause => setError(String(cause)))}>重试保存</button>
        {controls.drafts.error() instanceof DraftConflictError ? <>
          <button type="button" onClick={() => void controls.drafts.resolveConflict('local').catch(cause => setError(String(cause)))}>使用本页草稿</button>
          <button type="button" onClick={() => void controls.drafts.resolveConflict('stored').catch(cause => setError(String(cause)))}>使用已保存草稿</button>
        </> : null}
      </div> : null}
      {controls.synced.state(draftSessionId)?.error !== undefined ? <div className="composer-error" role="status">
        {controls.synced.state(draftSessionId)?.error}<button type="button" onClick={() => void controls.synced.sync(draftSessionId)}>重试同步</button>
        {controls.synced.state(draftSessionId)?.conflict ? <>
          <button type="button" onClick={() => void controls.synced.useLocal(draftSessionId).catch(cause => setError(String(cause)))}>使用本机草稿</button>
          <button type="button" onClick={() => {
            const token = controls.drafts.token();
            void controls.synced.readRemote(draftSessionId).then(remote => {
              if (token === undefined || !controls.drafts.accepts(token) || controls.drafts.snapshot()?.revision !== token.revision) throw new Error('本机草稿已变化，请重新核对');
              controls.drafts.update(remote.text, remote.contentParts);
            }).catch(cause => setError(String(cause)));
          }}>使用云端草稿</button>
        </> : null}
      </div> : null}
      <div className="composer-stats">
        {blockedReason !== undefined && (text !== '' || attachmentParts.length > 0) ? <span role="status" data-testid="input-blocked-reason">{blockedReason}</span> : null}
        {blockedReason?.includes('不一致') ? <button type="button" onClick={() => {
          const current = controls.drafts.snapshot(); if (current === undefined || current.sessionId !== draftSessionId) return;
          controls.drafts.update(current.text, { version: 1, parts: [{ type: 'text', text: current.text }, ...current.contentParts.parts.filter(part => part.type !== 'text')] });
        }}>以当前正文重新准备</button> : null}
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
  const usageByTurn = new Map<string, { inputTokens?: number; outputTokens?: number }>();
  for (const event of events) {
    if (event.kind !== 'usage') continue;
    usageByTurn.set(event.turnId ?? `event-${event.seq}`, event.data as { inputTokens?: number; outputTokens?: number });
  }
  const tokens = [...usageByTurn.values()].reduce((sum, data) => sum + (data.inputTokens ?? 0) + (data.outputTokens ?? 0), 0);
  return `${turns} 轮 · ${steps} 步${tokens > 0 ? ` · 累计 ${shortNumber(tokens)} tok` : ''}`;
}
