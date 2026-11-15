import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { CapabilitySnapshot } from '@webdcc/protocol';
import { api } from '../lib/api.js';
import { agentText } from '../lib/agents.js';

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
  return <main className="main"><div className="home"><div className="home-inner">
    <div className="row-actions"><h1>原生能力</h1><button className="btn" onClick={refresh} disabled={loading}>{loading ? '正在检查…' : '重新检查'}</button><Link to="/settings/providers">Agent 与 Provider</Link></div>
    <p>这里列出目标版本的原生能力及当前接入状态。能力组中的全部操作完成验收后，才会标记为已验证。</p>
    {error ? <p role="alert" className="error-card">{error}</p> : null}
    {snapshot?.runtimes.map(runtime => <p key={runtime.agent}><strong>{agentText(runtime.agent).name}</strong> · {runtime.probe.version ?? '版本未知'} · {runtime.compatibility === 'compatible' ? '版本匹配' : runtime.compatibility === 'test-only' ? '测试运行时' : '版本尚未确认或不兼容'} · 插件配置{runtime.pluginStatus === 'verified' ? '已验证' : '待核对'}</p>)}
    <label>搜索能力<input className="text-input" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {snapshot?.capabilities.filter(capability => `${capability.title} ${capability.agent} ${capability.methods.join(' ')}`.toLowerCase().includes(query.toLowerCase())).map(capability => <details key={capability.id}>
      <summary>{agentText(capability.agent).name} · {capability.title} · {capability.structuredVerified || capability.fallbackVerified ? '已验证' : capability.structuredImplemented ? '待验收' : '待实现'}</summary>
      <p>{capability.reason}</p><p>原生可用性：{capability.nativeAvailability} · 接口：{capability.apiExposure}</p>
      <ul>{capability.methods.map(method => <li key={method}><code>{method}</code></li>)}</ul>
    </details>)}
  </div></div></main>;
}
