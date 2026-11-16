import { claudeTaskKey, claudeTaskStatusLabel, claudeTaskTree, type ClaudeTaskNode, type ClaudeTaskRun, type ClaudeTaskViews } from '@webdcc/protocol';
import { Icon } from './Icon.js';

function TaskOutput({ run }: { run: ClaudeTaskRun }): React.ReactElement {
  return <>
    {run.summary === undefined ? null : <p className="claude-task-summary">{run.summary}</p>}
    {run.error === undefined ? null : <pre className="output" role="status">{run.error}</pre>}
    {run.outputFile === undefined ? null : <p className="claude-task-source">输出文件：<code>{run.outputFile}</code></p>}
    {run.resourceLinks?.map((value, index) => {
      const resource = value !== null && typeof value === 'object' ? value as { name?: unknown; uri?: unknown } : {};
      return typeof resource.uri === 'string' ? <p className="claude-task-source" key={index}>输出资源：{typeof resource.name === 'string' ? resource.name : ''} <code>{resource.uri}</code></p> : null;
    })}
    {run.outputs.map(output => <div className="claude-task-output" key={output.itemKey} data-testid="claude-task-output">
      <small>{output.kind === 'reasoning' ? '任务思考' : output.kind === 'assistant.message' ? '任务输出' : '任务工具'}
        {output.live ? ' · 正在输出' : output.incomplete ? ' · 已保留部分输出' : ''}</small>
      <pre className="output">{output.text}</pre>
    </div>)}
  </>;
}

function TaskNode({ node }: { node: ClaudeTaskNode }): React.ReactElement {
  const task = node.task;
  return <li className="claude-task-node" data-testid="claude-task" data-task-id={task.taskId} data-run-id={task.runId ?? ''}>
    <details open>
      <summary><strong>{task.description || task.taskId}</strong><span className={`claude-task-status ${task.status}`}>{claudeTaskStatusLabel(task.status)}</span>
        {task.ambient ? <small>后台维护</small> : null}</summary>
      <p className="claude-task-source">任务：<code>{task.taskId}</code> · 本次运行：<code>{task.runId ?? '待确认'}</code>
        {task.parentTaskId === undefined ? null : <> · 父任务：<code>{task.parentTaskId}</code></>}
        {task.subagentType === undefined ? null : <> · {task.subagentType}</>}
      </p>
      {task.status !== 'unknown' ? null : <p role="status">{task.backgroundPresence === 'present' ? '任务在后台，当前状态待确认。'
        : task.backgroundPresence === 'absent' ? '当前后台列表未列出此任务，结果待确认。' : '尚未收到当前任务状态。'}</p>}
      <TaskOutput run={task} />
      {task.previousRuns.length === 0 ? null : <details className="claude-task-history"><summary>先前运行（{task.previousRuns.length}）</summary>
        {task.previousRuns.map(run => <div key={claudeTaskKey(run)} data-testid="claude-task-prior-run">
          <p>运行：<code>{run.runId ?? '待确认'}</code> · {claudeTaskStatusLabel(run.status)}</p><TaskOutput run={run} />
        </div>)}
      </details>}
    </details>
    {node.children.length === 0 ? null : <ul className="claude-task-children">{node.children.map(child => <TaskNode key={claudeTaskKey(child.task)} node={child} />)}</ul>}
  </li>;
}

export function ClaudeTaskPanel({ view }: { view: ClaudeTaskViews }): React.ReactElement | null {
  if (view.tasks.length === 0 && view.unassignedOutputs.length === 0) return null;
  const active = view.tasks.filter(task => !task.ambient && task.status === 'running').length;
  const completed = view.tasks.filter(task => task.status === 'completed').length;
  return <section className="task-bar claude-tasks" aria-label="Claude 任务" data-testid="claude-tasks-panel">
    <details><summary className="task-bar-head"><Icon name="tool" size={15} /><strong>Claude 任务</strong>
      <span className="summary">{active} 运行中 · {completed} 已完成 · {view.tasks.length} 总计</span>
    </summary><div className="claude-task-body">
    <ul className="claude-task-list">{claudeTaskTree(view.tasks).map(node => <TaskNode key={claudeTaskKey(node.task)} node={node} />)}</ul>
    {view.unassignedOutputs.length === 0 ? null : <details open data-testid="claude-task-unassigned"><summary>子任务输出（任务身份待确认）</summary>
      {view.unassignedOutputs.map(output => <div key={output.itemKey}><p className="claude-task-source">来源工具：<code>{output.origin.parentToolUseId}</code></p>
        <pre className="output">{output.text}</pre></div>)}
    </details>}
    </div></details>
  </section>;
}
