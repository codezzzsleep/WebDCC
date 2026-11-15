import { Link } from '@tanstack/react-router';
import { Icon } from '../components/Icon.js';
import { store } from '../lib/store.js';

export function DiagnosticsPage(): React.ReactElement {
  return <main className="main" data-testid="diagnostics-page">
    <div className="mobile-only session-header"><div className="session-header-row"><button type="button" className="icon-btn drawer-toggle" aria-label="会话列表" onClick={() => store.setDrawer(true)}><Icon name="menu" size={18} /></button></div></div>
    <div className="settings"><div className="settings-inner">
      <div><Link to="/settings/providers" className="btn small ghost"><Icon name="arrowLeft" size={14} />返回设置</Link><h1>诊断与排查</h1><p className="lead">遇到报错、连接异常或历史同步问题时，在这里查看后台记录和功能接入情况。</p></div>
      <section className="panel panel-pad">
        <h2>运行记录</h2>
        <p className="muted">查看 Harness 的后台请求、返回事件和处理结果，可按会话筛选并定位问题。</p>
        <div className="row-actions"><Link to="/settings/native-events" search={{ sessionId: undefined }} className="btn"><Icon name="history" />查看运行记录</Link></div>
      </section>
      <section className="panel panel-pad">
        <h2>功能接入清单</h2>
        <p className="muted">用于开发与验收，查看各 Harness 的版本、接口清单和接入证据。部分状态仍待核验。</p>
        <div className="row-actions"><Link to="/settings/capabilities" className="btn"><Icon name="listChecks" />查看功能接入清单</Link></div>
      </section>
    </div></div>
  </main>;
}
