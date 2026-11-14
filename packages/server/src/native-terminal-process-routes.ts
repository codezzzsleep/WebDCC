import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { WebSocket } from 'ws';
import { authorityOf, isAuthenticated, requestBoundaryError, type RequestBoundary } from './auth.js';
import type { NativeProcessSupervisor } from './native-terminal-process.js';
import { nativeControlCommandId } from './native-terminal-routes.js';
import { nativeSurfaceError } from './native-surface.js';

export type NativeProcessControlAction =
  | { kind: 'native-process.start'; commandId: string; sessionId: string; command: string[]; rows: number; cols: number; recordOutput: boolean }
  | { kind: 'native-process.stop' | 'native-process.close'; commandId: string; sessionId: string; processId: string; generation: number };
export interface NativeProcessRoutesDeps {
  supervisor: NativeProcessSupervisor;
  config: RequestBoundary & { token: string };
  executeControl<T>(action: NativeProcessControlAction, run: () => Promise<T>): Promise<T>;
}
export function registerNativeProcessRoutes(app: FastifyInstance, deps: NativeProcessRoutesDeps): void {
  const { supervisor, config } = deps;
  const boundary = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const isStream = (request.url.split('?')[0] ?? '').endsWith('/stream');
    const upgrading = typeof request.headers.upgrade === 'string' && request.headers.upgrade.trim().toLowerCase() === 'websocket';
    const error = requestBoundaryError(request.headers, request.protocol, request.method, isStream || upgrading, config);
    if (error !== undefined) { await reply.status(403).send({ error }); return; }
    if (!isAuthenticated(config.token, request.headers.cookie, authorityOf(request.headers, config.host, config.port))) await reply.status(401).send({ error: 'unauthorized' });
  };
  const base = '/api/native-process';
  app.get(base, { onRequest: boundary }, async request => {
    const sessionId = (request.query as { sessionId?: string }).sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw nativeSurfaceError('缺少原生会话', 400);
    return { processes: supervisor.list(sessionId) };
  });
  app.post(base, { onRequest: boundary, bodyLimit: 128 * 1024 }, async request => {
    const body = request.body as { commandId?: unknown; sessionId?: unknown; command?: unknown; rows?: unknown; cols?: unknown; recordOutput?: unknown };
    if (!body || typeof body.sessionId !== 'string' || !body.sessionId || !Array.isArray(body.command)) throw nativeSurfaceError('原生进程启动参数无效', 400);
    if (Object.keys(body).some(key => !['commandId', 'sessionId', 'command', 'rows', 'cols', 'recordOutput'].includes(key))) throw nativeSurfaceError('原生进程不接受 cwd、env 或权限覆盖', 400);
    if ((body.rows !== undefined && typeof body.rows !== 'number') || (body.cols !== undefined && typeof body.cols !== 'number') || (body.recordOutput !== undefined && typeof body.recordOutput !== 'boolean')) throw nativeSurfaceError('原生进程尺寸与日志选项无效', 400);
    const action: NativeProcessControlAction = { kind: 'native-process.start', commandId: nativeControlCommandId(body.commandId), sessionId: body.sessionId, command: body.command as string[], rows: (body.rows as number | undefined) ?? 30, cols: (body.cols as number | undefined) ?? 100, recordOutput: body.recordOutput === true };
    return deps.executeControl(action, () => supervisor.start(action.sessionId, action.command, { rows: action.rows, cols: action.cols }, action.recordOutput));
  });
  app.get(`${base}/:id`, { onRequest: boundary }, async request => supervisor.get((request.params as { id: string }).id));
  app.post(`${base}/:id/stop`, { onRequest: boundary, bodyLimit: 1_024 }, async request => {
    const body = (request.body ?? {}) as { commandId?: unknown; generation?: number };
    if (!Number.isSafeInteger(body.generation)) throw nativeSurfaceError('缺少原生进程代际', 400);
    const process = supervisor.get((request.params as { id: string }).id);
    return deps.executeControl({ kind: 'native-process.stop', commandId: nativeControlCommandId(body.commandId), sessionId: process.sessionId, processId: process.id, generation: body.generation! }, () => supervisor.stop(process.id, body.generation!));
  });
  app.delete(`${base}/:id`, { onRequest: boundary }, async request => {
    const query = request.query as { commandId?: string; generation?: string };
    const generation = Number(query.generation);
    if (!Number.isSafeInteger(generation)) throw nativeSurfaceError('缺少原生进程代际', 400);
    const process = supervisor.get((request.params as { id: string }).id);
    return deps.executeControl({ kind: 'native-process.close', commandId: nativeControlCommandId(query.commandId), sessionId: process.sessionId, processId: process.id, generation }, async () => { await supervisor.close(process.id, generation); return { closed: true }; });
  });
  app.get(`${base}/:id/log`, { onRequest: boundary }, async (request, reply) => {
    const log = supervisor.log((request.params as { id: string }).id); const size = (await stat(log.path)).size;
    reply.header('cache-control', 'no-store').header('content-disposition', 'attachment; filename="native-process-output.txt"').header('x-webdcc-output-truncated', String(log.truncated));
    return reply.type('text/plain; charset=utf-8').send(size === 0 ? '' : createReadStream(log.path, { start: 0, end: size - 1 }));
  });
  app.get(`${base}/:id/stream`, { websocket: true, onRequest: boundary }, (socket: WebSocket, request) => {
    const id = (request.params as { id: string }).id;
    const query = request.query as { generation?: string; afterSeq?: string };
    const generation = Number(query.generation); const afterSeq = Number(query.afterSeq ?? '0');
    let detach: (() => void) | undefined;
    let messages = 0;
    let windowAt = Date.now();
    const fail = (reason: string): void => { detach?.(); detach = undefined; socket.close(1008, reason.slice(0, 100)); };
    const onMessage = (raw: Buffer): void => {
      try {
        if (raw.byteLength > 70 * 1024) throw nativeSurfaceError('原生进程输入消息超限', 400);
        if (Date.now() - windowAt > 1_000) { messages = 0; windowAt = Date.now(); }
        if (++messages > 200) throw nativeSurfaceError('原生进程输入频率超限', 429);
        const message = JSON.parse(raw.toString('utf8')) as { type?: string; generation?: number; data?: string; rows?: number; cols?: number; closeStdin?: boolean };
        if (message.generation !== generation) throw nativeSurfaceError('原生进程代际已变化');
        if (message.type === 'input' && typeof message.data === 'string') void supervisor.write(id, generation, message.data, message.closeStdin === true).catch(error => fail(error instanceof Error ? error.message : 'native stdin failed'));
        else if (message.type === 'resize') void supervisor.resize(id, generation, message.rows!, message.cols!).catch(error => fail(error instanceof Error ? error.message : 'native resize failed'));
        else throw nativeSurfaceError('无效的原生进程消息', 400);
      } catch (error) { fail(error instanceof Error ? error.message : 'native process message failed'); }
    };
    socket.on('close', () => { detach?.(); detach = undefined; socket.removeListener('message', onMessage); });
    socket.on('error', () => { detach?.(); detach = undefined; });
    try {
      if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(afterSeq) || afterSeq < 0) throw nativeSurfaceError('原生进程代际或恢复水位无效', 400);
      detach = supervisor.attach(id, generation, { send: frame => { if (socket.readyState !== socket.OPEN || socket.bufferedAmount > 1024 * 1024) throw nativeSurfaceError('原生进程输出背压'); socket.send(JSON.stringify(frame)); }, close: (code, reason) => { detach?.(); detach = undefined; socket.close(code, reason); } }, afterSeq);
      socket.on('message', onMessage);
    } catch (error) { fail(error instanceof Error ? error.message : 'native process unavailable'); }
  });
  app.addHook('onClose', async () => supervisor.dispose());
}
