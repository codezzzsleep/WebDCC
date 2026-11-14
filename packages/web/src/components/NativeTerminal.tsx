import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export interface NativeTerminalInfo {
  id: string;
  generation: number;
  agent: string;
  cwd: string;
  nativeId: string | null;
  nativeVersion?: string;
  nativeIdentityVerified?: boolean;
  identityInspection?: { state: 'unverified' | 'verified' | 'drifted' | 'uncertain'; nativeId: string | null; observedAt: string; reason: string };
  identityChanges?: { state: 'unverified' | 'verified' | 'drifted' | 'uncertain'; nativeId: string | null; observedAt: string; reason: string }[];
  intent?: 'new-native' | 'same-session';
  state: 'starting' | 'running' | 'closing' | 'exited' | 'uncertain';
  exitCode: number | null;
  outputTruncated: boolean;
  logDownloadAvailable: boolean;
  rows: number;
  cols: number;
  error?: string;
  permissionSummary?: string;
}
interface Chunk { seq: number; data: string }
interface Frame { type: 'output' | 'snapshot' | 'state'; chunk?: Chunk; chunks?: Chunk[]; terminal?: NativeTerminalInfo; process?: NativeTerminalInfo; firstSeq?: number; lastSeq?: number; gap?: boolean }

export async function nativeSurfaceRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin', headers: { ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }), ...init?.headers } });
  const body = await response.json() as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(body.message ?? body.error ?? `原生操作失败（${response.status}）`);
  return body;
}

/** xterm consumes ANSI bytes; native output never enters an HTML renderer. */
export function NativeTerminal({ terminal, endpoint = '/api/native-terminal', onChanged, onClosed }: {
  terminal: NativeTerminalInfo;
  endpoint?: '/api/native-terminal' | '/api/native-process';
  onChanged?(terminal: NativeTerminalInfo): void;
  onClosed?(): void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const xterm = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const [view, setView] = useState(terminal);
  const viewRef = useRef(terminal);
  const callbacks = useRef({ onChanged, onClosed });
  callbacks.current = { onChanged, onClosed };
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected' | 'blocked'>('connecting');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [gap, setGap] = useState(false);
  useEffect(() => { viewRef.current = terminal; setView(terminal); }, [terminal]);

  useEffect(() => {
    if (!mount.current) return;
    let disposed = false;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let queuedSeq = 0;
    let pendingOutputBytes = 0;
    const term = new Terminal({ cols: terminal.cols, rows: terminal.rows, scrollback: 2_000, screenReaderMode: true, fontSize: 13,
      theme: { background: '#11151b', foreground: '#e8e8e8' }, allowProposedApi: false,
      linkHandler: { activate: (_event, uri) => { try { const target = new URL(uri); if (['https:', 'http:'].includes(target.protocol) && !target.username && !target.password) window.open(target.href, '_blank', 'noopener,noreferrer'); } catch { /* Unsupported native link. */ } } },
    });
    const fit = new FitAddon();
    term.loadAddon(fit); term.open(mount.current);
    // OSC 52 is a remote clipboard request; do not grant it implicitly.
    const clipboard = term.parser.registerOscHandler(52, () => true);
    xterm.current = term;
    const update = (next: NativeTerminalInfo): void => {
      viewRef.current = next; setView(next); callbacks.current.onChanged?.(next);
      term.options.disableStdin = !['starting', 'running'].includes(next.state) || (next.intent === 'same-session' && !next.nativeIdentityVerified);
    };
    const send = (message: object): void => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message)); };
    const data = term.onData(input => {
      if (!['starting', 'running'].includes(viewRef.current.state)) return;
      // Do not enqueue, replay, or mix terminal keys with the chat outbox.
      if (socket.current?.readyState === WebSocket.OPEN) send({ type: 'input', generation: terminal.generation, data: input });
      else setError('终端连接已断开，本次按键未发送。连接恢复后请重新操作。');
    });
    const resize = term.onResize(size => send({ type: 'resize', generation: terminal.generation, rows: Math.min(200, Math.max(2, size.rows)), cols: Math.min(400, Math.max(2, size.cols)) }));
    const fitTerminal = (): void => { try { fit.fit(); } catch { /* Hidden container will fit when visible. */ } };
    const observer = new ResizeObserver(fitTerminal); observer.observe(mount.current);
    const write = (chunk: Chunk): void => {
      if (!Number.isSafeInteger(chunk.seq) || chunk.seq <= queuedSeq || typeof chunk.data !== 'string') return;
      const bytes = new TextEncoder().encode(chunk.data).byteLength;
      if (pendingOutputBytes + bytes > 1024 * 1024) { socket.current?.close(1013, 'terminal rendering backpressure'); return; }
      pendingOutputBytes += bytes; queuedSeq = chunk.seq;
      term.write(chunk.data, () => { pendingOutputBytes -= bytes; cursor = Math.max(cursor, chunk.seq); });
    };
    const connect = (): void => {
      if (disposed) return;
      setConnection('connecting');
      const url = new URL(`${endpoint}/${encodeURIComponent(terminal.id)}/stream`, window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('generation', String(terminal.generation)); url.searchParams.set('afterSeq', String(cursor));
      const ws = new WebSocket(url); socket.current = ws;
      ws.onopen = () => { if (!disposed) { setConnection('connected'); setError(''); fitTerminal(); send({ type: 'resize', generation: terminal.generation, rows: Math.min(200, Math.max(2, term.rows)), cols: Math.min(400, Math.max(2, term.cols)) }); } };
      ws.onmessage = event => {
        if (disposed || typeof event.data !== 'string') return;
        try {
          const frame = JSON.parse(event.data) as Frame;
          if (frame.type === 'snapshot') {
            if (frame.gap) { setGap(true); term.reset(); }
            (frame.chunks ?? []).forEach(write);
            if (frame.terminal ?? frame.process) update((frame.terminal ?? frame.process)!);
          } else if (frame.type === 'output' && frame.chunk) write(frame.chunk);
          else if (frame.type === 'state' && (frame.terminal ?? frame.process)) update((frame.terminal ?? frame.process)!);
        } catch { setError('原生终端帧无效，正在等待重新连接。'); ws.close(1008, 'invalid terminal frame'); }
      };
      ws.onclose = event => {
        if (disposed) return;
        socket.current = null;
        if ([1008, 1000].includes(event.code)) { setConnection(event.code === 1008 ? 'blocked' : 'disconnected'); if (event.reason) setError(event.reason); return; }
        setConnection('disconnected'); reconnect = setTimeout(connect, 1_500);
      };
      ws.onerror = () => { if (!disposed) setConnection('disconnected'); };
    };
    connect(); fitTerminal();
    return () => {
      disposed = true; if (reconnect !== undefined) clearTimeout(reconnect);
      const ws = socket.current; socket.current = null; if (ws) ws.close(1000, 'view detached');
      observer.disconnect(); data.dispose(); resize.dispose(); clipboard.dispose(); fit.dispose(); term.dispose(); xterm.current = null;
    };
  }, [terminal.id, terminal.generation, endpoint]);

  const control = async (action: 'stop' | 'close'): Promise<void> => {
    setPending(true); setError('');
    try {
      const commandId = crypto.randomUUID();
      if (action === 'stop') {
        const next = await nativeSurfaceRequest<NativeTerminalInfo>(`${endpoint}/${encodeURIComponent(view.id)}/stop`, { method: 'POST', body: JSON.stringify({ generation: view.generation, commandId }) });
        setView(next); viewRef.current = next; callbacks.current.onChanged?.(next);
      } else {
        await nativeSurfaceRequest(`${endpoint}/${encodeURIComponent(view.id)}?generation=${view.generation}&commandId=${commandId}`, { method: 'DELETE' });
        callbacks.current.onClosed?.();
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : '原生操作失败'); }
    finally { setPending(false); }
  };
  const paste = async (): Promise<void> => {
    setError('');
    try {
      const text = await navigator.clipboard.readText();
      if (new TextEncoder().encode(text).byteLength > 65_500) throw new Error('本次粘贴超过终端单帧限制，请拆分后粘贴。');
      if (socket.current?.readyState !== WebSocket.OPEN) throw new Error('终端连接已断开，本次粘贴未发送。');
      xterm.current?.paste(text); xterm.current?.focus();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '无法读取剪贴板，请使用终端的粘贴快捷键。'); }
  };
  return <section className="native-terminal" aria-label="原生交互终端" style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: 12, alignItems: 'center' }}>
      <strong>{view.agent} {view.nativeVersion}</strong>
      <span role="status">{connection === 'connected' ? '已连接' : connection === 'blocked' ? '连接受阻' : connection === 'connecting' ? '正在连接' : '连接已断开'} · {view.state}{view.exitCode !== null ? ` · exit ${view.exitCode}` : ''}</span>
      <button type="button" disabled={pending || !['starting', 'running'].includes(view.state)} onClick={() => { void control('stop'); }}>停止进程</button>
      <button type="button" disabled={connection !== 'connected' || !['starting', 'running'].includes(view.state)} onClick={() => { void paste(); }}>粘贴剪贴板</button>
      <button type="button" disabled={pending} onClick={() => { void control('close'); }}>关闭并清除日志</button>
      {view.logDownloadAvailable && <a href={`${endpoint}/${encodeURIComponent(view.id)}/log`} download>下载临时日志</a>}
    </div>
    <p style={{ margin: '0 12px 8px', fontSize: 12 }}>工作目录：{view.cwd} · 原生会话：{view.nativeId ?? '尚未生成'}{view.nativeIdentityVerified === false ? '（身份待验证）' : ''}</p>
    {view.identityInspection && ['drifted', 'uncertain'].includes(view.identityInspection.state) && <p role="alert" style={{ margin: 12 }}>
      原生身份需要核对：{view.identityInspection.reason}{view.identityInspection.nativeId && view.identityInspection.nativeId !== view.nativeId ? ` · 观测到 ${view.identityInspection.nativeId}` : ''}
    </p>}
    {view.permissionSummary && <p style={{ margin: '0 12px 8px', fontSize: 12 }}>原生命令权限：{view.permissionSummary}</p>}
    {gap && <p role="status" style={{ margin: 12 }}>仅恢复最近的终端输出，较早内容已超出回放窗口。</p>}
    {view.outputTruncated && <p role="alert" style={{ margin: 12 }}>输出达到保留上限，日志已截断；请检查进程终态并下载现有日志。</p>}
    {(error || view.error) && <p role="alert" style={{ margin: 12 }}>{error || view.error}</p>}
    <div ref={mount} style={{ height: 'min(60vh, 560px)', minHeight: 260, padding: 8, background: '#11151b' }} />
  </section>;
}
