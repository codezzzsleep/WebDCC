import type { EventData } from '@webdcc/protocol';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';

/** 任务面板：贴在输入框上方，显示最新一条 plan（SPEC 9.5） */
export function TaskPanel({ sessionId }: { sessionId: string }): React.ReactElement | null {
  useStoreVersion();
  const plan = [...store.getEvents(sessionId)].reverse().find((event) => event.kind === 'plan');
  if (plan === undefined) return null;
  const data = plan.data as EventData['plan'];
  const done = data.items.filter((item) => item.status === 'completed').length;
  const doing = data.items.filter((item) => item.status === 'in_progress').length;
  return (
    <div className="task-panel" data-testid="plan-panel">
      <div className="plan-title">
        任务 {done} 已完成 · {doing} 进行中 · {data.items.length - done - doing} 待处理
      </div>
      <ul>
        {data.items.map((item, index) => (
          <li key={index} className={item.status}>
            {item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
