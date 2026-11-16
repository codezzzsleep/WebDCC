import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';

export function OlderHistoryRecovery({ sessionId }: { sessionId: string }): React.ReactElement | null {
  useStoreVersion();
  const state = store.getOlderHistoryState(sessionId);
  if (state.phase !== 'error') return null;
  return <div className="timeline-inner notice-card" role="alert" data-testid="older-history-recovery">
    <span>{state.error}</span>{' '}
    <button type="button" className="btn" onClick={() => { void store.loadOlder(sessionId); }}>重新加载历史</button>
  </div>;
}
