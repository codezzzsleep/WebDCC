import type { EventData } from '@webdcc/protocol';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';

const STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  completed: '已完成',
  paused: '已暂停',
  cleared: '已清除',
};

/** 目标面板：Codex 用"目标"代替任务清单（SPEC-M8 Q2 / AG-codex-04） */
export function GoalPanel({ sessionId }: { sessionId: string }): React.ReactElement | null {
  useStoreVersion();
  const goal = [...store.getEvents(sessionId)].reverse().find((event) => event.kind === 'goal');
  if (goal === undefined) return null;
  const data = goal.data as EventData['goal'];
  if (data.status === 'cleared' || data.objective === '') return null;
  return (
    <div className="goal-panel" data-testid="goal-panel">
      <div className="goal-title">目标 · {STATUS_LABEL[data.status] ?? data.status}</div>
      <div className="goal-objective">{data.objective}</div>
    </div>
  );
}
