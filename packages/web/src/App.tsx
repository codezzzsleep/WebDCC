import { useEffect, useMemo, useState } from 'react';
import { createRootRoute, createRoute, createRouter, Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import type { MetaResponse, WorkspaceDto } from '@webdcc/protocol';
import { api } from './lib/api.js';
import { useStoreVersion } from './lib/hooks.js';
import { store } from './lib/store.js';
import { Sidebar } from './components/Sidebar.js';
import { SessionHeader } from './components/SessionHeader.js';
import { Timeline } from './components/Timeline.js';
import { Trajectory } from './components/Trajectory.js';
import { Composer } from './components/Composer.js';
import { Dock, type DockState } from './components/Dock.js';
import { NewSession } from './pages/NewSession.js';

function useBootstrap(): { workspaces: WorkspaceDto[]; meta: MetaResponse | null } {
  const [workspaces, setWorkspaces] = useState<WorkspaceDto[]>([]);
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  useEffect(() => {
    void store.restoreOutbox().then(() => store.init());
    void api.workspaces().then(setWorkspaces).catch(() => undefined);
    void api.meta().then(setMeta).catch(() => undefined);
  }, []);
  return { workspaces, meta };
}

function RootLayout(): React.ReactElement {
  const navigate = useNavigate();
  const { workspaces, meta } = useBootstrap();
  const [collapsed, setCollapsed] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState('');
  const [browseEntries, setBrowseEntries] = useState<{ name: string; path: string }[]>([]);
  const [newPath, setNewPath] = useState('');

  const openAdd = async (): Promise<void> => {
    setAddOpen(true);
    const result = await api.browse(browsePath === '' ? undefined : browsePath).catch(() => undefined);
    if (result !== undefined) {
      setBrowseEntries(result.entries);
      setNewPath(result.path);
    }
  };

  return (
    <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        currentSessionId={currentSessionId()}
        dockSessionId={null}
        workspaces={workspaces}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        onAddWorkspace={() => void openAdd()}
        onSearch={() => {
          void navigate({ to: '/new', search: {} });
        }}
      />
      <Outlet />
      {addOpen ? (
        <div className="modal-backdrop" onClick={() => setAddOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>添加工作区</h2>
            <div className="muted">{newPath}</div>
            <input className="text-input" value={browsePath} placeholder="绝对路径（留空=家目录）" onChange={(event) => setBrowsePath(event.target.value)} />
            <button
              type="button"
              className="button"
              onClick={() =>
                void api.browse(browsePath === '' ? undefined : browsePath).then((result) => {
                  setBrowseEntries(result.entries);
                  setNewPath(result.path);
                })
              }
            >
              浏览
            </button>
            <ul className="browse-list">
              {browseEntries.map((entry) => (
                <li key={entry.path}>
                  <button type="button" className="link-button" onClick={() => void api.browse(entry.path).then((result) => {
                    setBrowseEntries(result.entries);
                    setNewPath(result.path);
                    setBrowsePath(entry.path);
                  })}>
                    ▸ {entry.name}
                  </button>
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button type="button" className="button ghost" onClick={() => setAddOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  void api.createWorkspace({ name: newPath.split('/').filter(Boolean).at(-1) ?? 'workspace', path: newPath }).then(() => {
                    setAddOpen(false);
                    window.location.reload();
                  });
                }}
              >
                添加这个目录
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <ConnectionBar />
      <div hidden>{meta?.version}</div>
    </div>
  );
}

function ConnectionBar(): React.ReactElement | null {
  useStoreVersion();
  if (store.connectionState === 'online') return null;
  const label = store.connectionState === 'reconnecting' ? `网络断开，正在重连（第 ${store.connectionAttempt} 次）` : '正在连接…';
  return <div className="connection-bar">{label}</div>;
}

function currentSessionId(): string | null {
  const match = /^\/s\/([^/?]+)/.exec(window.location.pathname);
  return match?.[1]?.split('+')[0] ?? null;
}

function IndexPage(): React.ReactElement {
  const navigate = useNavigate();
  const sessions = store.getSessions();
  useEffect(() => {
    const first = sessions[0];
    if (first !== undefined) void navigate({ to: '/s/$sid', params: { sid: first.id }, search: {}, replace: true });
  }, [sessions, navigate]);
  const { workspaces, meta } = useBootstrap();
  return (
    <main className="main">
      <NewSession workspaces={workspaces} meta={meta} />
    </main>
  );
}

function NewSessionPage(): React.ReactElement {
  const { workspaces, meta } = useBootstrap();
  return (
    <main className="main">
      <NewSession workspaces={workspaces} meta={meta} />
    </main>
  );
}

function SessionPage(): React.ReactElement {
  useStoreVersion();
  const { sid } = useParams({ from: '/s/$sid' });
  const search = useSearch({ from: '/s/$sid' }) as { dock?: string; path?: string };
  const navigate = useNavigate();
  const [mainId, dockSessionId] = sid.split('+');
  const session = mainId === undefined ? undefined : store.getSession(mainId);
  const [tab, setTab] = useState<'chat' | 'trajectory'>('chat');

  useEffect(() => {
    if (mainId !== undefined) void store.ensureSession(mainId);
    if (dockSessionId !== undefined) void store.ensureSession(dockSessionId);
  }, [mainId, dockSessionId]);

  const dock: DockState | null = useMemo(() => {
    if (dockSessionId !== undefined) return { kind: 'session', sessionId: dockSessionId };
    if (search.dock === undefined) return null;
    if (search.dock === 'files') return { kind: 'files', workspaceId: session?.workspaceId ?? '' };
    if (search.dock.startsWith('diff:')) {
      const fileId = search.dock.slice(5);
      return { kind: 'diff', fileId, path: search.path ?? '', sessionId: mainId ?? '' };
    }
    return null;
  }, [dockSessionId, search.dock, search.path, session?.workspaceId, mainId]);

  const openDiff = (fileId: string, path: string): void => {
    if (mainId === undefined) return;
    void navigate({ to: '/s/$sid', params: { sid: mainId }, search: { dock: `diff:${fileId}`, path } });
  };

  if (mainId === undefined) return <main className="main">会话不存在</main>;

  return (
    <>
      <main className="main" data-testid="main-column">
        <SessionHeader
          sessionId={mainId}
          tab={tab}
          onTab={setTab}
          dockOpen={dock !== null}
          onToggleDock={() => {
            void navigate({
              to: '/s/$sid',
              params: { sid: mainId },
              search: dock === null ? { dock: 'files' } : {},
            });
          }}
        />
        {tab === 'chat' ? (
          <>
            <Timeline
              sessionId={mainId}
              onOpenDiff={openDiff}
              onHandoff={(text) => store.setDraft(mainId, text)}
            />
            <Composer
              sessionId={mainId}
              workspaceId={session?.workspaceId ?? ''}
              agent={session?.agent ?? 'dsh'}
              meta={metaFor(session?.agent ?? 'dsh')}
            />
          </>
        ) : (
          <Trajectory sessionId={mainId} onJump={(seq) => {
            setTab('chat');
            window.location.hash = `e-${seq}`;
          }} />
        )}
      </main>
      {dock !== null ? (
        <Dock
          state={dock}
          onClose={() => {
            if (mainId !== undefined) void navigate({ to: '/s/$sid', params: { sid: mainId }, search: {} });
          }}
          onPromote={(sessionId) => void navigate({ to: '/s/$sid', params: { sid: sessionId }, search: {} })}
          onHandoff={(text) => store.setDraft(mainId, text)}
        />
      ) : null}
    </>
  );
}

let metaCache: MetaResponse | null = null;
function metaFor(agent: string): import('@webdcc/protocol').AgentMeta | undefined {
  if (metaCache === null) {
    void api.meta().then((meta) => {
      metaCache = meta;
    });
  }
  return metaCache?.agents[agent];
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
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/s/$sid',
  validateSearch: (search: Record<string, unknown>): { dock?: string; path?: string } => ({
    ...(typeof search['dock'] === 'string' ? { dock: search['dock'] } : {}),
    ...(typeof search['path'] === 'string' ? { path: search['path'] } : {}),
  }),
  component: SessionPage,
});

const routeTree = rootRoute.addChildren([indexRoute, newRoute, sessionRoute]);
export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
