import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { store } from '../lib/store.js';
import { AGENT_IDS, agentAvailable, agentStatusLine, agentText, defaultChoice, type ModelChoice } from '../lib/agents.js';
import { useAppData } from '../lib/appData.js';
import { AgentMark } from '../components/AgentMark.js';
import { Composer } from '../components/Composer.js';
import { Icon } from '../components/Icon.js';

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

  const submit = async (text: string, images: string[]): Promise<void> => {
    if (workspaceId === '') throw new Error('先添加一个工作区');
    const accessMode = accessModes[agent];
    const sessionId = await store.createSession({
      workspaceId,
      agent,
      providerId: choice.providerId,
      ...(choice.model === '' ? {} : { model: choice.model }),
      ...(accessMode === undefined ? {} : { accessMode }),
    });
    if (sessionId === '') throw new Error('服务端没有返回会话 id');
    store.sendMessage(sessionId, text, images);
    await navigate({ to: '/s/$sid', params: { sid: sessionId }, search: {} });
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
            onChoice: (next) => setChoiceOverride((prev) => ({ ...prev, [agent]: next })),
            accessMode: accessModes[agent],
            onAccessMode: (modeId) => setAccessModes((prev) => ({ ...prev, [agent]: modeId })),
            onSubmit: submit,
          }}
        />
      </div>
      <div className="home-spacer" />
    </main>
  );
}
