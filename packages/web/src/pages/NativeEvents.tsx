import { useEffect, useRef, useState } from 'react';
import type { NativeEnvelopeDetail, NativeEnvelopeSummary, NativeOwnerDto, StoredEvent } from '@webdcc/protocol';
import { api } from '../lib/api.js';

const disposition: Record<string, string> = { accepted: '已处理', observed: '已接收', 'outgoing-attempt': '提交请求',
  'stale-owner': '旧实例记录', 'stale-generation': '旧代际已忽略', 'source-mismatch': '其他实例已忽略',
  'duplicate-projection': '重复记录已过滤', unowned: '未关联运行实例' };

export function NativeEventsPage({ initialSessionId = '' }: { initialSessionId?: string }): React.ReactElement {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [filter, setFilter] = useState(initialSessionId);
  const [records, setRecords] = useState<NativeEnvelopeSummary[]>([]);
  const [next, setNext] = useState(0);
  const [detail, setDetail] = useState<NativeEnvelopeDetail>();
  const [owner, setOwner] = useState<NativeOwnerDto | null>(null);
  const [sequence, setSequence] = useState('');
  const [webEvent, setWebEvent] = useState<StoredEvent>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const detailRequest = useRef(0);
  const pageRequest = useRef(0);
  useEffect(() => { setSessionId(initialSessionId); setFilter(initialSessionId); }, [initialSessionId]);
  useEffect(() => {
    pageRequest.current++; detailRequest.current++;
    let cancelled = false;
    setBusy(true); setError(''); setDetail(undefined); setOwner(null); setWebEvent(undefined);
    void Promise.all([api.nativeEvents(filter), filter ? api.runtime(filter).catch(() => ({ owner: null })) : Promise.resolve({ owner: null })])
      .then(([page, runtime]) => { if (!cancelled) { setRecords(page.records); setNext(page.next); setOwner(runtime.owner); } })
      .catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; pageRequest.current++; detailRequest.current++; };
  }, [filter, revision]);
  const show = async (id: number): Promise<void> => {
    const request = ++detailRequest.current;
    try { const value = await api.nativeEvent(id); if (request === detailRequest.current) setDetail(value); }
    catch (failure) { if (request === detailRequest.current) setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const more = async (): Promise<void> => {
    const request = pageRequest.current;
    setBusy(true);
    try { const page = await api.nativeEvents(filter, next); if (request === pageRequest.current) { setRecords(previous => [...previous, ...page.records]); setNext(page.next); } }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (request === pageRequest.current) setBusy(false); }
  };
  const locate = async (): Promise<void> => {
    const request = ++detailRequest.current;
    try { const value = await api.eventEvidence(filter, Number(sequence)); if (request === detailRequest.current) { setWebEvent(value.event); setDetail(value.envelope ?? undefined); } }
    catch (failure) { if (request === detailRequest.current) setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  return <main className="main" style={{ padding: 24, overflow: 'auto' }}>
    <h1>原生记录</h1>
    <p>查看原始接口记录和适配后的事件。敏感内容会被省略；缺少原始记录时会保留缺失状态。</p>
    <form onSubmit={event => { event.preventDefault(); if (busy) return; setFilter(sessionId.trim()); setRevision(value => value + 1); }} style={{ display: 'flex', gap: 8 }}>
      <input className="text-input" aria-label="会话 ID" placeholder="会话 ID，留空查看全部" value={sessionId} onChange={event => setSessionId(event.target.value)} />
      <button className="btn" disabled={busy} type="submit">刷新</button>
    </form>
    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><input className="text-input" aria-label="Web 事件序号" inputMode="numeric" value={sequence} onChange={event => setSequence(event.target.value)} placeholder="Web 事件序号" />
      <button className="btn" disabled={!filter || !/^\d+$/.test(sequence) || Number(sequence) < 1} onClick={() => { void locate(); }}>定位事件</button></div>
    {webEvent === undefined ? null : <section aria-label="Web 事件详情"><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(webEvent, null, 2)}</pre>
      {detail === undefined ? <p>未关联原生信封。本地生成事件和旧版本记录可能没有原始接口证据。</p> : null}</section>}
    {owner === null ? null : <details><summary>运行实例：{owner.state}</summary><pre>{JSON.stringify(owner, null, 2)}</pre><p>此记录仅覆盖 WebDCC 管理的连接。外部原生客户端由原生系统仲裁。</p></details>}
    {error ? <p role="alert">{error}</p> : null}
    {busy ? <p role="status">正在读取…</p> : null}
    <table><thead><tr><th>ID</th><th>接口</th><th>来源</th><th>状态</th><th>代际</th></tr></thead>
      <tbody>{records.map(record => <tr key={record.id}><td><button className="btn" onClick={() => { void show(record.id); }}>{record.id}</button></td>
        <td>{record.channel}</td><td>{record.source === 'transport' ? '原始接口' : '适配记录'}</td><td>{disposition[record.disposition] ?? record.disposition}</td><td>{record.generation ?? '未记录'}</td></tr>)}</tbody></table>
    {records.length === 0 && !busy ? <p>没有记录。旧版本的事件可能没有原始接口证据。</p> : null}
    <button className="btn" disabled={busy || records.length === 0} onClick={() => { void more(); }}>下一页</button>
    {detail === undefined ? null : <section aria-label="记录详情"><h2>记录 {detail.id}</h2>
      {detail.payloadCoverage === 'restricted' ? <p>敏感内容已省略。</p> : detail.payloadCoverage === 'oversize' ? <p>内容超过记录限额，原始接口证据不完整。</p> : null}
      {detail.rawEnvelopeId === null ? detail.source === 'mapping' ? <p>没有关联的原始接口记录。</p> : null : <button className="btn" onClick={() => { void show(detail.rawEnvelopeId!); }}>查看原始接口记录</button>}
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(detail, null, 2)}</pre>
    </section>}
  </main>;
}
