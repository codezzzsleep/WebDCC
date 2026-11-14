import { useEffect, useRef, useState } from 'react';
import { NativeTerminal, nativeSurfaceRequest, type NativeTerminalInfo } from './NativeTerminal.js';

export function NativeSurface({ sessionId, agent, takeover }: {
  sessionId: string;
  agent: 'codex' | 'claude-code';
  takeover?: { allowed: boolean; reason: string };
}) {
  const [terminals, setTerminals] = useState<NativeTerminalInfo[]>([]);
  const [recordOutput, setRecordOutput] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const currentSession = useRef(sessionId); currentSession.current = sessionId;
  useEffect(() => {
    let cancelled = false;
    setTerminals([]); setError(''); setPending(false);
    void nativeSurfaceRequest<{ terminals: NativeTerminalInfo[] }>(`/api/native-terminal?sessionId=${encodeURIComponent(sessionId)}`).then(result => { if (!cancelled) setTerminals(result.terminals); }).catch(failure => { if (!cancelled) setError(failure instanceof Error ? failure.message : '原生终端读取失败'); });
    return () => { cancelled = true; };
  }, [sessionId]);
  const open = async (intent: 'new-native' | 'same-session'): Promise<void> => {
    setPending(true); setError('');
    try {
      const terminal = await nativeSurfaceRequest<NativeTerminalInfo>('/api/native-terminal', { method: 'POST', body: JSON.stringify({ commandId: crypto.randomUUID(), sessionId, intent, recordOutput }) });
      if (currentSession.current === sessionId) setTerminals(values => [...values.filter(value => value.id !== terminal.id), terminal]);
    } catch (failure) { if (currentSession.current === sessionId) setError(failure instanceof Error ? failure.message : '原生终端启动失败'); }
    finally { if (currentSession.current === sessionId) setPending(false); }
  };
  return <section aria-label="原生 CLI" style={{ padding: 16, display: 'grid', gap: 12 }}>
    <strong>{agent === 'codex' ? 'Codex' : 'Claude Code'} 原生 CLI</strong>
    <p style={{ margin: 0 }}>在浏览器中操作服务器上的原生终端。新建会话拥有独立历史；同会话接管需要确认原生身份、旧进程释放及历史与设置。</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      <button type="button" disabled={pending} onClick={() => { void open('new-native'); }}>创建新原生会话</button>
      <button type="button" disabled={pending || !takeover?.allowed} onClick={() => { void open('same-session'); }}>接管当前原生会话</button>
    </div>
    {!takeover?.allowed && <p role="status" style={{ margin: 0 }}>当前会话接管受阻：{takeover?.reason ?? '尚未验证旧 writer 与外部 writer 的释放。'}</p>}
    <label><input type="checkbox" checked={recordOutput} onChange={event => setRecordOutput(event.currentTarget.checked)} /> 临时保留日志供下载（可能含敏感内容，关闭终端时删除）</label>
    {error && <p role="alert">{error}</p>}
    {terminals.map(terminal => <NativeTerminal key={terminal.id} terminal={terminal} onChanged={next => setTerminals(values => values.map(value => value.id === next.id ? next : value))} onClosed={() => setTerminals(values => values.filter(value => value.id !== terminal.id))} />)}
  </section>;
}

export function NativeProcessSurface({ sessionId }: { sessionId: string }) {
  const [processes, setProcesses] = useState<NativeTerminalInfo[]>([]);
  const [argv, setArgv] = useState('["python3", "-i"]');
  const [recordOutput, setRecordOutput] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const currentSession = useRef(sessionId); currentSession.current = sessionId;
  useEffect(() => {
    let cancelled = false; setProcesses([]); setError(''); setPending(false);
    void nativeSurfaceRequest<{ processes: NativeTerminalInfo[] }>(`/api/native-process?sessionId=${encodeURIComponent(sessionId)}`).then(result => { if (!cancelled) setProcesses(result.processes); }).catch(failure => { if (!cancelled) setError(failure instanceof Error ? failure.message : '原生进程读取失败'); });
    return () => { cancelled = true; };
  }, [sessionId]);
  const start = async (): Promise<void> => {
    setPending(true); setError('');
    try {
      const command: unknown = JSON.parse(argv);
      if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== 'string')) throw new Error('请输入 JSON argv 数组，每个参数是一个字符串。');
      const process = await nativeSurfaceRequest<NativeTerminalInfo>('/api/native-process', { method: 'POST', body: JSON.stringify({ commandId: crypto.randomUUID(), sessionId, command, rows: 30, cols: 100, recordOutput }) });
      if (currentSession.current === sessionId) setProcesses(values => [...values.filter(value => value.id !== process.id), process]);
    } catch (failure) { if (currentSession.current === sessionId) setError(failure instanceof Error ? failure.message : '原生命令启动失败'); }
    finally { if (currentSession.current === sessionId) setPending(false); }
  };
  return <section aria-label="原生进程终端" style={{ padding: 16, display: 'grid', gap: 12 }}>
    <strong>原生进程终端</strong>
    <p style={{ margin: 0 }}>命令由 Agent 的原生执行服务运行。原生命令沙箱与当前会话权限核对一致后才能启动。</p>
    <label>命令 argv 数组<textarea value={argv} onChange={event => setArgv(event.currentTarget.value)} rows={3} style={{ display: 'block', width: '100%' }} /></label>
    <label><input type="checkbox" checked={recordOutput} onChange={event => setRecordOutput(event.currentTarget.checked)} /> 临时保留输出供下载（关闭时删除）</label>
    <button type="button" disabled={pending} onClick={() => { void start(); }}>启动原生命令</button>
    {error && <p role="alert">{error}</p>}
    {processes.map(process => <NativeTerminal key={process.id} terminal={process} endpoint="/api/native-process" onChanged={next => setProcesses(values => values.map(value => value.id === next.id ? next : value))} onClosed={() => setProcesses(values => values.filter(value => value.id !== process.id))} />)}
  </section>;
}
