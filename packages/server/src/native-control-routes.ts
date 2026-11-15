import type { FastifyInstance } from 'fastify';
import type { NativeActionRequest } from '@webdcc/protocol';
import type { SessionManager } from './manager.js';
import type { Store } from './store.js';

/** Registered inside buildApp's authenticated request boundary. */
export function registerNativeControlRoutes(app: FastifyInstance, manager: SessionManager, store: Store): void {
  const base = '/api/sessions/:id/native';
  const id = (request: { params: unknown }): string => (request.params as { id: string }).id;
  app.get(base, request => manager.nativeControls(id(request), (request.query as { catalog?: string }).catalog === '1'));
  app.post(`${base}/connect`, { bodyLimit: 2_048 }, request => manager.connectNativeControls(id(request), request.body as NativeActionRequest));
  app.post(`${base}/actions`, { bodyLimit: 256 * 1024 }, request => manager.executeNativeControl(id(request), request.body as NativeActionRequest));
  app.get(`${base}/actions/:commandId`, (request, reply) => {
    manager.requireSession(id(request));
    const value = store.nativeActions.get((request.params as { commandId: string }).commandId, id(request));
    return value === undefined ? reply.code(404).send({ error: '原生命令不存在' }) : value;
  });
  app.get(`${base}/history`, request => {
    const query = request.query as { cursor?: string; offset?: string; limit?: string };
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const offset = query.offset === undefined ? undefined : Number(query.offset);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) || (query.cursor !== undefined && query.cursor.length > 4096)) throw Object.assign(new Error('原生历史分页参数无效'), { statusCode: 400 });
    return manager.readNativeHistory(id(request), { limit, ...(query.cursor === undefined ? {} : { cursor: query.cursor }), ...(offset === undefined ? {} : { offset }) });
  });
}
