import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { WebSocket } from 'ws';
import { authorityOf, isAuthenticated, requestBoundaryError, type RequestBoundary } from './auth.js';
import type { NativeTerminalSupervisor } from './native-terminal.js';
import { nativeSurfaceError } from './native-surface.js';

export interface NativeTerminalRoutesDeps {
  supervisor: NativeTerminalSupervisor;
  config: RequestBoundary & { token: string };
  /** Persistent command receipt/idempotence belongs to the common action journal. */
  executeControl<T>(action: NativeTerminalControlAction, run: () => Promise<T>): Promise<T>;
}

export type NativeTerminalControlAction =
  | { kind: 'native-terminal.create'; commandId: string; sessionId: string; intent: 'new-native' | 'same-session'; recordOutput: boolean; rows: number; cols: number }
  | { kind: 'native-terminal.stop' | 'native-terminal.close'; commandId: string; sessionId: string; terminalId: string; generation: number };

export function nativeControlCommandId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw nativeSurfaceError('缺少合法的持久命令身份', 400);
  return value;
}

export function registerNativeTerminalRoutes(app: FastifyInstance, deps: NativeTerminalRoutesDeps): void {
  const { supervisor, config } = deps;
  const boundary = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const isStream = (request.url.split('?')[0] ?? '').endsWith('/stream');
    const upgrading = typeof request.headers.upgrade === 'string' && request.headers.upgrade.trim().toLowerCase() === 'websocket';
    const error = requestBoundaryError(request.headers, request.protocol, request.method, isStream || upgrading, config);
    if (error !== undefined) { await reply.status(403).send({ error }); return; }
    if (!isAuthenticated(config.token, request.headers.cookie, authorityOf(request.headers, config.host, config.port))) await reply.status(401).send({ error: 'unauthorized' });
  };
  const base = '/api/native-terminal';
  app.get(base, { onRequest: boundary }, async request => {
    const { sessionId } = request.query as { sessionId?: string };
    if (typeof sessionId !== 'string' || !sessionId) throw nativeSurfaceError('缺少来源会话', 400);
    return { terminals: supervisor.list(sessionId) };
  });
  app.post(base, { onRequest: boundary, bodyLimit: 4_096 }, async request => {
    const body = request.body as { commandId?: unknown; sessionId?: unknown; intent?: unknown; rows?: unknown; cols?: unknown; recordOutput?: unknown };
    if (!body || typeof body !== 'object' || typeof body.sessionId !== 'string' || !body.sessionId || !['same-session', 'new-native'].includes(String(body.intent))) throw nativeSurfaceError('无效的原生终端创建参数', 400);
    if (Object.keys(body).some(key => !['commandId', 'sessionId', 'intent', 'rows', 'cols', 'recordOutput'].includes(key))) throw nativeSurfaceError('原生终端不接受 executable、argv、cwd 或 env 请求参数', 400);
    if ((body.rows !== undefined && typeof body.rows !== 'number') || (body.cols !== undefined && typeof body.cols !== 'number') || (body.recordOutput !== undefined && typeof body.recordOutput !== 'boolean')) throw nativeSurfaceError('终端尺寸或日志选项无效', 400);
    const action: NativeTerminalControlAction = { kind: 'native-terminal.create', commandId: nativeControlCommandId(body.commandId), sessionId: body.sessionId, intent: body.intent as 'same-session' | 'new-native', rows: (body.rows as number | undefined) ?? 30, cols: (body.cols as number | undefined) ?? 100, recordOutput: body.recordOutput === true };
    return deps.executeControl(action, () => supervisor.create(action.sessionId, action.intent, action));
  });
  app.get(`${base}/:id`, { onRequest: boundary }, async request => supervisor.get((request.params as { id: string }).id));
  app.post(`${base}/:id/stop`, { onRequest: boundary, bodyLimit: 1_024 }, async request => {
    const { generation, commandId } = (request.body ?? {}) as { generation?: number; commandId?: string };
    if (!Number.isSafeInteger(generation)) throw nativeSurfaceError('缺少终端运行代际', 400);
    const terminal = supervisor.get((request.params as { id: string }).id);
    return deps.executeControl({ kind: 'native-terminal.stop', commandId: nativeControlCommandId(commandId), sessionId: terminal.ownerSessionId, terminalId: terminal.id, generation: generation! }, () => supervisor.stop(terminal.id, generation!));
  });
  app.delete(`${base}/:id`, { onRequest: boundary }, async request => {
    const { generation, commandId } = request.query as { generation?: string; commandId?: string };
    const terminal = supervisor.get((request.params as { id: string }).id);
    if (Number(generation) !== terminal.generation) throw nativeSurfaceError('终端运行代际已变化');
    return deps.executeControl({ kind: 'native-terminal.close', commandId: nativeControlCommandId(commandId), sessionId: terminal.ownerSessionId, terminalId: terminal.id, generation: terminal.generation }, () => supervisor.close(terminal.id));
  });
  app.get(`${base}/:id/log`, { onRequest: boundary }, async (request, reply) => {
    const log = supervisor.log((request.params as { id: string }).id);
    // Bound this download to the bytes that existed at request time.
    const size = (await stat(log.path)).size;
    reply.header('cache-control', 'no-store').header('content-disposition', 'attachment; filename="native-terminal-output.txt"');
    reply.header('x-webdcc-output-truncated', String(log.truncated));
    return reply.type('text/plain; charset=utf-8').send(size === 0 ? '' : createReadStream(log.path, { start: 0, end: size - 1 }));
  });
  app.get(`${base}/:id/stream`, { websocket: true, onRequest: boundary }, (socket: WebSocket, request) => {
    const id = (request.params as { id: string }).id;
    const query = request.query as { generation?: string; afterSeq?: string };
    const generation = Number(query.generation);
    const afterSeq = query.afterSeq === undefined ? 0 : Number(query.afterSeq);
    let detach: (() => void) | undefined;
    let queuedInputs = 0;
    let inputWindowAt = Date.now();
    const fail = (code: number, reason: string): void => { detach?.(); detach = undefined; socket.close(code, reason.slice(0, 100)); };
    const onMessage = (raw: Buffer): void => {
      try {
        if (raw.byteLength > 70 * 1024) throw nativeSurfaceError('终端消息超限', 400);
        const now = Date.now();
        if (now - inputWindowAt > 1_000) { queuedInputs = 0; inputWindowAt = now; }
        if (++queuedInputs > 200) throw nativeSurfaceError('终端输入频率超限', 429);
        const message = JSON.parse(raw.toString('utf8')) as { type?: string; generation?: number; data?: string; rows?: number; cols?: number };
        if (message.generation !== generation) throw nativeSurfaceError('旧运行代际不能写入');
        if (message.type === 'input') supervisor.input(id, generation, message.data!);
        else if (message.type === 'resize') supervisor.resize(id, generation, message.rows!, message.cols!);
        else throw nativeSurfaceError('未知终端消息', 400);
      } catch (error) { fail(1008, error instanceof Error ? error.message : 'invalid terminal message'); }
    };
    socket.on('close', () => { detach?.(); detach = undefined; socket.removeListener('message', onMessage); });
    socket.on('error', () => { detach?.(); detach = undefined; });
    try {
      if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(afterSeq) || afterSeq < 0) throw nativeSurfaceError('终端代际或恢复水位无效', 400);
      detach = supervisor.attach(id, generation, {
        send: frame => {
          if (socket.readyState !== socket.OPEN || socket.bufferedAmount > 1024 * 1024) throw nativeSurfaceError('终端连接背压');
          socket.send(JSON.stringify(frame));
        }, close: fail,
      }, afterSeq);
      socket.on('message', onMessage);
    } catch (error) { fail(1008, error instanceof Error ? error.message : 'terminal unavailable'); }
  });
  app.addHook('onClose', async () => supervisor.dispose());
}
