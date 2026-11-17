import { useState } from 'react';
import { currentGoal, goalLabel, currentCodexSubagents, codexSubagentRecoveryText, codexSubagentStatusLabel, codexSubagentSnapshotKey, currentClaudeTaskViews } from '@webdcc/protocol';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';
import { agentText } from '../lib/agents.js';
import { Icon, Spinner } from './Icon.js';
import { ClaudeTaskPanel } from './ClaudeTaskPanel.js';

/**
 * 输入框上方的任务条（DSH 的"任务"位置）。三家用同一个位置，内容是各自原生的：
 * DSH 的任务清单、Claude 的任务、Codex 的计划显示为"任务"；原生会话目标显示为"目标"。
 */
export function TaskPanel({ sessionId }: { sessionId: string }): React.ReactElement | null {
  useStoreVersion();
  const [planOpen, setPlanOpen] = useState(false);
  const session = store.getSession(sessionId);
  const turns = store.getTurns(sessionId);
  const plan = [...turns].reverse().find((turn) => turn.plan !== undefined)?.plan;
  const goalData = currentGoal(store.getConversationEvents(sessionId));
  const showGoal = goalData !== undefined && goalData.status !== 'cleared' && goalData.objective !== '';
  const subagents = currentCodexSubagents(store.getConversationEvents(sessionId));
  const recoveryText = codexSubagentRecoveryText(turns.at(-1)?.state, subagents);
  const claudeView = currentClaudeTaskViews(session?.agent === 'claude-code' ? store.getEvents(sessionId) : [], session?.agent === 'claude-code' ? store.getHot(sessionId) : []);
  if (store.isViewingConversationHistory(sessionId) || plan === undefined && !showGoal && subagents.length === 0 && claudeView.tasks.length === 0 && claudeView.unassignedOutputs.length === 0) return null;

  const agentName = agentText(session?.agent ?? '').name;
  const items = plan ?? [];
  const done = items.filter((item) => item.status === 'completed').length;
  const doing = items.filter((item) => item.status === 'in_progress').length;

  return (
    <>
      <ClaudeTaskPanel sessionId={sessionId} view={claudeView} />
      {subagents.length > 0 ? <div className="task-bar" data-testid="codex-subagents-panel">
        <div className="task-bar-head"><Icon name="tool" size={15} /><strong>子任务</strong>
          <span className="summary">{subagents.filter(child => child.nativeStatus === 'completed').length} 已完成 · {subagents.length} 总计</span>
        </div>
        {recoveryText === undefined ? null : <p role="status">{recoveryText}</p>}
        {subagents.map(child => <details key={child.childId}>
          <summary>{child.agentPath ?? child.childId} · {codexSubagentStatusLabel(child.nativeStatus)}</summary>
          <p>原生线程：{child.childId}<br />父线程：{child.parentThreadId}</p>
          {child.results.map(result => <div key={JSON.stringify([result.nativeTurnId ?? null, result.itemId])} data-testid="codex-child-result"
            data-child-id={child.childId} data-native-turn-id={result.nativeTurnId} data-native-item-id={result.itemId}>
            {result.incomplete ? <p role="status">正文未完成</p> : null}
            <pre className="output">{result.text}</pre>
          </div>)}
          {child.snapshots?.map(snapshot => <details key={codexSubagentSnapshotKey(snapshot)} data-testid="codex-collab-observation"
            data-child-id={child.childId} data-native-call-id={snapshot.callId}>
            <summary>原生 {snapshot.tool} 观测 · {codexSubagentStatusLabel(snapshot.status)}</summary>
            <p>调用：{snapshot.callId} · {snapshot.callStatus}<br />来源线程：{snapshot.senderThreadId}<br />
              来源轮次：{snapshot.nativeTurnId ?? '原生未提供来源轮次'}</p>
            {snapshot.applied ? null : <p role="status">此调用的观测未用于当前子状态。</p>}
            {snapshot.message === null ? <p>原生没有返回正文</p> : <pre className="output" data-testid="codex-collab-message">{snapshot.message}</pre>}
          </details>)}
        </details>)}
      </div> : null}
      {showGoal && goalData !== undefined ? (
        <div className="task-bar" data-testid="goal-panel">
          <div className="task-bar-head" style={{ cursor: 'default' }}>
            <Icon name="target" size={15} />
            <strong>目标</strong>
            <span className="summary">
              {goalData.objective} · {goalLabel(goalData)}
            </span>
            {goalData.tokensUsed === undefined ? null : <span className="origin">用量 {goalData.tokensUsed.toLocaleString()}{goalData.tokenBudget == null ? '' : ` / ${goalData.tokenBudget.toLocaleString()}`} tok</span>}
            {goalData.roundsStarted === undefined ? null : <span className="origin" data-testid="goal-rounds">轮次 {goalData.roundsStarted}{goalData.maxGoalRounds === undefined ? '' : ` / ${goalData.maxGoalRounds}`}</span>}
            {goalData.blockedReason === undefined ? null : <span className="summary" data-testid="goal-block-reason">{goalData.blockedReason.message}</span>}
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
