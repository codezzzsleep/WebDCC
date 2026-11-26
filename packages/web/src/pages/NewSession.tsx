import { randomUuid } from '../lib/uuid.js';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { DraftDto, InputContent, NativeActionResponse, SlashControlRequest, SlashControlResult } from '@webdcc/protocol';
import { parseSlashInput, slashCommandFor } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { AGENT_IDS, agentAvailable, agentStatusLine, agentText, defaultAccessMode, defaultChoice, rememberAccessMode, rememberModel, rememberReasoning, type ModelChoice } from '../lib/agents.js';
import { useAppData } from '../lib/appData.js';
import { sha256Bytes } from '../lib/input-digest.js';
import { AgentMark } from '../components/AgentMark.js';
import { Composer } from '../components/Composer.js';
import { Icon } from '../components/Icon.js';

interface SlashDraftWrite { revision: number; before: string; after: string }
interface NewSessionAttempt {
  target: string;
  input: string;
  createId: string;
  sendId: string;
  inputStarted: boolean;
  slashDraftWrite?: SlashDraftWrite;
}
const NEW_SESSION_ATTEMPT = 'wdcc:new-session-attempt';
let pendingAttempt: NewSessionAttempt | undefined;

function readPendingAttempt(): NewSessionAttempt | undefined {
  if (pendingAttempt !== undefined) return pendingAttempt;
  try {
    const stored = JSON.parse(sessionStorage.getItem(NEW_SESSION_ATTEMPT) ?? 'null') as Partial<NewSessionAttempt> | null;
    if (typeof stored?.target === 'string' && typeof stored.input === 'string' && typeof stored.createId === 'string'
      && typeof stored.sendId === 'string' && typeof stored.inputStarted === 'boolean') {
      return stored as NewSessionAttempt;
    }
  } catch { /* The active page can still retry without session storage. */ }
  return undefined;
}

function saveAttempt(attempt: NewSessionAttempt): void {
  pendingAttempt = attempt;
  try { sessionStorage.setItem(NEW_SESSION_ATTEMPT, JSON.stringify(attempt)); } catch { /* Browser storage may be unavailable. */ }
}

function firstInputAttempt(target: string, input: string): NewSessionAttempt {
  const previous = readPendingAttempt();
  if (previous?.target === target && previous.input === input) return (pendingAttempt = previous);
  // The same still-empty session can receive a corrected draft, but an input
  // that may already have been submitted always keeps its own command ID.
  const reusable = previous?.target === target && !previous.inputStarted ? previous : undefined;
  const attempt = { target, input, createId: reusable?.createId ?? randomUuid(), sendId: randomUuid(), inputStarted: false,
    slashDraftWrite: reusable?.slashDraftWrite };
  saveAttempt(attempt);
  return attempt;
}

function startInput(attempt: NewSessionAttempt): void {
  if (pendingAttempt !== attempt || attempt.inputStarted) return;
  attempt.inputStarted = true;
  saveAttempt(attempt);
}

function finishAttempt(attempt: NewSessionAttempt): void {
  if (pendingAttempt !== attempt) return;
  pendingAttempt = undefined;
  try { sessionStorage.removeItem(NEW_SESSION_ATTEMPT); } catch { /* Browser storage may be unavailable. */ }
}

function fingerprintInput(text: string, contentParts: InputContent | undefined): string {
  return sha256Bytes(new TextEncoder().encode(JSON.stringify([text, contentParts])));
}

async function stageSlashDraft(sessionId: string, attempt: NewSessionAttempt, text: string, contentParts: InputContent): Promise<DraftDto> {
  const current = await api.draft(sessionId);
  const before = fingerprintInput(current.text, current.contentParts);
  const write = attempt.slashDraftWrite;
  const sameDraft = before === attempt.input;
  // A lost response can leave either side of this attempt's last CAS write.
  // A different revision or payload belongs to another edit.
  const ownDraft = write !== undefined && (current.revision === write.revision && before === write.before
    || current.revision === write.revision + 1 && before === write.after);
  if (!sameDraft && current.revision !== 0 && !ownDraft) {
    throw new Error('已创建会话中有其他草稿，请打开该会话核对。新会话页的输入仍保留。');
  }
  if (pendingAttempt === attempt) {
    attempt.slashDraftWrite = { revision: current.revision, before, after: attempt.input };
    saveAttempt(attempt);
  }
  return sameDraft ? current : api.saveInputDraft(sessionId, text, contentParts, current.revision);
}

interface NewSessionProps {
  /** 由路由层传入（"/" 和 "/new" 共用这个组件，不能直接用 useSearch） */
  initial?: { w?: string; agent?: string };
}

const LAST_AGENT_KEY = 'wdcc:last-agent';

function lastAgent(): string | null {
  try {
    return window.localStorage.getItem(LAST_AGENT_KEY);
  } catch {
    return null;
  }
}

/** 新会话：先选由谁来做，再在同一个输入框里说要做什么 */
export function NewSession({ initial }: NewSessionProps): React.ReactElement {
  const navigate = useNavigate();
  const { meta, providers, workspaces, dsh } = useAppData();
  const [workspaceId, setWorkspaceId] = useState(initial?.w ?? '');
  const [agent, setAgent] = useState<string>(initial?.agent ?? lastAgent() ?? 'codex');
  const [choiceOverride, setChoiceOverride] = useState<Record<string, ModelChoice>>({});
  const [accessModes, setAccessModes] = useState<Record<string, string>>({});
  const [wsMenu, setWsMenu] = useState(false);

  useEffect(() => {
    if (workspaceId === '' && workspaces.length > 0) setWorkspaceId(initial?.w ?? workspaces[0]?.id ?? '');
  }, [workspaces, initial?.w, workspaceId]);

  // 选中的 Agent 不可用时，换成第一个可用的
  useEffect(() => {
    if (meta === null) return;
    if (!agentAvailable(agent, meta)) {
      const first = AGENT_IDS.find((id) => agentAvailable(id, meta));
      if (first !== undefined) setAgent(first);
    }
  }, [meta, agent]);

  const workspace = workspaces.find((item) => item.id === workspaceId);
  const choice = choiceOverride[agent] ?? defaultChoice(agent, meta?.agents[agent], providers);
  const availableAccessModes = meta?.agents[agent]?.accessModes ?? [];
  const selectedMode = defaultAccessMode(agent, availableAccessModes, accessModes[agent], meta?.runningAsRoot);

  const cards = useMemo(
    () =>
      AGENT_IDS.map((id) => ({
        id,
        available: agentAvailable(id, meta),
        status: agentStatusLine(id, meta, providers, dsh),
      })),
    [meta, providers, dsh],
  );

  const pickAgent = (id: string): void => {
    setAgent(id);
    try {
      window.localStorage.setItem(LAST_AGENT_KEY, id);
    } catch {
      // 浏览器不让存就算了
    }
  };

  const submit = async (text: string, contentParts: InputContent): Promise<{ commandId: string }> => {
    if (workspaceId === '') throw new Error('先添加一个工作区');
    const accessMode = selectedMode;
    const options = {
      workspaceId,
      agent,
      providerId: choice.providerId,
      ...(choice.model === '' ? {} : { model: choice.model }),
      ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: choice.reasoningEffort }),
      ...(accessMode === undefined ? {} : { accessMode }),
    };
    const attempt = firstInputAttempt(JSON.stringify(options), fingerprintInput(text, contentParts));
    let sessionId: string;
    try { sessionId = await store.createSession(options, attempt.createId); }
    catch (error) {
      if ((error as { creationRejected?: boolean } | null)?.creationRejected === true) finishAttempt(attempt);
      throw error;
    }
    if (sessionId === '') throw new Error('创建会话仍待确认，重试会查询同一创建命令');
    const openCreatedSession = async (): Promise<void> => {
      await navigate({ to: '/s/$sid', params: { sid: sessionId }, search: {} });
      finishAttempt(attempt);
    };
    store.setDrawer(false);
    for (const part of contentParts.parts) if (part.type === 'image' || part.type === 'file' || part.type === 'audio') await api.grantAttachment(sessionId, part.fileId);
    if (parseSlashInput(text)) {
      const openSlashResult = async (request: SlashControlRequest, response: NativeActionResponse, draft: DraftDto) => {
        const result = response.result as SlashControlResult | undefined;
        store.requestSlashControl(sessionId, request, response);
        try { sessionStorage.setItem(`slash-action:${sessionId}`, request.commandId); } catch { /* Optional browser pointer. */ }
        if (!result?.form && !result?.failed && ['completed', 'submitted'].includes(response.receipt.state)
          && fingerprintInput(draft.text, draft.contentParts) === attempt.input) {
          await api.saveInputDraft(sessionId, '', { ...contentParts, parts: [] }, draft.revision).catch(error => {
            if ((error as { status?: number } | null)?.status !== 409) throw error;
          });
        }
        await openCreatedSession();
        return { commandId: response.receipt.commandId };
      };
      if (attempt.inputStarted) {
        const response = await api.slashControlResult(sessionId, attempt.sendId).catch(error => {
          if ((error as { status?: number } | null)?.status !== 404) throw error;
          return undefined;
        });
        if (response !== undefined) {
          return openSlashResult({ commandId: attempt.sendId, line: text, revision: '', contentParts }, response, await api.draft(sessionId));
        }
      }
      const savedDraft = await stageSlashDraft(sessionId, attempt, text, contentParts);
      const catalog = await api.slashCommands(sessionId);
      if (catalog.status === 'error') throw new Error(catalog.reason ?? '原生指令目录读取失败');
      const command = slashCommandFor(catalog.commands, text);
      if (command?.route === 'native-control') {
        const request = { commandId: attempt.sendId, line: text, revision: catalog.revision, contentParts };
        startInput(attempt);
        return openSlashResult(request, await api.slashControl(sessionId, request), savedDraft);
      }
      if (!command || command.route === 'native-terminal' || command.route === 'web') {
        if (command?.route === 'native-terminal' || command?.route === 'web') store.requestNativeCommand(sessionId, text);
        await openCreatedSession();
        return { commandId: store.getSessionCreationCommand(sessionId)! };
      }
    }
    startInput(attempt);
    const receipt = await store.sendStructuredMessage(sessionId, text, contentParts, 'send', undefined, attempt.sendId);
    await openCreatedSession();
    return receipt;
  };

  return (
    <main className="main" data-testid="new-session">
      <div className="mobile-only session-header" style={{ borderBottom: 0 }}>
        <div className="session-header-row">
          <button type="button" className="icon-btn drawer-toggle" aria-label="会话列表" onClick={() => store.setDrawer(true)} data-testid="drawer-toggle">
            <Icon name="menu" size={18} />
          </button>
        </div>
      </div>
      <div className="home">
        <div className="home-inner">
          <div className="home-title">
            <h1>
              在{' '}
              <span className="menu-anchor">
                <button
                  type="button"
                  className="workspace-chip"
                  aria-haspopup="menu"
                  aria-expanded={wsMenu}
                  onClick={() => setWsMenu((value) => !value)}
                  data-testid="workspace-chip"
                >
                  {workspace?.name ?? '选择工作区'}
                  <Icon name="chevronDown" size={14} strokeWidth={2} />
                </button>
                {wsMenu ? (
                  <div className="menu down left" role="menu" style={{ width: 320, fontSize: 13, fontWeight: 400 }}>
                    {workspaces.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={item.id === workspaceId}
                        className="menu-item"
                        onClick={() => {
                          setWorkspaceId(item.id);
                          setWsMenu(false);
                        }}
                      >
                        <Icon name="folder" />
                        <span className="menu-item-body">
                          {item.name}
                          <span className="menu-item-sub">{item.path}</span>
                        </span>
                        {item.id === workspaceId ? <Icon name="check" size={15} strokeWidth={2.2} className="check" /> : null}
                      </button>
                    ))}
                    {workspaces.length === 0 ? <div className="menu-note">还没有工作区，先在左侧添加一个</div> : null}
                  </div>
                ) : null}
              </span>{' '}
              里开始
            </h1>
            <p>先选 Harness，再从它的 Provider 和模型中选择；每个 Harness 保留自己的工具、提示词和权限。</p>
          </div>

          <div className="agent-cards" role="radiogroup" aria-label="选择 Agent">
            {cards.map((card) => (
              <button
                key={card.id}
                type="button"
                role="radio"
                aria-checked={agent === card.id}
                className={`agent-card ${agent === card.id ? 'selected' : ''}`}
                disabled={!card.available}
                onClick={() => pickAgent(card.id)}
                data-testid={`agent-card-${card.id}`}
              >
                <span className="top">
                  <AgentMark agent={card.id} strong={agent === card.id} size="md" />
                  <span className="name">{agentText(card.id).name}</span>
                </span>
                <span className="status">{card.status}</span>
                <span className="strength">{card.available ? agentText(card.id).strength : ''}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="composer-area">
        <Composer
          workspaceId={workspaceId}
          mode={{
            kind: 'new',
            agent,
            onAgentChange: pickAgent,
            choice,
            onChoice: (next) => {
              if (next.model !== '') rememberModel(agent, next.providerId, next.model);
              if (agent === 'dsh' || agent === 'codex' || next.reasoningEffort !== undefined) rememberReasoning(agent, next.reasoningEffort);
              setChoiceOverride((prev) => ({ ...prev, [agent]: next }));
            },
            accessMode: selectedMode,
            onAccessMode: (modeId) => {
              rememberAccessMode(agent, modeId);
              setAccessModes((prev) => ({ ...prev, [agent]: modeId }));
            },
            onSubmit: submit,
          }}
        />
      </div>
      <div className="home-spacer" />
    </main>
  );
}
