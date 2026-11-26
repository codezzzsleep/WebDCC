import { randomUuid } from '../lib/uuid.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodexInputModeCatalog, InputContent, ModelOption, ProviderDto, SlashCommand, SlashControlRequest, NativeActionResponse } from '@webdcc/protocol';
import { parseSlashInput, slashCommandFor } from '@webdcc/protocol';
import { object as nativeObject, useClaudeTaskControls } from '../lib/claude-task-controls.js';
import { api } from '../lib/api.js';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';
import { AGENT_IDS, agentAvailable, agentText, isAccessModeSelectable, rememberAccessMode, rememberModel, rememberReasoning, modelGroups, type ModelChoice } from '../lib/agents.js';
import { useAppData } from '../lib/appData.js';
import { SessionTokenCount } from './SessionTokenCount.js';
import { AgentMark } from './AgentMark.js';
import { Icon } from './Icon.js';
import { InputPreparationStore } from '../lib/input-preparation-store.js';
import { DraftConflictError, DraftController } from '../lib/draft-controller.js';
import { UploadController, type UploadKind } from '../lib/upload-controller.js';
import { ComposerInputController, type ComposerInputCapabilities, type ComposerIntent, type PreparedPart } from '../lib/composer-input-controller.js';
import { SyncedInputDraftStore } from '../lib/synced-input-draft-store.js';
import { AttachmentPreview } from './InputAttachments.js';
import { SlashControl } from './SlashControl.js';

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
const CLAUDE_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function matchesDshRoute(id: string, provider: string, model: string): boolean {
  if (!id.startsWith('dsh:')) return id === model;
  try {
    const bytes = Uint8Array.from(atob(id.slice(4).replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
    const route: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(route) && route.length === 2 && route[0] === provider && route[1] === model;
  } catch { return false; }
}

export function Composer({ mode, workspaceId }: ComposerProps): React.ReactElement {
  useStoreVersion();
  const { meta, providers } = useAppData();
  const isSession = mode.kind === 'session';
  const sessionId = mode.kind === 'session' ? mode.sessionId : null;
  const session = sessionId === null ? undefined : store.getSession(sessionId);
  const agent = mode.kind === 'session' ? (session?.agent ?? 'dsh') : mode.agent;
  const claudeSnapshot = useClaudeTaskControls(sessionId, agent === 'claude-code');
  const perTaskStop = nativeObject(nativeObject(claudeSnapshot?.state)['controls'])['perTaskStopAffordance'];
  const stopTitle = agent !== 'claude-code' ? '强制打断' : perTaskStop === true ? '停止当前轮次；后台任务请在任务条中单独停止'
    : perTaskStop === false ? '停止当前轮次和此会话的后台任务' : '停止当前轮次；后台任务影响范围待确认';
  const agentMeta = meta?.agents[agent];
  const currentProviderId = mode.kind === 'session' ? (session?.providerId ?? null) : mode.choice.providerId;

  const [text, setText] = useState('');
  const capabilitiesRef = useRef<ComposerInputCapabilities>({ contentTypes: ['text', 'image', 'file'], intents: ['send'], running: false });
  const [controls] = useState(() => {
    const backend = new InputPreparationStore<PreparedPart>();
    const uploads = new UploadController({ store: backend, scopeSession: id => id.startsWith('new:') ? undefined : id });
    const synced = new SyncedInputDraftStore(backend, uploads, id => store.getDraft(id));
    const drafts = new DraftController(synced);
    return { backend, uploads, drafts, synced, input: new ComposerInputController(drafts, uploads, () => capabilitiesRef.current) };
  });
  const [preparationVersion, setPreparationVersion] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [mention, setMention] = useState<MentionState>({ open: false, query: '', start: 0 });
  const replyRequest = useRef(0);
  const [files, setFiles] = useState<{ name: string; path: string }[]>([]);
  const [menu, setMenu] = useState<MenuName>(null);
  const [sessionModels, setSessionModels] = useState<string[]>([]);
  const [skills, setSkills] = useState<{ skillId: string; name: string; description: string; enabled: boolean }[]>([]);
  const [skillStatus, setSkillStatus] = useState('');
  const [skillSource, setSkillSource] = useState<string>();
  const skillContext = `${agent}:${workspaceId}:${sessionId ?? 'new'}`;
  const [modelCatalog, setModelCatalog] = useState<{ agent: string; providerId: string | null; options: ModelOption[] }>();
  const catalogReady = modelCatalog?.agent === agent && modelCatalog.providerId === currentProviderId;
  const modelOptions = catalogReady ? modelCatalog.options : [];
  const [inputModes, setInputModes] = useState<CodexInputModeCatalog>({ modes: [], observedMode: null });
  const [modeCatalogRevision, setModeCatalogRevision] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [slashReason, setSlashReason] = useState('');
  const [slashCatalogRevision, setSlashCatalogRevision] = useState(0);
  const [slashRequest, setSlashRequest] = useState<SlashControlRequest>();
  const [slashResponse, setSlashResponse] = useState<NativeActionResponse>();
  const slashDraftTokens = useRef(new Map<string, NonNullable<ReturnType<typeof controls.drafts.token>>>());
  const [slashStatus, setSlashStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable' | 'error'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freeModel, setFreeModel] = useState('');
  const [sessionReasoning, setSessionReasoning] = useState<string>();
  const [dshReasoningObservation, setDshReasoningObservation] = useState<{ effort?: string; provider?: string; model?: string; confirmed: boolean }>({ confirmed: false });
  const [reasoningBusy, setReasoningBusy] = useState(false);
  const activeReasoningSession = useRef(sessionId); activeReasoningSession.current = sessionId;
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
  useEffect(() => () => { replyRequest.current++; }, [draftSessionId]);
  useEffect(() => { if (!mention.open) replyRequest.current++; }, [mention.open]);
  const pendingSlashControl = sessionId === null ? undefined : store.getSlashControlRequest(sessionId);
  useEffect(() => { setSlashRequest(pendingSlashControl?.request); setSlashResponse(pendingSlashControl?.response); }, [sessionId, pendingSlashControl?.request.commandId]);
  useEffect(() => {
    if (sessionId === null || pendingSlashControl) return;
    let active = true;
    let commandId: string | null = null;
    try { commandId = sessionStorage.getItem(`slash-action:${sessionId}`); } catch { /* Server result still persists. */ }
    if (commandId) void api.slashControlResult(sessionId, commandId).then(response => {
      if (!active) return;
      setSlashResponse(response); setSlashRequest({ commandId: response.receipt.commandId, line: '', revision: '' });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [sessionId]);
  useEffect(() => {
    let active = true;
    setInputModes({ modes: [], observedMode: null });
    if (agent !== 'codex') return;
    void api.inputModes(sessionId ?? undefined).then(result => { if (active) setInputModes(result); })
      .catch(() => { if (active) setInputModes({ modes: [], observedMode: null, reason: '暂时无法读取原生工作方式' }); });
    return () => { active = false; };
  }, [agent, sessionId, session?.status, modeCatalogRevision]);
  useEffect(() => {
    let active = true;
    setDshReasoningObservation({ confirmed: false });
    if (agent !== 'dsh' || sessionId === null) return;
    void api.nativeControls(sessionId).then(snapshot => {
      const state = snapshot.state as { selected?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } } | undefined;
      const effort = state?.selected?.reasoningEffort;
      if (active) setDshReasoningObservation({ ...(typeof effort === 'string' ? { effort } : {}), confirmed: typeof effort === 'string',
        ...(typeof state?.selected?.provider === 'string' ? { provider: state.selected.provider } : {}), ...(typeof state?.selected?.model === 'string' ? { model: state.selected.model } : {}) });
    }).catch(() => { if (active) setDshReasoningObservation({ confirmed: false }); });
    return () => { active = false; };
  }, [agent, sessionId, session?.model, session?.reasoningEffort, session?.updatedAt]);
  useEffect(() => {
    setText(''); setError(null); setMenu(null); setReasoningBusy(false); setMention({ open: false, query: '', start: 0 });
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
        controls.drafts.update(nextText, { ...current.contentParts, version: 1, parts: [{ type: 'text', text: nextText }, ...current.contentParts.parts.filter(part => part.type !== 'text'), ...selected.parts.filter(part => part.type !== 'text')] });
      }
      return true;
    });
  }, [sessionId, controls]);

  useEffect(() => {
    if (session?.agent === 'codex' || session?.agent === 'claude-code') setSessionReasoning(session.reasoningEffort ?? (session.agent === 'claude-code' ? 'medium' : undefined));
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
    setModelCatalog(undefined);
    setSessionModels([]);
    void api
      .modelOptions(agent, currentProviderId)
      .then(options => { if (active) setModelCatalog({ agent, providerId: currentProviderId, options }); })
      .catch(() => { if (active) setModelCatalog({ agent, providerId: currentProviderId, options: [] }); });
    if (session !== undefined) void api.models(session.agent, session.providerId ?? null).then(models => { if (active) setSessionModels(models); }).catch(() => { if (active) setSessionModels([]); });
    return () => { active = false; };
  }, [agent, currentProviderId, sessionId]);

  useEffect(() => {
    if (!slashOpen) return;
    let active = true;
    setSlashCommands([]); setSlashReason('');
    setSlashStatus('loading');
    const read = sessionId === null ? api.previewSlashCommands(agent, workspaceId || undefined) : api.slashCommands(sessionId);
    void read
      .then((result) => {
        if (!active) return;
        setSlashCommands(result.commands);
        setSlashStatus(result.status === 'error' ? 'error' : 'ready'); setSlashReason(result.reason ?? '');
      })
      .catch(() => {
        if (!active) return;
        setSlashCommands([]);
        setSlashStatus('error'); setSlashReason('原生指令目录请求失败，请重新读取');
      });
    return () => { active = false; };
  }, [slashOpen, sessionId, agent, workspaceId, slashCatalogRevision]);
  useEffect(() => {
    if (menu !== 'skill' || agent !== 'codex') return;
    let active = true; setSkills([]); setSkillSource(undefined); setSkillStatus('正在读取原生技能目录');
    void api.inputSkills(agent, workspaceId, sessionId ?? undefined).then(catalog => {
      if (catalog.agent !== agent || catalog.workspaceId !== workspaceId || catalog.sessionId !== (sessionId ?? undefined)) throw new Error('技能目录的会话或工作区不匹配');
      if (catalog.status === 'error' || catalog.status === 'unavailable') throw new Error(catalog.reason ?? '原生技能目录当前不可用');
      if (active) { setSkills([...new Map(catalog.skills.map(skill => [skill.skillId, skill])).values()]); setSkillSource(skillContext); setSkillStatus(catalog.skills.length === 0 ? '当前原生目录没有可用技能' : ''); }
    }).catch(cause => { if (active) setSkillStatus(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [menu, sessionId, agent, workspaceId, skillContext]);

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
  const currentMode = accessModes.find((item) => item.id === accessModeId)
    ?? (mode.kind === 'new' ? accessModes.find(item => isAccessModeSelectable(agent, item, meta?.runningAsRoot)) : accessModes[0]);
  const permissions = mode.kind === 'session' ? session?.permissions : undefined;
  const effectiveMode = accessModes.find(item => item.id === permissions?.effective || item.id.replace(/^:/, '') === permissions?.effective?.replace(/^:/, ''));
  const accessLabel = mode.kind === 'session' && session === undefined ? '正在读取权限' : permissions === undefined ? currentMode?.label ?? '沿用原生权限'
    : `${effectiveMode?.label ?? permissions.effective ?? '实际权限待确认'}${permissions.phase === 'pending' ? ' · 待生效' : permissions.phase === 'failed' ? ' · 切换失败' : permissions.phase === 'unknown' ? ' · 待确认' : ''}`;

  const providerOf = (id: string | null | undefined): ProviderDto | undefined => providers.find((provider) => provider.id === id);
  const currentModel = mode.kind === 'session' ? (session?.model ?? '') : mode.choice.model;
  const selectedModel = modelOptions.find(option => option.id === currentModel) ?? (currentModel === '' ? modelOptions.find(option => option.isDefault) : undefined);
  useEffect(() => {
    if (agent !== 'codex' || mode.kind !== 'new' || !catalogReady || mode.choice.reasoningEffort === undefined) return;
    if (selectedModel?.reasoningEfforts?.includes(mode.choice.reasoningEffort) === true) return;
    const { reasoningEffort: _effort, ...choice } = mode.choice;
    mode.onChoice(choice);
  }, [agent, mode, catalogReady, selectedModel]);
  capabilitiesRef.current = { contentTypes: agent === 'codex' ? ['text', 'image', 'audio', 'skill'] : ['text', 'image', 'file'], inputModalities: selectedModel?.inputModalities,
    collaborationModes: agent === 'codex' ? inputModes.modes.map(mode => mode.id) : [],
    intents: running ? agent === 'codex' || agent === 'dsh' ? ['queue', 'steer'] : ['queue'] : ['send'], running,
    ...(mode.kind === 'new' && workspaceId === '' ? { unavailableReason: '请先选择工作区' } : {}) };
  const attachmentParts = (controls.drafts.snapshot()?.sessionId === draftSessionId ? controls.drafts.snapshot()?.contentParts.parts ?? [] : []).filter(part => part.type !== 'text');
  const uploadTasks = controls.uploads.list(draftSessionId);
  const uploading = selecting || attachmentParts.some(part => part.uploadTaskId !== undefined && ['queued', 'uploading', 'completing'].includes(controls.uploads.get(part.uploadTaskId)?.state ?? 'queued'));
  const currentReasoning = agent === 'dsh' && mode.kind === 'session'
    ? dshReasoningObservation.confirmed ? dshReasoningObservation.effort! : session?.reasoningEffort === undefined ? '待确认' : `${session.reasoningEffort} · 待确认`
    : (agent === 'dsh' || agent === 'codex') && mode.kind === 'new' ? mode.choice.reasoningEffort ?? `沿用原生${selectedModel?.defaultReasoningEffort === undefined ? '' : `（默认 ${selectedModel.defaultReasoningEffort}）`}`
    : mode.kind === 'session' ? sessionReasoning ?? '待确认' : (mode.choice.reasoningEffort ?? 'medium');
  const dshReasoningModel = mode.kind === 'session' && dshReasoningObservation.provider !== undefined && dshReasoningObservation.model !== undefined
    ? modelOptions.find(option => matchesDshRoute(option.id, dshReasoningObservation.provider!, dshReasoningObservation.model!)) : selectedModel;
  const reasoningEfforts: readonly string[] = agent === 'dsh' ? dshReasoningModel?.reasoningEfforts ?? [] : agent === 'claude-code' ? CLAUDE_REASONING_EFFORTS : selectedModel?.reasoningEfforts ?? [];
  const reasoningNote = agent !== 'codex' ? undefined : !catalogReady ? '正在读取当前模型目录'
    : reasoningEfforts.length === 0 ? '当前模型目录不可得或未声明可调整的思考等级'
    : mode.kind === 'session' && sessionReasoning !== undefined && !reasoningEfforts.includes(sessionReasoning) ? '当前请求档位未在当前模型目录中声明，请核对原生实际值或重新选择' : undefined;
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
  useEffect(() => {
    const draft = controls.drafts.snapshot();
    if (mode.kind === 'session' && session === undefined) return;
    if (agent !== 'codex' && draft?.sessionId === draftSessionId && draft.contentParts.collaborationMode !== undefined) {
      const { collaborationMode: _mode, ...contentParts } = draft.contentParts;
      controls.drafts.update(draft.text, contentParts);
    }
  }, [agent, draftSessionId, controls, preparationVersion, mode.kind, session]);

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

  const openWebCommand = (command: SlashCommand, line: string): boolean => {
    if (agent !== 'codex' || command.route !== 'web' || parseSlashInput(line)?.rawArguments.trim() !== ''
      || !['model', 'permissions', 'plan'].includes(command.action ?? '')) return false;
    const draft = controls.drafts.snapshot();
    if (!draft) return false;
    controls.drafts.update('', { ...draft.contentParts, ...(command.action === 'plan' ? { collaborationMode: 'plan' as const } : {}), parts: draft.contentParts.parts.filter(part => part.type !== 'text') });
    setSlashOpen(false);
    if (command.action === 'model') setMenu('model');
    else if (command.action === 'permissions') setMenu('mode');
    return true;
  };

  const submit = async (intent: ComposerIntent = running ? 'queue' : 'send'): Promise<void> => {
    if (busy) return;
    if (sessionId !== null && store.isViewingConversationHistory(sessionId)) { setError('正在查看此前对话，请先返回当前对话'); return; }
    setError(null); setBusy(true);
    const expectedTurnId = intent === 'steer' ? store.getTurns(sessionId ?? '').findLast(turn => ['starting', 'running', 'waiting'].includes(turn.state) && turn.pending === undefined)?.turnId : undefined;
    try {
      const parsed = parseSlashInput(text);
      if (parsed && sessionId === null) {
        const token = controls.drafts.token();
        const catalog = await api.previewSlashCommands(agent, workspaceId || undefined);
        if (!token || !controls.drafts.accepts(token) || controls.drafts.token()?.revision !== token.revision) return;
        if (catalog.status === 'error') throw new Error(catalog.reason ?? '原生指令目录读取失败');
        const command = slashCommandFor(catalog.commands, text);
        if (!command && catalog.complete !== false) throw new Error(catalog.reason ?? '当前原生目录没有此指令，请核对名称或重新读取目录');
        if (command?.available === false) throw new Error(command.reason ?? '此原生指令在当前平台不可用');
        if (attachmentParts.length > 0 && command?.supportsAttachments === false) throw new Error('此指令未声明附件能力，附件和正文仍保留在草稿中');
        if (command && openWebCommand(command, text)) return;
      }
      if (parsed && sessionId !== null) {
        const token = controls.drafts.token();
        const commandLine = text;
        const prepared = controls.input.prepareContent() as InputContent;
        if (!token) throw new Error('草稿正在恢复');
        const catalog = await api.slashCommands(sessionId);
        if (!controls.drafts.accepts(token) || controls.drafts.token()?.revision !== token.revision) return;
        if (catalog.status === 'error') throw new Error(catalog.reason ?? '原生指令目录读取失败');
        const command = slashCommandFor(catalog.commands, text);
        if (!command) throw new Error('当前原生目录没有此指令，请核对名称或重新读取目录');
        if (command.available === false) throw new Error(command.reason ?? '此原生指令在当前平台不可用');
        if (attachmentParts.length > 0 && command.supportsAttachments === false) throw new Error('此指令未声明附件能力，附件和正文仍保留在草稿中');
        if (command.route === 'native-control') {
          await controls.drafts.flush();
          if (!controls.drafts.accepts(token)) return;
          const commandId = randomUuid(); slashDraftTokens.current.set(commandId, token);
          setSlashResponse(undefined); setSlashRequest({ commandId, line: commandLine, revision: catalog.revision, contentParts: prepared }); setSlashOpen(false); return;
        }
        if (command.route === 'native-terminal' || command.route === 'web' && parsed.rawArguments.trim() !== '') {
          store.requestNativeCommand(sessionId, text); setSlashOpen(false); return;
        }
        if (command.route === 'web') {
          setSlashOpen(false);
          if (command.action === 'model') setMenu('model');
          else if (command.action === 'permissions') setMenu('mode');
          else if (command.action === 'skills') setMenu('skill');
          else if (command.action === 'plan') {
            const draft = controls.drafts.snapshot(); if (draft) controls.drafts.update('', { ...draft.contentParts, collaborationMode: 'plan', parts: draft.contentParts.parts.filter(part => part.type !== 'text') });
          }
          return;
        }
      }
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
    controls.drafts.update(current.text, { ...current.contentParts, version: 1, parts: current.contentParts.parts.filter(candidate =>
      part.uploadTaskId !== undefined ? candidate.uploadTaskId !== part.uploadTaskId
        : part.type === 'skill' ? candidate.skillId !== part.skillId
        : part.type === 'resource' ? candidate.uri !== part.uri
        : !(candidate.type === part.type && candidate.fileId === part.fileId)) });
    if (part.uploadTaskId !== undefined) void controls.uploads.cancel(part.uploadTaskId).catch(cause => setError(String(cause)));
  };

  const pickModel = (providerId: string | null, model: string): void => {
    setMenu(null);
    rememberModel(agent, providerId, model);
    if (mode.kind === 'new') {
      const { reasoningEffort, ...choice } = mode.choice;
      const supportsPreviousEffort = agent !== 'dsh' && agent !== 'codex' || providerId === currentProviderId && modelOptions.find(option => option.id === model)?.reasoningEfforts?.includes(reasoningEffort ?? '') === true;
      mode.onChoice({ ...choice, providerId, model, ...(reasoningEffort === undefined || !supportsPreviousEffort ? {} : { reasoningEffort }) });
    } else if (sessionId !== null && model !== '' && model !== session?.model) {
      store.setModel(sessionId, model);
    }
  };

  const pickReasoning = (effort: string): void => {
    if (agent === 'codex' && !reasoningEfforts.includes(effort)) return;
    setMenu(null);
    if (agent !== 'dsh') rememberReasoning(agent, effort);
    if (mode.kind === 'new') mode.onChoice({ ...mode.choice, reasoningEffort: effort });
    else if (sessionId !== null) {
      if (agent !== 'dsh') {
        setSessionReasoning(effort);
        store.setReasoningEffort(sessionId, effort);
      } else {
        if (reasoningBusy) return;
        setReasoningBusy(true); setError(null);
        void api.command({ op: 'set-reasoning-effort', clientCommandId: randomUuid(), sessionId, reasoningEffort: effort }).then(result => {
          if (!result.ok) throw new Error(result.error ?? '原生未确认思考等级切换');
        }).catch(cause => { if (activeReasoningSession.current === sessionId) setError(cause instanceof Error ? cause.message : String(cause)); })
          .finally(() => { if (activeReasoningSession.current === sessionId) setReasoningBusy(false); });
      }
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
  const blockedReason = parseSlashInput(text) ? controls.input.commandReason() : controls.input.reason(sendIntent);
  const viewingHistory = sessionId !== null && store.isViewingConversationHistory(sessionId);
  const sendDisabled = busy || blockedReason !== undefined || viewingHistory;

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
          disabled={viewingHistory || controls.drafts.loading() || controls.drafts.snapshot()?.sessionId !== draftSessionId}
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
          <span className="menu-anchor composer-attach">
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
                {agent === 'codex' ? <button type="button" role="menuitem" className="menu-item" disabled={!workspaceId} onClick={() => setMenu('skill')}>添加原生技能</button> : null}
              </div>
            ) : null}
            {menu === 'skill' ? <div className="menu up left" role="menu" data-testid="input-skill-menu">
              {skillStatus ? <div role="status" className="menu-note">{skillStatus}</div> : null}
              {skills.map(skill => <button type="button" role="menuitem" className="menu-item" key={skill.skillId} disabled={!skill.enabled || skillSource !== skillContext} onClick={() => {
                const token = controls.drafts.token(); if (skillSource !== skillContext || controls.drafts.snapshot()?.sessionId !== draftSessionId) return;
                if (token !== undefined) controls.input.appendPart(token, { type: 'skill', skillId: skill.skillId, name: skill.name }); setMenu(null);
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
                    const blocked = !isAccessModeSelectable(agent, item, rootBlocked);
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
                          {model === '' ? '沿用本机默认模型' : model}
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

          {agent === 'codex' || agent === 'claude-code' || agent === 'dsh' ? (
            <span className="menu-anchor">
              <button type="button" className="pill" aria-haspopup="menu" aria-expanded={menu === 'reasoning'} onClick={() => setMenu(menu === 'reasoning' ? null : 'reasoning')} data-testid="reasoning-menu"
                disabled={reasoningBusy || agent === 'dsh' && reasoningEfforts.length === 0} title={agent === 'codex' ? reasoningNote ?? '档位来自当前模型目录；此处为请求值，原生实际值需核对' : agent === 'dsh' ? reasoningEfforts.length === 0 ? '此原生模型未声明可调整的思考等级' : '等级由当前 DSH Provider 和模型声明，已有会话以原生确认值显示' : '控制模型的思考强度'}>
                <span className="pill-text">思考 {currentReasoning}</span><Icon name="chevronDown" size={12} strokeWidth={2} className="caret" />
              </button>
              {menu === 'reasoning' ? (
                <div className="menu up right" role="menu" style={{ width: 220 }}>
                  <div className="menu-group-title">{agentText(agent).name} 思考强度</div>
                  {reasoningNote === undefined ? null : <div className="menu-note" data-testid="reasoning-catalog-note">{reasoningNote}</div>}
                  {agent === 'codex' && selectedModel?.source === 'provider-config' ? <div className="menu-note">档位来自此 Provider 的配置声明，实际支持以原生结果为准。</div> : null}
                  {(agent === 'dsh' || agent === 'codex') && mode.kind === 'new' ? <button type="button" role="menuitemradio" aria-checked={mode.choice.reasoningEffort === undefined} className="menu-item" onClick={() => { const { reasoningEffort: _effort, ...choice } = mode.choice; mode.onChoice(choice); setMenu(null); }}>沿用原生</button> : null}
                  {reasoningEfforts.map((effort) => <button key={effort} type="button" role="menuitemradio" aria-checked={effort === currentReasoning} className="menu-item" onClick={() => pickReasoning(effort)}>{effort}{effort === currentReasoning ? <Icon name="check" size={15} strokeWidth={2.2} className="check" /> : null}</button>)}
                </div>
              ) : null}
            </span>
          ) : null}


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
              {capabilitiesRef.current.intents.includes('steer') ? <button type="button" className="btn" onClick={() => void submit('steer')} disabled={viewingHistory || busy || controls.input.reason('steer') !== undefined} title={controls.input.reason('steer')} data-testid="steer-send-button">介入当前轮</button> : null}
              <button type="button" className="send-btn stop-btn" onClick={() => sessionId !== null && store.interrupt(sessionId)} aria-label={stopTitle} title={stopTitle} data-testid="stop-button">
                <Icon name="stop" size={16} />
                {agent === 'claude-code' ? <span>{perTaskStop === true ? '本轮' : perTaskStop === false ? '全部' : '停止'}</span> : null}
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
            <div className="menu up left mention-menu" role="menu" data-testid="slash-menu" style={{ maxHeight: 'min(60vh, 480px)', overflowY: 'auto' }}>
              <div className="menu-group-title">{agentText(agent).name} 的指令</div>
              {slashCommands.length > 0 && slashReason ? <div className="menu-note">{slashReason}</div> : null}
              {slashCommands.length === 0 ? <div className="menu-note">{slashStatus === 'loading' ? '正在读取原生命令目录…' : slashReason || '没有返回可用的原生指令'}</div> : null}
              {slashStatus === 'error' ? <button type="button" onClick={() => setSlashCatalogRevision(value => value + 1)}>重新读取指令</button> : null}
              {slashCommands
                .filter((command) => command.name.startsWith(text) || command.aliases?.some(alias => alias.startsWith(text)))
                .map((command, index) => (
                  <button
                    key={`${command.name}:${index}`}
                    type="button"
                    className="menu-item"
                    disabled={command.available === false}
                    onClick={() => {
                      const selected = command.name.startsWith(text) ? command.name : command.aliases?.find(alias => alias.startsWith(text)) ?? command.name;
                      if (sessionId === null && openWebCommand(command, selected)) return;
                      setText(selected);
                      persist(selected);
                      setSlashOpen(false);
                      textareaRef.current?.focus();
                    }}
                  >
                    <span className="mono" style={{ fontSize: 13 }}>
                      {command.name}
                    </span>
                    {command.description === undefined ? null : <span className="menu-item-sub">{command.description}</span>}
                    <span className="menu-item-sub">{command.route === 'native-terminal' ? '原生终端' : command.route === 'native-control' ? '原生 API' : command.route === 'web' ? '网页入口' : '原生指令'}{command.argumentHint ? ` · ${command.argumentHint}` : ''}{command.source ? ` · ${command.source}` : ''}{command.aliases?.length ? ` · ${command.aliases.join(', ')}` : ''}</span>
                    {sessionId === null && command.route !== 'web' ? <span className="menu-item-sub">发送时创建会话并执行</span> : null}
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
                    const draft = controls.drafts.snapshot();
                    if (draft?.sessionId !== draftSessionId) return;
                    const expected = ++replyRequest.current;
                    const cursor = textareaRef.current?.selectionStart;
                    setError(null);
                    void store.readLatestCompletedAnswer(item.id).then(answer => {
                      const current = controls.drafts.snapshot();
                      if (expected !== replyRequest.current || current?.sessionId !== draft.sessionId || current.text !== draft.text
                        || textareaRef.current?.selectionStart !== cursor) return;
                      insertAtMention(answer);
                    }).catch(cause => {
                      const current = controls.drafts.snapshot();
                      if (expected === replyRequest.current && current?.sessionId === draft.sessionId && current.text === draft.text)
                        setError(cause instanceof Error ? cause.message : String(cause));
                    });
                  }}
                >
                  <AgentMark agent={item.agent} />
                  {item.title ?? '新会话'}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="composer-settings">
          {agent === 'codex' ? <label className="pill composer-work-mode" title="默认执行和先做计划都可向你提问。这里只选择工作方式，随下一条消息发送后生效。">
            <span className="pill-text">工作方式</span>
            <select aria-label="Codex 工作方式" data-testid="codex-input-mode" value={controls.drafts.snapshot()?.contentParts.collaborationMode ?? ''}
              disabled={controls.drafts.loading() || controls.drafts.snapshot()?.sessionId !== draftSessionId}
              onChange={event => {
                const draft = controls.drafts.snapshot(); if (draft?.sessionId !== draftSessionId) return;
                const { collaborationMode: _old, ...contentParts } = draft.contentParts;
                const selected = event.target.value;
                controls.drafts.update(draft.text, { ...contentParts, ...(selected === 'default' || selected === 'plan' ? { collaborationMode: selected } : {}) });
              }}>
              <option value="">沿用原生{inputModes.observedMode === 'plan' ? '（先做计划 · 已确认）' : inputModes.observedMode === 'default' ? '（默认执行 · 已确认）' : '（待确认）'}</option>
              <option value="default" disabled={!inputModes.modes.some(mode => mode.id === 'default')}>默认执行</option>
              <option value="plan" disabled={!inputModes.modes.some(mode => mode.id === 'plan')}>先做计划</option>
            </select>
          </label> : null}
          {agent === 'codex' && inputModes.reason !== undefined ? <span className="muted" role="status">{inputModes.reason} <button type="button" onClick={() => setModeCatalogRevision(value => value + 1)}>重新读取模式</button></span> : null}
          {agent === 'codex' ? <span className="muted" data-testid="codex-work-mode-state">原生实际：{inputModes.observedMode === 'plan' ? '先做计划' : inputModes.observedMode === 'default' ? '默认执行' : '待确认'}；选择随下条消息生效</span> : null}
          <details className="muted" data-testid="composer-settings-help"><summary>设置说明</summary><p>权限决定可执行的操作；Provider 提供模型连接；模型决定处理能力；思考强度控制推理投入。{agent === 'codex' ? '默认执行和先做计划是工作方式，两种方式都可提问。沿用原生会保留原生设置，待确认表示尚未读到实际值。思考档位来自当前模型目录，此处显示请求值；原生接受的档位与发往上游模型的实际值可能不同，需以原生记录核对。' : agent === 'dsh' ? 'DSH 思考等级来自当前 Provider 和模型，已有会话确认成功后才更新显示。' : '沿用原生会保留原生设置。'}</p></details>
        </div>
      </div>
      {error !== null ? (
        <div className="composer-error" role="alert">
          {error}
        </div>
      ) : null}
      {slashRequest && sessionId !== null ? <SlashControl key={slashRequest.commandId} sessionId={sessionId} request={slashRequest}
        initialResponse={slashResponse}
        onAccepted={() => { const token = slashDraftTokens.current.get(slashRequest.commandId); slashDraftTokens.current.delete(slashRequest.commandId); if (token && controls.drafts.clearIfUnchanged(token)) void controls.drafts.flush(); }}
        onClose={() => { slashDraftTokens.current.delete(slashRequest.commandId); setSlashRequest(undefined); store.clearSlashControlRequest(sessionId); }} /> : null}
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
            void controls.drafts.replaceFromRemote((id, revision) => controls.synced.useRemote(id, revision)).catch(cause => setError(String(cause)));
          }}>使用云端草稿</button>
        </> : null}
      </div> : null}
      <div className="composer-stats">
        {sessionId !== null ? <span data-testid="draft-sync-state" data-pending={controls.synced.state(draftSessionId)?.pending === true || controls.synced.state(draftSessionId)?.syncedRevision !== controls.drafts.snapshot()?.revision}>
          {controls.synced.state(draftSessionId)?.pending === false && controls.synced.state(draftSessionId)?.syncedRevision === controls.drafts.snapshot()?.revision ? '草稿已同步' : '草稿已保存在本机，等待云端同步'}
        </span> : null}
        {blockedReason !== undefined && (text !== '' || attachmentParts.length > 0) ? <span role="status" data-testid="input-blocked-reason">{blockedReason}</span> : null}
        {blockedReason?.includes('不一致') ? <button type="button" onClick={() => {
          const current = controls.drafts.snapshot(); if (current === undefined || current.sessionId !== draftSessionId) return;
          controls.drafts.update(current.text, { ...current.contentParts, version: 1, parts: [{ type: 'text', text: current.text }, ...current.contentParts.parts.filter(part => part.type !== 'text')] });
        }}>以当前正文重新准备</button> : null}
        {pending.length > 0 ? <span className="outbox-status">{pending.length} 条待发送</span> : null}
        {catalogHint ? (
          <span className="outbox-status" data-testid="catalog-hint">
            需要模型目录，否则工具可能不可用
          </span>
        ) : null}
        {sessionId !== null && stats !== null ? <>
          <span>{stats.text}</span>
          <SessionTokenCount key={sessionId} sessionId={sessionId} usageSeq={stats.usageSeq}
            resetSeq={session?.conversation?.resetSeq ?? 0} online={store.connectionState === 'online'}
            reconnectedAt={store.lastReconnectAt} />
        </> : <span>由 {agentText(agent).name} 运行 · 发送后生成会话地址</span>}
      </div>
    </div>
  );
}

function statsFor(sessionId: string): { text: string; usageSeq: number } {
  const events = store.getConversationEvents(sessionId);
  // "N 轮"只统计包含 user.message 的轮次（F4）
  const turns = new Set(
    events.filter((event) => event.kind === 'user.message' && event.turnId !== null).map((event) => event.turnId as string),
  ).size;
  const steps = events.filter((event) => event.kind === 'command' || event.kind === 'tool.call' || event.kind === 'file.change' || event.kind === 'file.read').length;
  const usageSeq = events.findLast(event => event.kind === 'usage' || event.kind === 'turn.completed' ||
    event.kind === 'turn.started' || event.kind === 'user.message')?.seq ?? 0;
  return { text: `${turns} 轮 · ${steps} 步`, usageSeq };
}
