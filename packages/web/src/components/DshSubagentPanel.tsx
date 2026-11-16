import { useEffect, useRef, useState } from 'react';
import type { DshSubagentCatalog, DshSubagentHistory, DshSubagentRecord, DshSubagentSummary } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { Icon, Spinner } from './Icon.js';
import { DshChildStop } from './DshChildStop.js';
import { DshChildComposer } from './DshChildComposer.js';
import { onDshSubagentOpen } from '../lib/dsh-subagent-navigation.js';
import './DshSubagentPanel.css';

const statusText: Record<DshSubagentSummary['status'], string> = {
  running: '运行中', waiting: '等待原生交互', pending: '输入排队中', idle: '空闲',
  completed: '最近一轮已完成', failed: '最近一轮失败', stopped: '最近一轮已停止', unknown: '状态待确认',
};
const modeText = { continuable: '可继续', 'one-shot': '一次性', external: '外部执行', unknown: '模式待确认' };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const textBlocks = (value: unknown, kind = 'text'): string => Array.isArray(value) ? value.flatMap(raw => {
  const block = object(raw); return block['type'] === kind && typeof block['text'] === 'string' ? [block['text']] : [];
}).join('\n') : '';

function restore(key: string): { open?: boolean; selected?: string } {
  try {
    const value = object(JSON.parse(sessionStorage.getItem(key) ?? '{}'));
    return { open: value['open'] === true, ...(typeof value['selected'] === 'string' ? { selected: value['selected'] } : {}) };
  }
  catch { return {}; }
}

/** One read surface for native direct children, independent of parent answers. */
export function DshSubagentPanel({ sessionId, nativeId }: { sessionId: string; nativeId?: string }): React.ReactElement {
  const storageKey = `wdcc:dsh-children:${sessionId}:${nativeId ?? ''}`;
  const [open, setOpen] = useState(() => restore(storageKey).open === true);
  const [selected, setSelected] = useState<string | undefined>(() => restore(storageKey).selected);
  const [catalog, setCatalog] = useState<DshSubagentCatalog>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => onDshSubagentOpen(target => {
    if (target.sessionId !== sessionId || target.parentSessionId !== nativeId) return;
    setSelected(target.childSessionId); setOpen(true); setRefresh(value => value + 1);
  }), [sessionId, nativeId]);

  useEffect(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify({ open, selected })); } catch { /* Native reads still work without browser storage. */ }
  }, [storageKey, open, selected]);

  useEffect(() => {
    if (!open) return;
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      if (!active) return;
      if (document.visibilityState === 'hidden') { timer = setTimeout(() => void read(), 5000); return; }
      setLoading(true);
      try {
        const result = await api.subagents(sessionId);
        if (!active) return;
        if (nativeId !== undefined && result.nativeId !== nativeId) throw new Error('父会话原生身份已变化，请重新打开');
        setCatalog(result); setError(undefined);
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (active) { setLoading(false); timer = setTimeout(() => void read(), 5000); } }
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [sessionId, nativeId, open, refresh]);

  const child = catalog?.items.find(item => item.childId === selected);
  return <section className="dsh-subagents" data-testid="dsh-subagents-panel">
    <button type="button" className="dsh-subagents-heading" onClick={() => setOpen(value => !value)} aria-expanded={open}>
      <Icon name="tool" size={15} /><strong>子 Agent</strong>
      {catalog === undefined ? null : <span className="muted">{catalog.items.length}</span>}
      <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} />
    </button>
    {open ? <div className="dsh-subagents-body">
      <div className="row-actions"><button type="button" className="btn small ghost" onClick={() => setRefresh(value => value + 1)} disabled={loading}>刷新子 Agent</button>{loading ? <Spinner size={14} /> : null}</div>
      {error === undefined ? null : <p role="alert">{error}。上次读取的内容暂未同步。</p>}
      {catalog?.items.length === 0 ? <p className="muted">原生父会话尚未记录子 Agent。</p> : null}
      {catalog?.items.map(item => <article className="dsh-child" key={item.childId} data-testid="dsh-child" data-child-id={item.childId} data-state={error === undefined ? item.status : 'unknown'}>
        <div className="dsh-child-heading"><strong>{item.name ?? item.label ?? item.childId}</strong><span role="status">{error === undefined ? statusText[item.status] : '状态待确认'}</span><span className="muted">{modeText[item.mode]}</span></div>
        {item.label === undefined || item.label === item.name ? null : <p>{item.label}</p>}
        {item.state?.active === false ? <p className="muted">原生当前未驻留；历史结果保留。</p> : null}
        {item.result === undefined ? null : <pre className="output">{item.result.text}</pre>}
        {item.error === undefined ? null : <p role="alert">{item.error}</p>}
        {item.lastTurn !== undefined && item.status === 'failed' ? <pre className="output">{JSON.stringify(item.lastTurn.reason, null, 2)}</pre> : null}
        <details><summary>原生身份</summary><p>子会话：{item.childId}<br />直接父会话：{item.parentSessionId}</p></details>
        {item.mode === 'external' ? null : <button type="button" className="btn small" disabled={error !== undefined} onClick={() => setSelected(item.childId)}>查看子会话 · {item.name ?? item.label ?? item.childId}</button>}
      </article>)}
      {selected !== undefined && catalog !== undefined && child === undefined ? <p role="alert">当前原生目录没有此子 Agent，无法确认其父子关系。</p> : null}
      {child !== undefined && child.mode !== 'external' && error === undefined ? <DshChildHistory key={`${sessionId}:${child.parentSessionId}:${child.childId}:${child.mode}`} sessionId={sessionId} child={child} onClose={() => setSelected(undefined)} /> : null}
    </div> : null}
  </section>;
}

function DshChildHistory({ sessionId, child, onClose }: { sessionId: string; child: DshSubagentSummary; onClose: () => void }): React.ReactElement {
  const [history, setHistory] = useState<DshSubagentHistory>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [older, setOlder] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);

  const accept = (result: DshSubagentHistory): void => {
    if (result.address.childSessionId !== child.childId || result.address.parentSessionId !== child.parentSessionId || result.address.mode !== child.mode)
      throw new Error('子会话读取身份不匹配');
  };
  useEffect(() => {
    if (older) return;
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      if (!active) return;
      if (document.visibilityState === 'hidden') { timer = setTimeout(() => void read(), 5000); return; }
      const expected = ++generation.current;
      setLoading(true);
      try {
        const result = await api.subagentHistory(sessionId, child.childId, { limit: 100 });
        if (!active || expected !== generation.current) return;
        accept(result); setHistory(result); setError(undefined);
      } catch (cause) { if (active && expected === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (active && expected === generation.current) { setLoading(false); timer = setTimeout(() => void read(), 5000); } }
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  // Identity changes unmount this component; refreshed catalog objects do not restart its native window.
  }, [sessionId, child.childId, child.parentSessionId, child.mode, older, refresh]);

  const loadOlder = async (): Promise<void> => {
    if (history?.hasMore !== true || history.nextCursor === undefined || loading) return;
    const current = history; const expected = ++generation.current;
    setOlder(true); setLoading(true);
    try {
      const result = await api.subagentHistory(sessionId, child.childId, { limit: 100, throughSeq: current.cursor, beforeSeq: current.nextCursor });
      if (!mounted.current || expected !== generation.current) return;
      accept(result);
      if (result.cursor !== current.cursor || result.records.at(-1)?.event.seq !== current.records[0]!.event.seq - 1) throw new Error('子会话较早历史存在未补齐的缺口');
      setHistory({ ...result, records: [...result.records, ...current.records] }); setError(undefined);
    } catch (cause) { if (mounted.current && expected === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current && expected === generation.current) setLoading(false); }
  };
  return <section className="dsh-child-history" data-testid="dsh-child-history" aria-label={`子会话 · ${child.name ?? child.label ?? child.childId}`}>
    <div className="dsh-child-heading"><strong>子会话 · {child.name ?? child.label ?? child.childId}</strong><button type="button" className="btn small ghost" onClick={onClose}>关闭子会话</button></div>
    <p className="muted">{older ? '当前保留固定历史窗口；查看最新会回到当前原生记录。' : '查看原生子会话；运行中的记录会自动更新。'}</p>
    <div className="row-actions"><button type="button" className="btn small ghost" disabled={loading} onClick={() => { setOlder(false); setRefresh(value => value + 1); }}>查看最新</button>{loading ? <Spinner size={14} /> : null}</div>
    {error === undefined ? null : <p role="alert">{error}。已读取的历史保留，当前未同步。</p>}
    {history?.hasMore ? <button type="button" className="btn small ghost" disabled={loading} onClick={() => void loadOlder()}>加载更早的子会话记录</button> : null}
    {history?.records.map(record => <DshHistoryRecord key={`${child.childId}:${record.event.seq}`} record={record} ownDescriptorSeq={history.ownDescriptorSeq} />)}
    {history?.records.length === 0 ? <p className="muted">原生子会话暂无记录。</p> : null}
    <DshChildComposer sessionId={sessionId} child={child} disabled={error !== undefined || history === undefined} onReadCurrent={() => { setOlder(false); setRefresh(value => value + 1); }} />
    <DshChildStop sessionId={sessionId} child={child} disabled={error !== undefined || history === undefined} onReadCurrent={() => { setOlder(false); setRefresh(value => value + 1); }} />
  </section>;
}

function DshHistoryRecord({ record, ownDescriptorSeq }: { record: DshSubagentRecord; ownDescriptorSeq?: number }): React.ReactElement | null {
  const { type, data: raw, seq } = record.event; const data = object(raw); const message = object(data['message']);
  const role = ownDescriptorSeq === undefined ? 'unverified' : seq < ownDescriptorSeq ? 'context' : 'child';
  if (type === 'user/message' || type === 'assistant/message') {
    const content = type === 'user/message' ? data['content'] : message['content'];
    const text = textBlocks(content); const reasoning = textBlocks(content, 'reasoning');
    if (text === '' && reasoning === '') return null;
    const source = object(data['source']); const kind = source['kind'];
    if (type === 'user/message' && kind !== 'user' && kind !== 'retry') return <details className="dsh-child-message" data-native-seq={seq} data-native-role={role}>
      <summary>{kind === 'runtime-context' ? '运行上下文' : kind === 'time-context' ? '时间上下文' : kind === 'agent' ? 'Agent 消息' : '原生上下文'}</summary><pre className="output">{text}</pre>
    </details>;
    return <article className="dsh-child-message" data-native-seq={seq} data-native-role={role}>
      <strong>{role === 'context' ? '已有上下文 · ' : ''}{type === 'user/message' ? '用户' : role === 'child' ? '子 Agent' : '会话中的助手'}</strong>
      {reasoning === '' ? null : <details><summary>思考</summary><pre className="output">{reasoning}</pre></details>}
      {text === '' ? null : <pre className="output">{text}</pre>}
    </article>;
  }
  if (type === 'tool/call' || type === 'tool/result') return <details className="dsh-child-message" data-native-seq={seq}>
    <summary>{type === 'tool/call' ? `工具 · ${String(data['name'] ?? '调用')}` : message['isError'] === true ? '工具执行失败' : '工具结果'}</summary>
    <pre className="output">{type === 'tool/call' ? String(data['arguments'] ?? '') : textBlocks(message['content'])}</pre>
    <small className="muted">调用：{String(data['callId'] ?? data['toolCallId'] ?? message['toolCallId'] ?? '')}</small>
  </details>;
  if (type === 'assistant/attempt') return <details className="dsh-child-message" data-native-seq={seq}><summary>失败尝试的部分输出</summary><pre className="output">{JSON.stringify(data['stream'], null, 2)}</pre></details>;
  if (type === 'turn/end') return <p className="muted" data-native-seq={seq}>原生轮次 {String(data['turn'] ?? '')} 结束 · {String(object(data['reason'])['kind'] ?? '原因待确认')}</p>;
  return null;
}
