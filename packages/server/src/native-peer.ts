import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { once } from 'node:events';
import * as pty from 'node-pty';
import WebSocket, { WebSocketServer } from 'ws';
import type { RuntimeIdentity } from '@webdcc/protocol';
import { NativeTerminalOutput } from './native-terminal-buffer.js';
import { nativeSurfaceError } from './native-surface.js';
import { tokenEquals } from './auth.js';

export interface NativePeerContext {
  identity: RuntimeIdentity; nativeId: string; nativeVersion: string; socketPath: string;
  executable: string; cwd: string; env: Record<string, string>;
  assert(): void;
  hold(): () => void;
  record(direction: 'in' | 'out', channel: string, frame: Record<string, unknown>): boolean;
}
export interface NativePeerView {
  id: string; sourceSessionId: string; ownerSessionId: string; generation: number;
  agent: 'codex'; intent: 'live-session'; nativeId: string | null; nativeVersion: string;
  nativeIdentityVerified: boolean; cwd: string; rows: number; cols: number;
  state: 'running' | 'closing' | 'exited' | 'uncertain'; exitCode: number | null;
  outputTruncated: boolean; logDownloadAvailable: boolean;
}
interface Client { send(frame: unknown): void; close(code: number, reason: string): void }
interface Peer {
  context: NativePeerContext; view: NativePeerView; process: pty.IPty; output: NativeTerminalOutput;
  clients: Set<Client>; release(): void; server: ReturnType<typeof createServer>; sockets: WebSocketServer;
  upstream: Set<WebSocket>; exited: Promise<void>; check: ReturnType<typeof setInterval>;
  stopping?: Promise<void>;
}

/** A native TUI peer shares the hosted process. It never acquires or releases
 * the structured session's writer, and peer frames never enter its handler. */
export class NativePeerSupervisor {
  private readonly peers = new Map<string, Peer>();
  private readonly opening = new Set<string>();
  constructor(private readonly resolve: (sessionId: string) => Promise<NativePeerContext>, private readonly logRoot: string) {}
  list(sessionId: string): NativePeerView[] { return [...this.peers.values()].filter(p => p.view.sourceSessionId === sessionId).map(p => ({ ...p.view })); }
  get(id: string): NativePeerView { return { ...this.require(id).view }; }
  private require(id: string): Peer { const value = this.peers.get(id); if (!value) throw nativeSurfaceError('原生视图已关闭', 404); return value; }
  async create(sessionId: string, _intent: 'live-session', options: { rows?: number; cols?: number; recordOutput?: boolean } = {}): Promise<NativePeerView> {
    const previous = [...this.peers.values()].find(p => p.view.sourceSessionId === sessionId && p.view.state === 'running');
    if (previous) { previous.context.assert(); return { ...previous.view }; }
    if (this.opening.has(sessionId) || this.peers.size + this.opening.size >= 8) throw nativeSurfaceError('原生视图正在启动或数量已达上限');
    this.opening.add(sessionId);
    let peer: Peer | undefined; let release: (() => void) | undefined;
    const server = createServer((_request, reply) => { reply.writeHead(404); reply.end(); });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    const upstream = new Set<WebSocket>();
    let output: NativeTerminalOutput | undefined;
    try {
      const context = await this.resolve(sessionId); context.assert(); release = context.hold();
      const id = `peer-${randomUUID()}`; const token = randomBytes(32).toString('base64url');
      const view: NativePeerView = { id, sourceSessionId: sessionId, ownerSessionId: sessionId, generation: context.identity.generation,
        agent: 'codex', intent: 'live-session', nativeId: null, nativeVersion: context.nativeVersion, nativeIdentityVerified: false,
        cwd: context.cwd, rows: options.rows ?? 30, cols: options.cols ?? 100, state: 'running', exitCode: null,
        outputTruncated: false, logDownloadAvailable: options.recordOutput === true };
      if (!Number.isInteger(view.rows) || view.rows < 2 || view.rows > 200 || !Number.isInteger(view.cols) || view.cols < 2 || view.cols > 400) throw nativeSurfaceError('终端尺寸无效', 400);
      output = new NativeTerminalOutput(undefined, options.recordOutput ? this.logRoot : undefined);
      let initialIdentityVerified = false;
      server.on('upgrade', (request, socket, head) => {
        try { context.assert(); } catch { socket.destroy(); return; }
        if (request.url !== '/' || !tokenEquals(request.headers.authorization?.replace(/^Bearer /, '') ?? '', token) || upstream.size) { socket.destroy(); return; }
        sockets.handleUpgrade(request, socket, head, client => {
          const native = new WebSocket('ws://localhost/', { createConnection: () => connect(context.socketPath), maxPayload: 64 * 1024 * 1024 });
          upstream.add(native); const queue: { data: Buffer; binary: boolean }[] = [];
          const pending = new Map<string | number, { method: string; threadId?: string }>();
          let closed = false;
          const stop = () => { if (closed) return; closed = true; native.terminate(); client.terminate(); upstream.delete(native); pending.clear(); queue.length = 0; };
          client.on('error', stop); native.on('error', stop); client.once('close', stop); native.once('close', stop);
          client.on('message', (raw, binary) => {
            try {
              context.assert(); const data = Buffer.from(raw.toString()); const frame = JSON.parse(data.toString()) as Record<string, unknown>;
              if (!context.record('out', `rpc-peer:${id}`, frame)) throw nativeSurfaceError('原生请求未持久化');
              if ((typeof frame['id'] === 'number' || typeof frame['id'] === 'string') && typeof frame['method'] === 'string') {
                const params = frame['params'] as { threadId?: string } | undefined;
                pending.set(frame['id'], { method: frame['method'], threadId: params?.threadId });
                if (['thread/resume', 'thread/start', 'thread/fork'].includes(frame['method'])) {
                  view.nativeIdentityVerified = false;
                  if (peer) this.broadcast(peer, { type: 'state', terminal: { ...view } });
                }
              }
              if (native.readyState === WebSocket.OPEN) native.send(data, { binary }); else queue.push({ data, binary });
            } catch { stop(); }
          });
          native.once('open', () => { try { context.assert(); for (const { data, binary } of queue.splice(0)) native.send(data, { binary }); } catch { stop(); } });
          native.on('message', (raw, binary) => {
            try {
              context.assert(); const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
              if (!context.record('in', `rpc-peer:${id}`, frame)) throw nativeSurfaceError('原生响应未持久化');
              const request = pending.get(frame['id'] as string | number);
              if (request && frame['method'] === undefined) {
                pending.delete(frame['id'] as string | number);
                if (['thread/resume', 'thread/start', 'thread/fork'].includes(request.method) && frame['error'] === undefined) {
                  const thread = (frame['result'] as { thread?: { id?: string } } | undefined)?.thread;
                  if (!thread?.id || request.method === 'thread/resume' && thread.id !== request.threadId
                    || !initialIdentityVerified && (request.method !== 'thread/resume' || thread.id !== context.nativeId)) throw nativeSurfaceError('原生视图会话身份不一致');
                  initialIdentityVerified = true;
                  view.nativeId = thread.id; view.nativeIdentityVerified = true; if (peer) this.broadcast(peer, { type: 'state', terminal: { ...view } });
                }
              }
              client.send(raw, { binary });
            } catch { stop(); }
          });
        });
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening'); context.assert();
      const address = server.address(); if (!address || typeof address === 'string') throw nativeSurfaceError('原生视图连接未启动');
      const process = pty.spawn(context.executable, ['--remote', `ws://127.0.0.1:${address.port}`, '--remote-auth-token-env', 'WEB_DCC_NATIVE_PEER_TOKEN', 'resume', context.nativeId, '--no-alt-screen'], {
        cwd: context.cwd, env: { ...context.env, WEB_DCC_NATIVE_PEER_TOKEN: token, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, rows: view.rows, cols: view.cols,
      });
      let resolveExit!: () => void; const exited = new Promise<void>(r => { resolveExit = r; });
      const check = setInterval(() => { try { context.assert(); } catch { if (peer) { clearInterval(peer.check); peer.view.state = 'uncertain'; this.broadcast(peer, { type: 'state', terminal: { ...peer.view } }); void this.close(id).catch(() => undefined); } } }, 500); check.unref();
      peer = { context, view, process, output, clients: new Set(), release, server, sockets, upstream, exited, check };
      this.peers.set(id, peer);
      process.onData(data => {
        if (!peer) return; const chunk = peer.output.append(data); view.outputTruncated = peer.output.truncated; this.broadcast(peer, { type: 'output', chunk });
      });
      process.onExit(event => {
        if (!peer) return; clearInterval(check); view.state = 'exited'; view.exitCode = event.exitCode;
        peer.release(); peer.release = () => undefined; peer.output.seal(); this.broadcast(peer, { type: 'state', terminal: { ...view } }); resolveExit();
        for (const wire of upstream) wire.terminate(); for (const wire of sockets.clients) wire.terminate(); void sockets.close(); server.close();
      });
      return { ...view };
    } catch (error) { release?.(); output?.dispose(); for (const wire of upstream) wire.terminate(); for (const wire of sockets.clients) wire.terminate(); sockets.close(); server.close(); throw error; }
    finally { this.opening.delete(sessionId); }
  }
  private broadcast(peer: Peer, frame: unknown): void { for (const client of peer.clients) { try { client.send(frame); } catch { peer.clients.delete(client); client.close(1013, '原生视图连接背压'); } } }
  input(id: string, generation: number, data: string): void {
    const peer = this.require(id); peer.context.assert();
    if (generation !== peer.view.generation || peer.view.state !== 'running' || typeof data !== 'string' || Buffer.byteLength(data) > 64 * 1024) throw nativeSurfaceError('原生视图输入或代际无效');
    // Device replies let the TUI finish initialization; user text requires its
    // acknowledged native thread identity, rather than the requested argv.
    const replies = data.split(String.fromCharCode(27));
    const deviceReply = replies[0] === '' && replies.length > 1 && replies.slice(1).every(part => /^\[[0-9;?=>]*[cRn]$/u.test(part));
    if (!peer.view.nativeIdentityVerified && !deviceReply) throw nativeSurfaceError('原生会话身份尚未确认');
    peer.process.write(data);
  }
  resize(id: string, generation: number, rows: number, cols: number): void {
    const peer = this.require(id); peer.context.assert(); if (generation !== peer.view.generation || !Number.isInteger(rows) || rows < 2 || rows > 200 || !Number.isInteger(cols) || cols < 2 || cols > 400) throw nativeSurfaceError('原生视图尺寸或代际无效');
    peer.process.resize(cols, rows); peer.view.rows = rows; peer.view.cols = cols;
  }
  attach(id: string, generation: number, client: Client, after = 0): () => void {
    const peer = this.require(id); peer.context.assert(); if (generation !== peer.view.generation) throw nativeSurfaceError('原生视图代际已变化');
    client.send({ type: 'snapshot', terminal: { ...peer.view }, ...peer.output.snapshot(after) }); peer.clients.add(client); return () => peer.clients.delete(client);
  }
  log(id: string): { path: string; truncated: boolean } { const peer = this.require(id); if (!peer.output.logPath) throw nativeSurfaceError('未启用原生视图日志', 404); return { path: peer.output.logPath, truncated: peer.output.truncated }; }
  private async stopPeer(peer: Peer): Promise<void> {
    if (peer.view.state === 'exited') return;
    if (peer.stopping) return peer.stopping;
    peer.view.state = 'closing'; peer.process.kill('SIGKILL');
    peer.stopping = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([peer.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(nativeSurfaceError('原生视图进程退出未确认')), 7000); })]); }
      catch (error) { peer.view.state = 'uncertain'; throw error; }
      finally { if (timer) clearTimeout(timer); }
    })();
    return peer.stopping;
  }
  async stop(id: string, generation: number): Promise<NativePeerView> { const peer = this.require(id); if (peer.view.generation !== generation) throw nativeSurfaceError('原生视图代际已变化'); await this.stopPeer(peer); return { ...peer.view }; }
  async close(id: string): Promise<NativePeerView> {
    const peer = this.require(id);
    await this.stopPeer(peer);
    const result = { ...peer.view }; peer.output.dispose(); this.peers.delete(id); for (const client of peer.clients) client.close(1000, '原生视图已关闭'); return result;
  }
  async dispose(): Promise<void> { await Promise.all([...this.peers.keys()].map(id => this.close(id))); }
}
