import { createReadStream } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
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
import type { FileStore } from './files.js';
import type { LiveHub } from './hub.js';
import type { SessionManager } from './manager.js';
import type { Store } from './store.js';

export interface RouteDeps {
  store: Store;
  providers: ProviderRegistry;
  files: FileStore;
  manager: SessionManager;
  hub: LiveHub;
  dispatcher: CommandDispatcher;
  version: string;
}

const MAX_TEXT_READ = 1024 * 1024;

function badRequest(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/** 解析符号链接后必须仍在工作区内（SPEC 11.1） */
export async function resolveInsideWorkspace(workspacePath: string, requested: string): Promise<string> {
  const root = await realpath(workspacePath);
  const target = await realpath(resolve(root, requested.replace(/^\/+/, '')));
  const rel = relative(root, target);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) throw badRequest('路径必须在工作区内');
  return target;
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
        accessModes: adapter.accessModes(),
        models: await adapter.listModels(null).catch(() => []),
      };
    }
    return { version: deps.version, agents };
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

  // ---------- providers / models ----------
  app.get('/api/providers', async () => deps.providers.list());

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
