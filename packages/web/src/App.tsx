import { useEffect, useMemo, useState } from 'react';
import { createRootRoute, createRoute, createRouter, Outlet, useNavigate, useParams, useRouterState, useSearch } from '@tanstack/react-router';
import type { EventData } from '@webdcc/protocol';
import { api } from './lib/api.js';
import { useStoreVersion } from './lib/hooks.js';
import { store } from './lib/store.js';
import { agentText, defaultChoice, rememberedAccessMode } from './lib/agents.js';
import { refreshWorkspaces, useAppData } from './lib/appData.js';
import { Sidebar } from './components/Sidebar.js';
import { RelayBar, SessionHeader } from './components/SessionHeader.js';
import { Timeline } from './components/Timeline.js';
import { Trajectory } from './components/Trajectory.js';
import { Composer } from './components/Composer.js';
import { TaskPanel } from './components/TaskPanel.js';
import { Dock, type DockState } from './components/Dock.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { HandoffDialog } from './components/HandoffDialog.js';
import { Icon } from './components/Icon.js';
import { ProvidersPage } from './pages/Providers.js';
import { NewSession } from './pages/NewSession.js';
import { WatchdogPage } from './pages/Watchdog.js';
import { WatchdogBar } from './components/WatchdogBar.js';

function initialCollapsed(): boolean {
  // SPEC 9.12：768–1023px 默认收起成窄栏；手机上是抽屉
  return typeof window !== 'undefined' && window.innerWidth >= 768 && window.innerWidth < 1024;
}

function RootLayout(): React.ReactElement {
  useStoreVersion();
  const { workspaces } = useAppData();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    void store.restoreOutbox().then(() => store.init());
  }, []);

  const match = /^\/s\/([^/?]+)/.exec(pathname);
  const [currentSessionId, dockSessionId] = (match?.[1] ?? '').split('+');

  return (
    <div className={`app-shell ${store.drawerOpen ? 'drawer-open' : ''} ${pathname === '/new' ? 'new-page' : ''}`}>
      <Sidebar
        currentSessionId={currentSessionId === '' || currentSessionId === undefined ? null : currentSessionId}
        dockSessionId={dockSessionId ?? null}
        workspaces={workspaces}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        onAddWorkspace={() => setAddOpen(true)}
        onNavigate={() => store.setDrawer(false)}
        settingsActive={pathname === '/settings/providers'}
      />
      {store.drawerOpen ? <div className="drawer-backdrop" data-testid="drawer-backdrop" onClick={() => store.setDrawer(false)} /> : null}
      <Outlet />
      {addOpen ? <AddWorkspaceDialog onClose={() => setAddOpen(false)} /> : null}
      <ConnectionBar />
    </div>
  );
}

function AddWorkspaceDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const [path, setPath] = useState('');
  const [current, setCurrent] = useState('');
  const [entries, setEntries] = useState<{ name: string; path: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newDirectory, setNewDirectory] = useState(false);
  const [directoryName, setDirectoryName] = useState('');

  const browse = (target?: string): void => {
    void api
      .browse(target)
      .then((result) => {
        setEntries(result.entries);
        setCurrent(result.path);
        setPath(result.path);
        setError(null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  useEffect(() => browse(undefined), []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-ws-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="add-ws-title">添加工作区</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          选择服务器上的一个项目目录。三个 Agent 都在这个目录里工作。
        </p>
        <form
          className="row-actions"
          onSubmit={(event) => {
            event.preventDefault();
            browse(path === '' ? undefined : path);
          }}
        >
          <label className="visually-hidden" htmlFor="ws-path">
            目录路径
          </label>
          <input id="ws-path" className="text-input" style={{ flex: '1 1 260px', width: 'auto' }} value={path} placeholder="绝对路径" onChange={(event) => setPath(event.target.value)} />
          <button type="submit" className="btn">
            打开
          </button>
        </form>
        <ul className="browse-list">
          {current !== '/' && current !== '' ? (
            <li>
              <button type="button" onClick={() => browse(current.replace(/\/[^/]+\/?$/, '') || '/')}>
                <Icon name="arrowLeft" size={14} />
                上一级
              </button>
            </li>
          ) : null}
          {entries.map((entry) => (
            <li key={entry.path}>
              <button type="button" onClick={() => browse(entry.path)}>
                <Icon name="folder" size={14} />
                {entry.name}
              </button>
            </li>
          ))}
        </ul>
        {error !== null ? (
          <div className="error-card" role="alert">
            {error}
          </div>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={current === ''}
            onClick={() => {
              void api
                .createWorkspace({ name: current.split('/').filter(Boolean).at(-1) ?? 'workspace', path: current })
                .then(async () => {
                  await refreshWorkspaces();
                  onClose();
                })
                .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
            }}
          >
            添加这个目录
          </button>
          <button type="button" className="btn" onClick={() => { setNewDirectory(true); setDirectoryName(''); setError(null); }} disabled={current === ''}>
            新建文件夹
          </button>
        </div>
        {newDirectory ? (
          <form
            className="row-actions"
            onSubmit={(event) => {
              event.preventDefault();
              const name = directoryName.trim();
              if (name === '') return;
              void api.createDirectory(current, name)
                .then((created) => { setNewDirectory(false); setDirectoryName(''); return browse(created.path); })
                .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
            }}
          >
            <input className="text-input" autoFocus value={directoryName} placeholder="新文件夹名称" onChange={(event) => setDirectoryName(event.target.value)} />
            <button type="submit" className="btn primary">创建</button>
            <button type="button" className="btn" onClick={() => setNewDirectory(false)}>取消</button>
          </form>
        ) : null}
      </div>
    </div>
  );
}

function ConnectionBar(): React.ReactElement | null {
  useStoreVersion();
  const total = store.unreadTotal();
  useEffect(() => {
    document.title = total > 0 ? `(${total}) WebDCC` : 'WebDCC';
  }, [total]);
  if (store.connectionState === 'online') return null;
  const label = store.connectionState === 'reconnecting' ? `网络断开，正在重连（第 ${store.connectionAttempt} 次）` : '正在连接…';
  return (
    <div className="connection-bar" role="status">
      {label}
    </div>
  );
}

function IndexPage(): React.ReactElement {
  return <NewSession />;
}

function NewSessionPage(): React.ReactElement {
  const search = useSearch({ from: '/new' }) as { w?: string; agent?: string };
  return <NewSession initial={search} />;
}

function lastFinalText(sessionId: string): string {
  const final = [...store.getEvents(sessionId)]
    .reverse()
    .find((event) => event.kind === 'assistant.message' && (event.data as EventData['assistant.message']).phase !== 'interim');
  return final === undefined ? '' : (final.data as EventData['assistant.message']).text;
}

function SessionPage(): React.ReactElement {
  useStoreVersion();
  const { meta, providers } = useAppData();
  const { sid } = useParams({ from: '/s/$sid' });
  const search = useSearch({ from: '/s/$sid' }) as { dock?: string; path?: string };
  const navigate = useNavigate();
  const [mainId = '', dockSessionId] = sid.split('+');
  const session = store.getSession(mainId);
  const [tab, setTab] = useState<'chat' | 'trajectory'>('chat');
  const [handoffText, setHandoffText] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    store.setCurrentSession(mainId, dockSessionId);
    void store.ensureSession(mainId);
    void ensureNotificationPermission();
    if (dockSessionId !== undefined) void store.ensureSession(dockSessionId);
    return () => store.setCurrentSession(null);
  }, [mainId, dockSessionId]);

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const dock: DockState | null = useMemo(() => {
    if (dockSessionId !== undefined) return { kind: 'session', sessionId: dockSessionId };
    if (search.dock === undefined) return null;
    if (search.dock === 'files') return { kind: 'files', workspaceId: session?.workspaceId ?? '' };
    if (search.dock.startsWith('diff:')) return { kind: 'diff', fileId: search.dock.slice(5), path: search.path ?? '', sessionId: mainId };
    return null;
  }, [dockSessionId, search.dock, search.path, session?.workspaceId, mainId]);

  const openSession = (id: string, dockId?: string): void => {
    void navigate({ to: '/s/$sid', params: { sid: dockId === undefined ? id : `${id}+${dockId}` }, search: {} });
  };
  const openDiff = (fileId: string, path: string): void => {
    void navigate({ to: '/s/$sid', params: { sid: mainId }, search: { dock: `diff:${fileId}`, path } });
  };

  /** 在所选 Agent 中继续：新建接续会话，把回答原文放进它的输入框（不发送），上一棒放在右侧对照 */
  const continueIn = async (agent: string, text?: string): Promise<void> => {
    if (session === undefined) return;
    setHandoffText(null);
    try {
      const choice = defaultChoice(agent, meta?.agents[agent], providers);
      const availableModes = meta?.agents[agent]?.accessModes ?? [];
      const rememberedMode = rememberedAccessMode(agent);
      const accessMode = rememberedMode !== undefined && availableModes.some((mode) => mode.id === rememberedMode) ? rememberedMode : availableModes[0]?.id;
      const id = await store.createSession({
        workspaceId: session.workspaceId,
        agent,
        providerId: choice.providerId,
        ...(choice.model === '' ? {} : { model: choice.model }),
        ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: choice.reasoningEffort }),
        ...(accessMode === undefined ? {} : { accessMode }),
        parentId: mainId,
      });
      if (id === '') throw new Error('服务端没有返回会话 id');
      const draft = text ?? lastFinalText(mainId);
      if (draft !== '') {
        store.setDraft(id, draft);
        await store.flushDraft(id);
      }
      openSession(id, mainId);
      setToast(`已新建 ${agentText(agent).name} 会话，回答原文在输入框里，还没发送`);
    } catch (cause) {
      setToast(`没能新建会话：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  return (
    <>
      <main className="main" data-testid="main-column">
        <ErrorBoundary label="main-column">
          <SessionHeader
            sessionId={mainId}
            tab={tab}
            onTab={setTab}
            dockSessionId={dockSessionId ?? null}
            onOpenDockSession={(id) => openSession(mainId, id)}
            onOpenFiles={() => void navigate({ to: '/s/$sid', params: { sid: mainId }, search: { dock: 'files' } })}
          />
          <RelayBar sessionId={mainId} onOpen={(id) => openSession(id)} onCompare={(id) => openSession(mainId, id)} />
          {session?.agent === 'codex' ? <WatchdogBar sessionId={mainId} /> : null}
          {tab === 'chat' ? (
            <>
              <Timeline sessionId={mainId} onOpenDiff={openDiff} onHandoff={setHandoffText} />
              <div className="composer-area">
                <div className="composer-wrap" style={{ gap: 8 }}>
                  <TaskPanel sessionId={mainId} />
                </div>
                <Composer workspaceId={session?.workspaceId ?? ''} mode={{ kind: 'session', sessionId: mainId, onContinueIn: (agent) => void continueIn(agent) }} />
              </div>
            </>
          ) : (
            <Trajectory
              sessionId={mainId}
              onJump={(seq) => {
                setTab('chat');
                window.location.hash = `e-${seq}`;
              }}
            />
          )}
        </ErrorBoundary>
      </main>
      {dock !== null ? (
        <ErrorBoundary label="dock">
          <Dock
            state={dock}
            mainSessionId={mainId}
            onClose={() => openSession(mainId)}
            onPromote={(id) => openSession(id, mainId)}
            onHandoff={setHandoffText}
          />
        </ErrorBoundary>
      ) : null}
      {handoffText !== null && session !== undefined ? (
        <HandoffDialog
          text={handoffText}
          fromSessionId={mainId}
          workspaceId={session.workspaceId}
          onClose={() => setHandoffText(null)}
          onContinueIn={(agent, text) => void continueIn(agent, text)}
          onHanded={(targetSessionId, title) => {
            setHandoffText(null);
            setToast(`已放进「${title}」的输入框，还没发送`);
            openSession(mainId, targetSessionId);
          }}
        />
      ) : null}
      {toast !== null ? (
        <div className="toast" role="status" onClick={() => setToast(null)} data-testid="toast">
          {toast}
        </div>
      ) : null}
    </>
  );
}

async function ensureNotificationPermission(): Promise<void> {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission();
  } catch {
    // 忽略
  }
}

const rootRoute = createRootRoute({ component: RootLayout });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: IndexPage });
const newRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/new',
  validateSearch: (search: Record<string, unknown>): { w?: string; agent?: string } => ({
    ...(typeof search['w'] === 'string' ? { w: search['w'] } : {}),
    ...(typeof search['agent'] === 'string' ? { agent: search['agent'] } : {}),
  }),
  component: NewSessionPage,
});
const providersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/providers',
  component: ProvidersPage,
});
const watchdogRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings/watchdog', component: WatchdogPage });

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/s/$sid',
  validateSearch: (search: Record<string, unknown>): { dock?: string; path?: string } => ({
    ...(typeof search['dock'] === 'string' ? { dock: search['dock'] } : {}),
    ...(typeof search['path'] === 'string' ? { path: search['path'] } : {}),
  }),
  component: SessionPage,
});

const routeTree = rootRoute.addChildren([indexRoute, newRoute, providersRoute, watchdogRoute, sessionRoute]);
// 会话停靠区用 `main+side` 表示两个会话。`+` 是合法的路径分隔语义，
// 不能被默认的 encodeURIComponent 编成 `%2B`，否则旧链接和验收地址都会改变。
export const router = createRouter({ routeTree, pathParamsAllowedCharacters: ['+'] });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
