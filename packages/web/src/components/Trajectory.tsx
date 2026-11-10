import { useState } from 'react';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';

interface TrajectoryProps {
  sessionId: string;
  onJump: (seq: number) => void;
}

export function Trajectory({ sessionId, onJump }: TrajectoryProps): React.ReactElement {
  useStoreVersion();
  const [query, setQuery] = useState('');
  const events = store.getEvents(sessionId).filter((event) => query === '' || event.kind.includes(query) || event.itemKey.includes(query));
  return (
    <div className="trajectory" data-testid="trajectory">
      <div className="trajectory-search">
        <input className="text-input" placeholder="搜索类型或 itemKey" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <div className="trajectory-list">
        {events.map((event) => (
          <button key={event.seq} type="button" className="trajectory-row" onClick={() => onJump(event.seq)}>
            <span className="seq">{event.seq}</span>
            <span className="time">{new Date(event.at).toLocaleTimeString('zh-CN')}</span>
            <span className={`kind kind-${event.kind}`}>{event.kind}</span>
            <span className="item">{event.itemKey}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
