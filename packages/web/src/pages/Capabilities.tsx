import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { CapabilitySnapshot } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { agentText } from '../lib/agents.js';

const compatibilityText = { compatible: '版本兼容', incompatible: '版本不兼容', unknown: '版本尚未确认', 'test-only': '测试运行时' };

export function CapabilitiesPage(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const refresh = (): void => {
    setLoading(true);
    void api.capabilities().then(value => { setSnapshot(value); setError(''); }).catch(cause => setError(String(cause))).finally(() => setLoading(false));
  };
  useEffect(refresh, []);
  return <main className="main"><div className="settings"><div className="settings-inner">
    <Link to="/settings/diagnostics" className="btn small ghost">返回诊断与排查</Link>
    <div className="row-actions"><h1>原生能力</h1><button className="btn" onClick={refresh} disabled={loading}>{loading ? '正在检查…' : '重新检查'}</button></div>
    <p>用于开发与验收的 Harness 功能接入清单。这里列出目标版本的接口及登记状态，部分状态仍待核验。</p>
    {error ? <p role="alert" className="error-card">{error}</p> : null}
    {snapshot?.runtimes.map(runtime => <p key={runtime.agent}><strong>{agentText(runtime.agent).name}</strong> · {runtime.probe.version ?? '版本未知'} · {compatibilityText[runtime.compatibility]} · 插件配置{runtime.pluginStatus === 'verified' ? '已验证' : '待核对'}</p>)}
    {snapshot?.runtimes.map(runtime => runtime.runtimeContext === undefined ? null : <p key={`${runtime.agent}-context`}>
      {agentText(runtime.agent).name} · Host {runtime.hostId.slice(0, 12)} · {runtime.runtimeContext.status === 'observed' ? '已观察原生发布清单' : '发布清单未确认'}
      {' · '}profile：{runtime.runtimeContext.profile.status === 'unavailable-in-api' ? '原生未提供标识' : runtime.runtimeContext.profile.identity ?? '待核验'}
      {' · '}OS：{runtime.os === 'unknown' ? '原生未提供' : runtime.os}
    </p>)}
    <label>搜索能力<input className="text-input" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {snapshot?.capabilities.filter(capability => `${capability.title} ${capability.agent} ${capability.methods.join(' ')}`.toLowerCase().includes(query.toLowerCase())).map(capability => <details key={capability.id}>
      <summary>{agentText(capability.agent).name} · {capability.title} · {capability.structuredVerified || capability.fallbackVerified ? '已验证' : capability.structuredImplemented ? '已接入，待验证' : '接入范围待核实'}</summary>
      <p>{capability.reason}</p><p>原生可用性：{capability.nativeAvailability} · 接口：{capability.apiExposure}</p>
      <ul>{capability.methods.map(method => <li key={method}><code>{method}</code></li>)}</ul>
    </details>)}
  </div></div></main>;
}
