import { useEffect, useRef, useState } from 'react';
import { claudeTaskKey, type ClaudeTask, type NativeActionReceipt, type NativeControlSnapshot } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { claudeTaskStopSupported, object, readClaudeTaskControls } from '../lib/claude-task-controls.js';

export function ClaudeTaskStop({ sessionId, task, snapshot }: { sessionId: string; task: ClaudeTask; snapshot: NativeControlSnapshot | undefined }): React.ReactElement | null {
  const key = `${sessionId}:${claudeTaskKey(task)}`;
  const current = useRef(key); current.current = key;
  const [operation, setOperation] = useState<{ key: string; commandId: string; receipt?: NativeActionReceipt }>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setError(''); setBusy(false);
    let commandId: string | null = null;
    try { commandId = sessionStorage.getItem(`claude-task-stop:${key}`); } catch { /* Optional identity recovery. */ }
    if (commandId !== null) {
      const id = commandId;
      void api.nativeActionReceipt(sessionId, id).then(receipt => { if (live) setOperation({ key, commandId: id, receipt }); }).catch(() => undefined);
    }
    return () => { live = false; };
  }, [sessionId, key, task.terminalNotification]);
  const activeOperation = operation?.key === key ? operation : undefined;
  const requested = activeOperation?.receipt?.state;
  const knownTask = Array.isArray(object(snapshot?.state)['tasks']) ? (object(snapshot?.state)['tasks'] as unknown[]).map(object)
    .find(value => value['taskId'] === task.taskId && (value['runId'] ?? null) === (task.runId ?? null)) : undefined;
  const allowed = claudeTaskStopSupported(snapshot) && knownTask !== undefined && ['pending', 'running', 'paused'].includes(String(knownTask['status']))
    && ['pending', 'running', 'paused'].includes(task.status);
  const stop = async (): Promise<void> => {
    if (busy || !allowed) return;
    const captured = key; const commandId = crypto.randomUUID();
    setBusy(true); setError('');
    try {
      const fresh = await readClaudeTaskControls(sessionId);
      if (current.current !== captured) return;
      const state = object(fresh.state);
      const actual = Array.isArray(state['tasks']) ? state['tasks'].map(object).find(value => value['taskId'] === task.taskId) : undefined;
      if (!claudeTaskStopSupported(fresh) || actual === undefined || (actual['runId'] ?? null) !== (task.runId ?? null)
        || !['pending', 'running', 'paused'].includes(String(actual['status'])) || typeof state['revision'] !== 'string') throw new Error('原生任务身份或状态已改变，请核对后重试');
      try { sessionStorage.setItem(`claude-task-stop:${captured}`, commandId); } catch { /* The server receipt still survives. */ }
      setOperation({ key: captured, commandId });
      const response = await api.nativeAction(sessionId, { commandId, revision: state['revision'], action: { type: 'stop-task', taskId: task.taskId, runId: task.runId ?? null } });
      if (current.current !== captured) return;
      setOperation({ key: captured, commandId, receipt: response.receipt });
    } catch (failure) {
      if (current.current !== captured) return;
      setError(failure instanceof Error ? failure.message : '停止结果待确认');
      await api.nativeActionReceipt(sessionId, commandId).then(receipt => { if (current.current === captured) setOperation({ key: captured, commandId, receipt }); }).catch(() => undefined);
    } finally { if (current.current === captured) setBusy(false); }
  };
  if (!claudeTaskStopSupported(snapshot) && activeOperation === undefined) return null;
  return <div className="claude-task-stop">
    {task.status === 'completed' || task.status === 'failed' || task.status === 'stopped' ? null : <button type="button" className="btn small" disabled={!allowed || busy || requested !== undefined && requested !== 'failed'} onClick={() => { void stop(); }}>停止此任务</button>}
    {activeOperation?.receipt === undefined ? null : <p role="status" data-testid="claude-task-stop-receipt">
      {activeOperation.receipt.callReturnedAt === undefined ? '调用返回尚未确认' : '调用已返回'} · {requested === 'completed' ? '原生停止已确认'
        : requested === 'failed' ? '执行前已拒绝' : requested === 'uncertain' ? '停止终态待核对' : '等待原生停止通知'}
    </p>}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
