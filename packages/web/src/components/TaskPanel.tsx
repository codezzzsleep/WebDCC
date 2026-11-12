import { useState } from 'react';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';
import { agentText } from '../lib/agents.js';
import { Icon, Spinner } from './Icon.js';

const GOAL_STATUS: Record<string, string> = {
  active: '进行中',
  completed: '已完成',
  paused: '已暂停',
  cleared: '已清除',
};

/**
 * 输入框上方的任务条（DSH 的"任务"位置）。三家用同一个位置，内容是各自原生的：
 * DSH 的任务清单、Claude 的任务、Codex 的计划（turn/plan/updated）显示为"任务"；Codex 的目标显示为"目标"。
 */
export function TaskPanel({ sessionId }: { sessionId: string }): React.ReactElement | null {
  useStoreVersion();
  const [planOpen, setPlanOpen] = useState(false);
  const session = store.getSession(sessionId);
  const turns = store.getTurns(sessionId);
  const plan = [...turns].reverse().find((turn) => turn.plan !== undefined)?.plan;
  const goalData = [...turns].reverse().find((turn) => turn.goal !== undefined)?.goal;
  const showGoal = goalData !== undefined && goalData.status !== 'cleared' && goalData.objective !== '';
  if (plan === undefined && !showGoal) return null;

  const agentName = agentText(session?.agent ?? '').name;
  const items = plan ?? [];
  const done = items.filter((item) => item.status === 'completed').length;
  const doing = items.filter((item) => item.status === 'in_progress').length;

  return (
    <>
      {showGoal && goalData !== undefined ? (
        <div className="task-bar" data-testid="goal-panel">
          <div className="task-bar-head" style={{ cursor: 'default' }}>
            <Icon name="target" size={15} />
            <strong>目标</strong>
            <span className="summary">
              {goalData.objective} · {GOAL_STATUS[goalData.status] ?? goalData.status}
            </span>
            <span className="origin">{agentName} 的目标</span>
          </div>
        </div>
      ) : null}
      {plan !== undefined ? (
        <div className="task-bar" data-testid="plan-panel">
          <button type="button" className="task-bar-head" onClick={() => setPlanOpen((value) => !value)} aria-expanded={planOpen}>
            <Icon name="listChecks" size={15} />
            <strong>任务</strong>
            <span className="summary">
              {done} 已完成 · {doing} 进行中 · {items.length - done - doing} 待处理
            </span>
            <span className="origin">{agentName}</span>
            <Icon name={planOpen ? 'chevronDown' : 'chevronUp'} size={14} strokeWidth={2} />
          </button>
          {planOpen ? (
            <ul className="task-items">
              {items.map((item, index) => (
                <li key={index} className={item.status}>
                  {item.status === 'completed' ? (
                    <Icon name="check" size={14} strokeWidth={2.2} />
                  ) : item.status === 'in_progress' ? (
                    <Spinner size={13} />
                  ) : (
                    <Icon name="more" size={14} />
                  )}
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
