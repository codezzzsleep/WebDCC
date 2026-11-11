import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  BrowseResponse,
  Command,
  DraftDto,
  EventsPageResponse,
  FsListResponse,
  FsReadResponse,
  MetaResponse,
  SessionDetailResponse,
  UploadCompleteResponse,
  UploadInitResponse,
  UploadStatusResponse,
  WorkspaceDto,
} from '@webdcc/protocol';
import type { CommandDispatcher } from './dispatcher.js';
import type { ProviderRegistry } from './providers.js';
import { parseDshLink, type DshConnectionStore } from './dsh-connection.js';
import { attachToDsh, DshHostClient, isAllowedEndpoint } from '@webdcc/adapter-dsh';
import type { FileStore } from './files.js';
import type { LiveHub } from './hub.js';
import type { SessionManager } from './manager.js';
import type { Store } from './store.js';
import { updateDshHomePatch } from './dsh-settings.js';

export interface RouteDeps {
  store: Store;
  providers: ProviderRegistry;
  dsh: DshConnectionStore;
  files: FileStore;
  manager: SessionManager;
  hub: LiveHub;
  dispatcher: CommandDispatcher;
  version: string;
}

const MAX_TEXT_READ = 1024 * 1024;

interface DshSettingsView {
  writable: boolean;
  providerKey: string;
  provider: Record<string, unknown>;
  defaultModel: { provider: string; model: string; reasoningEffort?: string };
  providerRevision: number;
  defaultModelRevision: number;
}

function badRequest(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function dshClient(deps: RouteDeps): DshHostClient {
  const connection = deps.dsh.connection;
  if (connection === null) throw Object.assign(new Error('DSH 尚未连接'), { statusCode: 503 });
  const client = new DshHostClient(connection.url);
  client.useCookie(connection.cookie);
  return client;
}

function dshEndpoint(endpoint: string): void {
  if (!isAllowedEndpoint(endpoint)) throw new Error(`DSH 端点不在白名单内：${endpoint}`);
}

/** 解析符号链接后必须仍在工作区内（SPEC 11.1） */
export async function resolveInsideWorkspace(workspacePath: string, requested: string): Promise<string> {
  const root = await realpath(workspacePath);
  const target = await realpath(resolve(root, requested.replace(/^\/+/, '')));
  const rel = relative(root, target);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) throw badRequest('路径必须在工作区内');
  return target;
}

/** 解析尚不存在的目标，先解析父目录，避免新建文件时 realpath 失败。 */
async function resolveNewInsideWorkspace(workspacePath: string, requested: string): Promise<string> {
  const root = await realpath(workspacePath);
  const normalized = requested.replace(/^\/+/, '');
  if (normalized === '' || isAbsolute(requested)) throw badRequest('需要工作区内的相对路径');
  const target = resolve(root, normalized);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw badRequest('路径必须在工作区内');
  const parent = await realpath(dirname(target)).catch(() => undefined);
  if (parent === undefined) throw badRequest('父目录不存在');
  const parentRel = relative(root, parent);
  if (parentRel !== '' && (parentRel.startsWith('..') || isAbsolute(parentRel))) throw badRequest('路径必须在工作区内');
  return join(parent, basename(target));
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, files, manager, dispatcher } = deps;

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.get('/api/meta', async (): Promise<MetaResponse> => {
    const agents: MetaResponse['agents'] = {};
    for (const adapter of manager.adaptersList()) {
      const probe = await adapter.probe().catch(() => ({
        installed: false,
        pinnedVersion: 'unknown',
        auth: 'unknown' as const,
        notes: ['probe 失败'],
      }));
      agents[adapter.id] = {
        ...probe,
        adapterKind: adapter.kind ?? 'real',
        accessModes: adapter.listAccessModes === undefined ? adapter.accessModes() : await adapter.listAccessModes().catch(() => adapter.accessModes()),
        models: await adapter.listModels(null).catch(() => []),
      };
    }
    return { version: deps.version, agents, runningAsRoot: typeof process.getuid === 'function' ? process.getuid() === 0 : false };
  });

  // ---------- workspaces ----------
  app.get('/api/workspaces', async (): Promise<WorkspaceDto[]> => store.listWorkspaces());

  app.post('/api/workspaces', async (request) => {
    const body = request.body as { name?: string; path?: string };
    if (typeof body?.path !== 'string' || body.path.trim() === '') throw badRequest('path 必须是已存在目录的绝对路径');
    if (!isAbsolute(body.path)) throw badRequest('path 必须是绝对路径');
    const info = await stat(body.path).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) throw badRequest('path 必须是已存在目录');
    const canonical = await realpath(body.path);
    const existing = store.findWorkspaceByPath(canonical);
    if (existing !== undefined) return existing;
    const name = body.name?.trim() !== undefined && body.name.trim() !== '' ? body.name.trim() : basename(canonical);
    return store.createWorkspace(name, canonical);
  });

  app.get('/api/fs/browse', async (request): Promise<BrowseResponse> => {
    const query = request.query as { path?: string };
    const home = homedir();
    const target = query.path === undefined || query.path === '' ? home : query.path;
    if (!isAbsolute(target)) throw badRequest('path 必须是绝对路径');
    const canonical = await realpath(target).catch(() => undefined);
    if (canonical === undefined) throw badRequest('目录不存在');
    const entries = await readdir(canonical, { withFileTypes: true }).catch(() => []);
    const crumbs: { name: string; path: string }[] = [];
    let cursor = canonical;
    for (;;) {
      crumbs.unshift({ name: cursor === sep ? '/' : basename(cursor), path: cursor });
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return {
      path: canonical,
      home,
      crumbs,
      entries: entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: join(canonical, entry.name),
          hidden: entry.name.startsWith('.'),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

  app.post('/api/fs/mkdir', async (request) => {
    const body = request.body as { parent?: string; name?: string };
    if (typeof body?.parent !== 'string' || !isAbsolute(body.parent)) throw badRequest('parent 必须是绝对路径');
    if (typeof body?.name !== 'string' || body.name.trim() === '' || body.name.includes('/') || body.name.includes('\\')) throw badRequest('目录名不合法');
    const parent = await realpath(body.parent).catch(() => undefined);
    if (parent === undefined) throw badRequest('父目录不存在');
    const target = join(parent, body.name.trim());
    await mkdir(target).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw badRequest('目录已存在');
      throw error;
    });
    return { path: target };
  });

  app.get('/api/workspaces/:id/fs', async (request): Promise<FsListResponse | FsReadResponse> => {
    const { id } = request.params as { id: string };
    const query = request.query as { path?: string; q?: string };
    const workspace = store.getWorkspace(id);
    if (workspace === undefined) throw Object.assign(new Error('工作区不存在'), { statusCode: 404 });
    const relativePath = query.path ?? '';
    const target = await resolveInsideWorkspace(workspace.path, relativePath).catch(() => undefined);
    if (target === undefined) throw badRequest('路径必须在工作区内');
    const info = await stat(target).catch(() => undefined);
    if (info === undefined) throw Object.assign(new Error('路径不存在'), { statusCode: 404 });

    if (info.isDirectory()) {
      const query2 = query.q?.toLowerCase();
      const entries = await readdir(target, { withFileTypes: true });
      return {
        path: relative(workspace.path, target) || '.',
        entries: entries
          .filter((entry) => (query2 === undefined ? true : entry.name.toLowerCase().includes(query2)))
          .map((entry) => ({
            name: entry.name,
            path: relative(workspace.path, join(target, entry.name)),
            type: entry.isDirectory() ? ('dir' as const) : ('file' as const),
          }))
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)),
      };
    }

    const buffer = await readFile(target);
    return {
      path: relative(workspace.path, target),
      content: buffer.subarray(0, MAX_TEXT_READ).toString('utf8'),
      truncated: buffer.byteLength > MAX_TEXT_READ,
    };
  });

  app.post('/api/workspaces/:id/fs', async (request) => {
    const { id } = request.params as { id: string };
    const workspace = store.getWorkspace(id);
    if (workspace === undefined) throw Object.assign(new Error('工作区不存在'), { statusCode: 404 });
    const body = request.body as { path?: string; kind?: string; content?: string };
    if (typeof body?.path !== 'string' || body.path.trim() === '') throw badRequest('需要文件路径');
    if (body.kind !== 'file' && body.kind !== 'dir') throw badRequest('kind 必须是 file 或 dir');
    const target = await resolveNewInsideWorkspace(workspace.path, body.path.trim());
    if (body.kind === 'dir') {
      await mkdir(target).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw badRequest('目录已存在');
        throw error;
      });
    } else {
      await writeFile(target, body.content ?? '', { encoding: 'utf8', flag: 'wx' }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw badRequest('文件已存在');
        throw error;
      });
    }
    return { path: relative(workspace.path, target), kind: body.kind };
  });

  app.get('/api/workspaces/:id/raw', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { path?: string };
    const workspace = store.getWorkspace(id);
    if (workspace === undefined) throw Object.assign(new Error('工作区不存在'), { statusCode: 404 });
    const target = await resolveInsideWorkspace(workspace.path, query.path ?? '').catch(() => undefined);
    if (target === undefined) throw badRequest('路径必须在工作区内');
    return reply.send(createReadStream(target));
  });

  // ---------- feed / sessions ----------
  app.get('/api/feed', async (request) => {
    const query = request.query as { after?: string };
    const after = Number(query.after ?? '0');
    return { entries: store.feedSince(Number.isFinite(after) ? after : 0, 1000) };
  });

  app.get('/api/sessions/:id', async (request): Promise<SessionDetailResponse> => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (session === undefined) throw Object.assign(new Error('会话不存在'), { statusCode: 404 });
    return {
      ...session,
      snapshot: manager.hotItems(id).map((item) => ({
        itemKey: item.itemKey,
        kind: item.kind,
        data: item.data,
        turnId: item.turnId,
      })),
    };
  });

  app.get('/api/sessions/:id/events', async (request): Promise<EventsPageResponse> => {
    const { id } = request.params as { id: string };
    const query = request.query as { before?: string; after?: string; limit?: string };
    if (store.getSession(id) === undefined) throw Object.assign(new Error('会话不存在'), { statusCode: 404 });
    const limit = Math.min(Number(query.limit ?? '200') || 200, 500);
    const events = store.listEvents(id, {
      ...(query.before === undefined ? {} : { before: Number(query.before) }),
      ...(query.after === undefined ? {} : { after: Number(query.after) }),
      limit,
    });
    const first = events[0];
    return { events, hasMore: first !== undefined && first.seq > 1 };
  });

  app.get('/api/sessions/:id/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (store.getSession(id) === undefined) throw Object.assign(new Error('会话不存在'), { statusCode: 404 });
    const events = store.allEvents(id);
    reply.header('content-type', 'application/x-ndjson; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${id}.jsonl"`);
    return events.map((event) => JSON.stringify(event)).join('\n');
  });

  app.get('/api/sessions/:id/slash-commands', async (request) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (session === undefined) throw Object.assign(new Error('会话不存在'), { statusCode: 404 });
    const adapter = manager.adaptersList().find((item) => item.id === session.agent);
    if (adapter?.slashCommands === undefined) return { commands: [] };
    return { commands: await adapter.slashCommands(id).catch(() => []) };
  });

  app.get('/api/sessions/:id/draft', async (request): Promise<DraftDto> => {
    const { id } = request.params as { id: string };
    if (store.getSession(id) === undefined) throw Object.assign(new Error('会话不存在'), { statusCode: 404 });
    return store.getDraft(id);
  });

  app.put('/api/sessions/:id/draft', async (request): Promise<DraftDto> => {
    const { id } = request.params as { id: string };
    if (store.getSession(id) === undefined) throw Object.assign(new Error('会话不存在'), { statusCode: 404 });
    const body = request.body as { text?: string; fileIds?: string[] };
    return store.setDraft(id, body?.text ?? '', Array.isArray(body?.fileIds) ? body.fileIds : []);
  });

  app.post('/api/commands', async (request) => {
    const body = request.body as { command?: Command; op?: string } & Partial<Command>;
    const command = (body?.command ?? (body as unknown as Command)) as Command;
    if (typeof command?.clientCommandId !== 'string' || typeof command?.op !== 'string') throw badRequest('命令缺少 clientCommandId 或 op');
    return dispatcher.dispatch(command);
  });

  // ---------- 测试钩子（只在 WDCC_TEST_HOOKS=1 时存在，SPEC-M8 6.4） ----------
  if (process.env['WDCC_TEST_HOOKS'] === '1') {
    app.post('/api/__test/inject-event', async (request) => {
      const body = request.body as { sessionId?: string; events?: { turnId?: string; itemKey?: string; kind?: string; data?: unknown; native?: unknown; nativeSeq?: number }[] };
      if (typeof body?.sessionId !== 'string' || !Array.isArray(body.events)) throw badRequest('需要 sessionId 与 events');
      if (body.events.length > 1000) throw badRequest('一次最多 1000 条');
      const stored = [];
      for (const event of body.events) {
        stored.push(
          store.appendEvent({
            sessionId: body.sessionId,
            turnId: event.turnId ?? 'injected',
            itemKey: event.itemKey ?? `injected-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            kind: (event.kind ?? 'unknown') as never,
            data: (event.data ?? { nativeType: 'injected' }) as never,
            ...(event.native === undefined ? {} : { native: event.native }),
            ...(event.nativeSeq === undefined ? {} : { nativeSeq: event.nativeSeq }),
          }),
        );
      }
      for (const event of stored) deps.hub.broadcastEvent(event);
      return { ok: true, count: stored.length };
    });

    app.post('/api/__test/dispose', async (request) => {
      const body = request.body as { sessionId?: string };
      if (typeof body?.sessionId !== 'string') throw badRequest('需要 sessionId');
      await manager.dispose(body.sessionId);
      return { ok: true };
    });

    app.get('/api/__test/processes', async () => {
      const processes = manager.adaptersList().flatMap((adapter) =>
        (adapter.debugProcesses?.() ?? []).map((info) => ({ ...info, agent: adapter.id })),
      );
      return {
        server: {
          pid: process.pid,
          port: Number(process.env['WDCC_PORT'] ?? 0),
          dirs: {
            HOME: process.env['HOME'] ?? '',
            CODEX_HOME: process.env['CODEX_HOME'] ?? '',
            CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'] ?? '',
            DSH_HOME: process.env['DSH_HOME'] ?? '',
            WDCC_DATA_DIR: process.env['WDCC_DATA_DIR'] ?? '',
          },
        },
        processes,
      };
    });
  }

  // ---------- DSH 连接（attach 模式） ----------
  app.get('/api/dsh', async () => {
    const connection = deps.dsh.connection;
    let version: string | undefined;
    for (const adapter of manager.adaptersList()) {
      if (adapter.id === 'dsh') {
        const probe = await adapter.probe().catch(() => undefined);
        version = probe?.version;
      }
    }
    return {
      mode: connection !== null || process.env['WDCC_DSH_MODE'] === 'attach' ? 'attach' : 'spawn',
      url: connection?.url ?? process.env['WDCC_DSH_URL'] ?? null,
      connected: connection !== null,
      ...(connection?.connectedAt === undefined ? {} : { connectedAt: connection.connectedAt }),
      ...(version === undefined ? {} : { version }),
    };
  });

  app.post('/api/dsh/connect', async (request) => {
    const body = request.body as { link?: string };
    if (typeof body?.link !== 'string') throw badRequest('需要 link（DSH 的访问链接）');
    const { url, token } = parseDshLink(body.link);
    const cookie = await attachToDsh(url, token);
    await deps.dsh.save({ url, cookie, connectedAt: new Date().toISOString() });
    for (const adapter of manager.adaptersList()) {
      if (adapter.id === 'dsh') {
        const dshAdapter = adapter as unknown as { setAttach?: (u: string, c: string) => Promise<void> };
        await dshAdapter.setAttach?.(url, cookie);
      }
    }
    return { ok: true, url };
  });

  app.delete('/api/dsh', async () => {
    await deps.dsh.clear();
    return { ok: true };
  });

  // ---------- DSH Provider（通过 DSH 原生 settings API） ----------
  app.get('/api/dsh/provider', async (): Promise<DshSettingsView> => {
    const client = dshClient(deps);
    dshEndpoint('settings/describe');
    const described = (await client.rpc<{ writable?: boolean; namespaces?: Record<string, unknown>[] }>('settings/describe', {}));
    const namespaces = described.namespaces ?? [];
    const llm = namespaces.find((item) => item['ns'] === 'llm-pi-ai') as Record<string, unknown> | undefined;
    const defaults = namespaces.find((item) => item['ns'] === 'agent-default-model') as Record<string, unknown> | undefined;
    const llmValue = (llm?.['value'] ?? {}) as { providers?: Record<string, Record<string, unknown>> };
    const defaultValue = (defaults?.['value'] ?? {}) as { provider?: string; model?: string; reasoningEffort?: string };
    const providerKey = String(defaultValue.provider ?? Object.keys(llmValue.providers ?? {})[0] ?? '');
    const provider = llmValue.providers?.[providerKey] ?? {};
    return {
      writable: described.writable === true,
      providerKey,
      provider,
      defaultModel: {
        provider: providerKey,
        model: String(defaultValue.model ?? ''),
        ...(defaultValue.reasoningEffort === undefined ? {} : { reasoningEffort: String(defaultValue.reasoningEffort) }),
      },
      providerRevision: Number(llm?.['revision'] ?? 0),
      defaultModelRevision: Number(defaults?.['revision'] ?? 0),
    };
  });

  app.patch('/api/dsh/provider', async (request): Promise<DshSettingsView> => {
    const body = request.body as {
      providerKey?: string;
      baseURL?: string;
      model?: string;
      reasoning?: string;
      apiKey?: string;
      apiKeyEnv?: string;
    };
    if (typeof body?.providerKey !== 'string' || body.providerKey.trim() === '') throw badRequest('需要 providerKey');
    if (typeof body?.baseURL !== 'string' || body.baseURL.trim() === '') throw badRequest('需要 baseURL');
    if (typeof body?.model !== 'string' || body.model.trim() === '') throw badRequest('需要 model');

    const client = dshClient(deps);
    dshEndpoint('settings/describe');
    const described = (await client.rpc<{ writable?: boolean; namespaces?: Record<string, unknown>[] }>('settings/describe', {}));
    if (described.writable !== true) throw Object.assign(new Error('DSH 当前配置不可写'), { statusCode: 409 });
    const namespaces = described.namespaces ?? [];
    const llm = namespaces.find((item) => item['ns'] === 'llm-pi-ai') as Record<string, unknown> | undefined;
    const defaults = namespaces.find((item) => item['ns'] === 'agent-default-model') as Record<string, unknown> | undefined;
    const llmValue = (llm?.['value'] ?? {}) as { providers?: Record<string, Record<string, unknown>> };
    const currentProvider: Record<string, unknown> = { ...(llmValue.providers?.[body.providerKey] ?? {}) };
    const currentModels = Array.isArray(currentProvider['models']) ? (currentProvider['models'] as Record<string, unknown>[]) : [];
    const nextModel = {
      ...(currentModels.find((item) => item['id'] === body.model) ?? {}),
      id: body.model,
      name: body.model,
    };
    const nextProvider: Record<string, unknown> = {
      ...currentProvider,
      displayName: currentProvider['displayName'] ?? body.providerKey,
      api: currentProvider['api'] ?? 'openai-completions',
      apiKeyEnv: currentProvider['apiKeyEnv'] ?? 'OPENAI_API_KEY',
      baseURL: body.baseURL,
      models: [nextModel],
      ...(body.reasoning === undefined || body.reasoning === '' ? {} : { reasoning: body.reasoning }),
    };
    const providers = { ...(llmValue.providers ?? {}), [body.providerKey]: nextProvider };

    let usedHomePatch = false;
    try {
      dshEndpoint('settings/update');
      await client.rpc('settings/update', {
        ns: 'llm-pi-ai',
        patch: { providers },
        expectedRevision: Number(llm?.['revision'] ?? 0),
      });
      dshEndpoint('settings/update');
      await client.rpc('settings/update', {
        ns: 'agent-default-model',
        patch: {
          provider: body.providerKey,
          model: body.model,
          ...(body.reasoning === undefined || body.reasoning === '' ? {} : { reasoningEffort: body.reasoning }),
        },
        expectedRevision: Number(defaults?.['revision'] ?? 0),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/overridden by a home patch/i.test(message)) throw error;
      await updateDshHomePatch({ providerKey: body.providerKey, baseURL: body.baseURL, model: body.model, reasoning: body.reasoning, apiKeyEnv: String(nextProvider['apiKeyEnv'] ?? 'OPENAI_API_KEY') });
      usedHomePatch = true;
    }
    if (body.apiKey !== undefined && body.apiKey !== '') {
      dshEndpoint('credentials/set');
      const apiKeyEnv = String(nextProvider['apiKeyEnv'] ?? '');
      if (apiKeyEnv !== '') await client.rpc('credentials/set', { ref: apiKeyEnv, value: body.apiKey });
    }

    // Return the redacted, live view after the write.
    dshEndpoint('settings/describe');
    const refreshed = (await client.rpc<{ writable?: boolean; namespaces?: Record<string, unknown>[] }>('settings/describe', {}));
    const ns = refreshed.namespaces ?? [];
    const currentLlm = ns.find((item) => item['ns'] === 'llm-pi-ai') as Record<string, unknown> | undefined;
    const currentDefaults = ns.find((item) => item['ns'] === 'agent-default-model') as Record<string, unknown> | undefined;
    const currentValue = (currentLlm?.['value'] ?? {}) as { providers?: Record<string, Record<string, unknown>> };
    const currentDefaultValue = (currentDefaults?.['value'] ?? {}) as { provider?: string; model?: string; reasoningEffort?: string };
    return {
      writable: refreshed.writable === true,
      providerKey: String(currentDefaultValue.provider ?? body.providerKey),
      provider: currentValue.providers?.[String(currentDefaultValue.provider ?? body.providerKey)] ?? {},
      defaultModel: {
        provider: String(currentDefaultValue.provider ?? body.providerKey),
        model: String(currentDefaultValue.model ?? body.model),
        ...(currentDefaultValue.reasoningEffort === undefined ? {} : { reasoningEffort: String(currentDefaultValue.reasoningEffort) }),
      },
      providerRevision: Number(currentLlm?.['revision'] ?? (usedHomePatch ? 1 : 0)),
      defaultModelRevision: Number(currentDefaults?.['revision'] ?? 0),
    };
  });

  // ---------- providers / models ----------
  app.get('/api/providers', async () => deps.providers.list());

  app.post('/api/providers/scan', async () => deps.providers.scanLocal());

  app.post('/api/providers/restore-ignored', async () => {
    await deps.providers.restoreIgnored();
    return deps.providers.scanLocal();
  });

  app.post('/api/providers', async (request) => {
    const body = request.body as { name?: string; baseUrl?: string; protocols?: string[]; models?: string[]; apiKey?: string; codexCatalogPath?: string };
    if (typeof body?.name !== 'string' || typeof body?.baseUrl !== 'string') throw badRequest('需要 name 与 baseUrl');
    return deps.providers.create({
      name: body.name,
      baseUrl: body.baseUrl,
      protocols: Array.isArray(body.protocols) ? body.protocols : [],
      models: Array.isArray(body.models) ? body.models : [],
      ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey }),
      ...(body.codexCatalogPath === undefined ? {} : { codexCatalogPath: body.codexCatalogPath }),
    });
  });

  app.patch('/api/providers/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const updated = await deps.providers.update(id, {
      ...(typeof body['name'] === 'string' ? { name: body['name'] } : {}),
      ...(typeof body['baseUrl'] === 'string' ? { baseUrl: body['baseUrl'] } : {}),
      ...(typeof body['endpoints'] === 'object' && body['endpoints'] !== null ? { endpoints: body['endpoints'] as Record<string, string> } : {}),
      ...(Array.isArray(body['protocols']) ? { protocols: body['protocols'] as string[] } : {}),
      ...(Array.isArray(body['models']) ? { models: body['models'] as string[] } : {}),
      ...(typeof body['apiKey'] === 'string' ? { apiKey: body['apiKey'] } : {}),
      ...(typeof body['codexCatalogPath'] === 'string' ? { codexCatalogPath: body['codexCatalogPath'] } : {}),
    });
    if (updated === undefined) throw Object.assign(new Error('Provider 不存在'), { statusCode: 404 });
    return updated;
  });

  app.delete('/api/providers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await deps.providers.remove(id);
    return reply.status(204).send();
  });

  app.get('/api/models', async (request) => {
    const query = request.query as { agent?: string; providerId?: string };
    const agent = query.agent ?? '';
    const providerId = query.providerId === undefined || query.providerId === '' ? null : query.providerId;
    if (providerId === null) {
      // 原生登录 / DSH 自己的设置：模型列表来自 adapter（DSH 用 session/modelCatalog）
      const adapter = manager.adaptersList().find((item) => item.id === agent);
      const models = adapter === undefined ? [] : await adapter.listModels(null).catch(() => []);
      return { models: models.map((model) => model.id) };
    }
    return { models: deps.providers.modelsFor(agent, providerId) };
  });

  // ---------- uploads ----------
  app.post('/api/uploads', async (request): Promise<UploadInitResponse & { existingFileId?: string }> => {
    const body = request.body as { name?: string; size?: number; sha256?: string; mime?: string };
    if (typeof body?.name !== 'string' || typeof body?.size !== 'number' || typeof body?.sha256 !== 'string') {
      throw badRequest('需要 name、size、sha256');
    }
    return files.initUpload({ name: body.name, size: body.size, sha256: body.sha256, mime: body.mime ?? 'application/octet-stream' });
  });

  app.put('/api/uploads/:uploadId/chunks/:index', async (request) => {
    const { uploadId, index } = request.params as { uploadId: string; index: string };
    const buffer = request.body as Buffer;
    if (!Buffer.isBuffer(buffer)) throw badRequest('chunk 必须是 application/octet-stream');
    return files.writeChunk(uploadId, Number(index), buffer);
  });

  app.get('/api/uploads/:uploadId', async (request): Promise<UploadStatusResponse> => {
    const { uploadId } = request.params as { uploadId: string };
    return files.uploadStatus(uploadId);
  });

  app.post('/api/uploads/:uploadId/complete', async (request): Promise<UploadCompleteResponse> => {
    const { uploadId } = request.params as { uploadId: string };
    return files.completeUpload(uploadId);
  });

  // ---------- 附件：把上传的文件放进工作区（SPEC-M8 F7） ----------
  app.post('/api/workspaces/:id/attach', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { fileId?: string; name?: string };
    const workspace = store.getWorkspace(id);
    if (workspace === undefined) throw Object.assign(new Error('工作区不存在'), { statusCode: 404 });
    if (typeof body?.fileId !== 'string') throw badRequest('需要 fileId');
    const found = await files.readAll(body.fileId);
    if (found === undefined) throw Object.assign(new Error('文件不存在'), { statusCode: 404 });
    if (found.buffer.byteLength > 100 * 1024 * 1024) throw Object.assign(new Error('文件超过 100 MB 上限'), { statusCode: 413 });
    const original = body.name ?? found.file.name;
    const safeName = original.replace(/[/\\]/g, '_');
    const dir = join(workspace.path, '.webdcc', 'uploads');
    await mkdir(dir, { recursive: true });
    const target = join(dir, `${body.fileId}-${safeName}`);
    await writeFile(target, found.buffer);
    // 工作区是 git 仓库时把 .webdcc/ 写进 .git/info/exclude（不改用户的 .gitignore）
    const gitDir = join(workspace.path, '.git');
    if (existsSync(gitDir)) {
      const exclude = join(gitDir, 'info', 'exclude');
      await mkdir(join(gitDir, 'info'), { recursive: true });
      const current = existsSync(exclude) ? await readFile(exclude, 'utf8') : '';
      if (!current.split('\n').some((line) => line.trim() === '.webdcc/')) {
        await writeFile(exclude, `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}.webdcc/\n`);
      }
    }
    return {
      path: relative(workspace.path, target),
      name: safeName,
      fileId: body.fileId,
      size: found.buffer.byteLength,
      url: `/files/${body.fileId}`,
    };
  });

  // ---------- files ----------
  app.get('/files/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const found = await files.readAll(id);
    if (found === undefined) throw Object.assign(new Error('文件不存在'), { statusCode: 404 });
    const { file, buffer } = found;
    const etag = `"${file.sha256}"`;
    reply.header('content-type', file.mime);
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.header('etag', etag);
    reply.header('accept-ranges', 'bytes');
    if (request.headers['if-none-match'] === etag) return reply.status(304).send();

    const range = request.headers.range;
    if (typeof range === 'string') {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match !== null) {
        const start = match[1] === '' ? 0 : Number(match[1]);
        const end = match[2] === '' ? buffer.byteLength - 1 : Number(match[2]);
        if (start <= end && end < buffer.byteLength) {
          const slice = buffer.subarray(start, end + 1);
          reply.status(206);
          reply.header('content-range', `bytes ${start}-${end}/${buffer.byteLength}`);
          reply.header('content-length', slice.byteLength);
          return reply.send(slice);
        }
      }
    }
    reply.header('content-length', buffer.byteLength);
    return reply.send(buffer);
  });
}

export function sendJsonError(reply: FastifyReply, error: unknown): FastifyReply {
  const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
  const message = error instanceof Error ? error.message : String(error);
  return reply.status(statusCode).send({ error: message });
}

export function requireQuery(request: FastifyRequest): (key: string) => string | undefined {
  const query = request.query as Record<string, string | undefined>;
  return (key) => query[key];
}
