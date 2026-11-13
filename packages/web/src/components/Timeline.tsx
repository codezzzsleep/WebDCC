import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { EventData, LiveItem, StoredEvent, TurnView as ProtocolTurnView, UsageData } from '@webdcc/protocol';
import { isValidEventData } from '@webdcc/protocol';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';
import { api } from '../lib/api.js';
import { duration, shortNumber } from '../lib/format.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { Icon, Spinner, type IconName } from './Icon.js';
import { Markdown, MarkdownWorkspace } from './Markdown.js';

function useTurns(sessionId: string): ProtocolTurnView[] {
  useStoreVersion();
  return useMemo(() => store.getTurns(sessionId), [sessionId, store.getVersion()]);
}

interface TimelineProps {
  sessionId: string;
  highlightSeq?: number;
  onOpenDiff: (fileId: string, path: string) => void;
  onHandoff: (text: string) => void;
  /** 停靠区里只读对照：不显示"带到…"等操作 */
  compact?: boolean;
}

export function Timeline({ sessionId, highlightSeq, onOpenDiff, onHandoff, compact = false }: TimelineProps): React.ReactElement {
  const turns = useTurns(sessionId);
  const hotCount = store.getHot(sessionId).length;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [stickToBottom, setStickToBottom] = useState(true);

  useEffect(() => {
    if (!performance.getEntriesByName('wdcc:first-turns').length && turns.length > 0) {
      performance.mark('wdcc:first-turns');
    }
  }, [turns.length]);

  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 260,
    overscan: 6,
  });

  useEffect(() => {
    if (stickToBottom && turns.length > 0) {
      virtualizer.scrollToIndex(turns.length - 1, { align: 'end' });
    }
  }, [turns.length, hotCount, stickToBottom, virtualizer]);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (element === null) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setStickToBottom(distance < 80);
    if (element.scrollTop < 40) void store.loadOlder(sessionId);
  };

  return (
    <MarkdownWorkspace.Provider value={store.getSession(sessionId)?.workspaceId}>
    <div className="timeline" ref={scrollRef} onScroll={onScroll} data-testid="timeline">
      <div className="timeline-inner" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const turn = turns[item.index];
          if (turn === undefined) return null;
          const isLast = item.index === turns.length - 1;
          const isExpanded = expanded[turn.turnId] ?? false;
          return (
            <div
              key={turn.turnId}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
            >
              <TurnView
                sessionId={sessionId}
                turn={turn}
                expanded={isExpanded}
                isLast={isLast}
                compact={compact}
                onToggle={() => setExpanded((prev) => ({ ...prev, [turn.turnId]: !isExpanded }))}
                highlightSeq={highlightSeq}
                onOpenDiff={onOpenDiff}
                onHandoff={onHandoff}
              />
            </div>
          );
        })}
      </div>
    </div>
    </MarkdownWorkspace.Provider>
  );
}

const INTERACTIVE_KINDS = new Set(['approval.request', 'question']);

function TurnView({
  sessionId,
  turn,
  expanded,
  isLast,
  compact,
  onToggle,
  highlightSeq,
  onOpenDiff,
  onHandoff,
}: {
  sessionId: string;
  turn: ProtocolTurnView;
  expanded: boolean;
  isLast: boolean;
  compact: boolean;
  onToggle: () => void;
  highlightSeq?: number;
  onOpenDiff: (fileId: string, path: string) => void;
  onHandoff: (text: string) => void;
}): React.ReactElement {
  const [cancelError, setCancelError] = useState('');
  const user = turn.user;
  const running = turn.state === 'starting' || turn.state === 'running' || turn.state === 'waiting';
  const steps = turn.steps;
  const answerKeys = new Set(turn.answer.map((answer) => answer.itemKey));
  const changes = turn.changes.map((change) => ({ ...change, ...(change.diffFileId === undefined ? {} : { fileId: change.diffFileId }) }));
  // 运行中、或用户展开时显示全部步骤；完成后默认只显示摘要和最终回答（DSH 的做法）
  const showAll = running || expanded;
  const waitingOnUser = turn.activity?.kind === 'waiting';
  const finalText = turn.answer.map((answer) => answer.text).join('\n');

  const headLabel =
    !['completed', 'interrupted', 'failed'].includes(turn.state)
      ? ''
      : `${turn.state === 'interrupted' ? '已中断' : turn.state === 'failed' ? '出错' : '已完成'}${turn.durationMs === undefined ? '' : `，用时 ${duration(turn.durationMs)}`}`;

  return (
    <section className={`turn ${running ? 'turn-running' : ''}`} id={turn.userSeq === undefined ? undefined : `e-${turn.userSeq}`}>
      {turn.pending !== undefined || user.text !== '' ? (
        <div className="user-message" data-testid="user-message">
          <div className="user-bubble">
            <Markdown text={user.text} />
          </div>
          <div className="user-meta">
            {turn.pending !== undefined || turn.commandState !== undefined ? <span className="outbox-status">{outboxLabel(turn.pending?.status ?? turn.commandState ?? 'pending')}</span> : null}
            {turn.pending?.status === 'queued' ? <button type="button" className="btn" onClick={() => { void store.cancelQueued(sessionId, turn.pending?.clientCommandId ?? '').catch(error => setCancelError(String(error))); }}>取消排队</button> : null}
            <span>{new Date(user.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          {cancelError ? <p role="alert">{cancelError}</p> : null}
        </div>
      ) : null}

      {turn.pending !== undefined ? null : (
        <div className="turn-header">
          {running ? (
            waitingOnUser ? (
              <span className="turn-title waiting" data-testid="turn-waiting">
                <Icon name="shield" size={14} />
                等你处理
              </span>
            ) : (
              <span className="turn-title running">
                <Spinner size={14} />
                <span className="shimmer">运行中…</span>
              </span>
            )
          ) : !running ? (
            <button type="button" className="turn-title" onClick={onToggle} aria-expanded={expanded}>
              {headLabel}
              <Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={14} strokeWidth={2} />
            </button>
          ) : null}
          <div className="turn-divider" />
        </div>
      )}

      <div className="turn-body">
        {!showAll && !running && steps.some((event) => !answerKeys.has(event.itemKey) && !INTERACTIVE_KINDS.has(event.kind)) ? (
          <button type="button" className="turn-summary" onClick={onToggle}>
            <Icon name="listChecks" size={15} />
            {summaryLabel(turn)}
          </button>
        ) : null}

        {showAll
          ? steps.map((event) => (
              <ErrorBoundary key={`${event.itemKey}-${event.seq}`} label="timeline-item">
                <StepRow event={event} highlight={highlightSeq === event.seq} onOpenDiff={onOpenDiff} />
              </ErrorBoundary>
            ))
          : steps
              .filter((event) => INTERACTIVE_KINDS.has(event.kind) || event.kind === 'error' || answerKeys.has(event.itemKey))
              .map((event) => (
                <ErrorBoundary key={`always-${event.itemKey}-${event.seq}`} label="timeline-item">
                  <StepRow event={event} highlight={highlightSeq === event.seq} onOpenDiff={onOpenDiff} />
                </ErrorBoundary>
              ))}

        {turn.live.map((item) => <HotRow key={item.itemKey} item={item} />)}

        {!running && changes.length > 0 ? <ChangesCard changes={changes} onOpenDiff={onOpenDiff} /> : null}

        {!running ? (
          <div className="turn-footer">
            {!compact && finalText !== '' ? (
              <>
                <button type="button" className="btn ghost" aria-label="复制回答" title="复制回答" onClick={() => void navigator.clipboard?.writeText(finalText)}>
                  <Icon name="copy" size={15} />
                </button>
                <button type="button" className="btn ghost" onClick={() => onHandoff(finalText)} title="把这条回答带到另一个会话">
                  <Icon name="forward" size={15} />
                  带到…
                </button>
              </>
            ) : null}
            {turn.state !== 'completed' ? (
              <span className={`turn-status ${turn.state}`}>{turn.state === 'interrupted' ? '已中断' : '出错'}</span>
            ) : null}
            {turn.usage !== undefined ? <span className="meta">{formatUsageData(turn.usage)}</span> : null}
            {isLast && turn.endedAt !== undefined ? (
              <span className="meta">{new Date(turn.endedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function summaryLabel(turn: ProtocolTurnView): string {
  const { commands, reads, edits, tools } = turn.summary;
  const parts: string[] = [];
  if (turn.plan !== undefined) parts.push('更新了计划');
  if (turn.goal !== undefined) parts.push('更新了目标');
  if (commands > 0) parts.push(`执行了 ${commands} 条命令`);
  if (reads > 0) parts.push(`读取了 ${reads} 个文件`);
  if (edits > 0) parts.push(`编辑了 ${edits} 个文件`);
  if (tools > 0) parts.push(`调用了 ${tools} 次工具`);
  return parts.length === 0 ? '查看过程' : parts.join('，');
}

function outboxLabel(status: 'pending' | 'queued' | 'sent' | 'failed' | 'uncertain'): string {
  if (status === 'uncertain') return '原生结果待核对，未自动重发';
  if (status === 'pending') return '待发送';
  if (status === 'queued') return '队列中';
  if (status === 'sent') return '已送达';
  return '发送失败';
}

function formatUsageData(data: UsageData): string {
  const parts: string[] = [];
  if (data.inputTokens !== undefined || data.outputTokens !== undefined) {
    parts.push(`输入 ${shortNumber(data.inputTokens ?? 0)} / 输出 ${shortNumber(data.outputTokens ?? 0)} tok`);
  }
  if (data.cacheReadInputTokens !== undefined) parts.push(`缓存读取 ${shortNumber(data.cacheReadInputTokens)} tok`);
  if (data.cacheCreationInputTokens !== undefined) parts.push(`缓存写入 ${shortNumber(data.cacheCreationInputTokens)} tok`);
  if (data.totalCostUsd !== undefined) parts.push(`SDK 估算 $${data.totalCostUsd.toFixed(4)}`);
  if (data.tokensPerSecond !== undefined) parts.push(`约 ${data.tokensPerSecond.toFixed(1)} tok/s`);
  if (data.cacheHitRatio !== undefined) parts.push(`缓存命中 ${Math.round(data.cacheHitRatio * 100)}%`);
  return parts.join(' · ');
}

interface ChangeSummary {
  path: string;
  added: number;
  removed: number;
  fileId?: string;
  note?: string;
}

function ChangesCard({ changes, onOpenDiff }: { changes: ChangeSummary[]; onOpenDiff: (fileId: string, path: string) => void }): React.ReactElement {
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);
  const notes = [...new Set(changes.map((change) => change.note).filter((note): note is string => note !== undefined))];
  return (
    <div className="changes-card" data-testid="changes-card">
      <div className="changes-head">
        <span className="file-tile">
          <Icon name="fileCode" size={16} />
        </span>
        <span className="title">
          已编辑 {changes.length} 个文件
          <span className="counts">
            <span className="added">+{added}</span> <span className="removed">-{removed}</span>
          </span>
        </span>
      </div>
      {changes.map((change) => (
        <button
          key={change.path}
          type="button"
          className="change-row"
          disabled={change.fileId === undefined}
          title={change.fileId === undefined ? '没有可显示的 diff' : '在右侧查看 diff'}
          onClick={() => change.fileId !== undefined && onOpenDiff(change.fileId, change.path)}
        >
          <span className="path">{change.path}</span>
          <span className="counts">
            <span className="added">+{change.added}</span> <span className="removed">-{change.removed}</span>
          </span>
        </button>
      ))}
      {notes.map((note) => (
        <div key={note} className="change-note">
          {note}
        </div>
      ))}
    </div>
  );
}

function HotRow({ item }: { item: LiveItem }): React.ReactElement {
  const data = item.data as { text?: string; command?: string; outputTail?: string };
  if (item.kind === 'assistant.message') {
    return <div className="hot-text">{data.text ?? ''}</div>;
  }
  if (item.kind === 'reasoning') {
    return (
      <div className="step-line">
        <Icon name="sparkle" size={15} />
        <span className="label shimmer">思考中…</span>
        {data.text === undefined || data.text === '' ? null : <span className="detail reasoning-live-text">{data.text}</span>}
      </div>
    );
  }
  return (
    <div className="step-row">
      <div className="step-line">
        <Spinner size={14} />
        <span className="label">{item.kind === 'command' ? '正在运行' : '进行中'}</span>
        {item.kind === 'command' ? <span className="detail">{data.command ?? ''}</span> : null}
      </div>
      {data.outputTail !== undefined && data.outputTail !== '' ? <pre className="output">{data.outputTail}</pre> : null}
    </div>
  );
}

function StepLine({
  icon,
  label,
  detail,
  onClick,
  open,
  failed,
}: {
  icon: IconName;
  label: string;
  detail?: string;
  onClick?: () => void;
  open?: boolean;
  failed?: boolean;
}): React.ReactElement {
  const inner = (
    <>
      <Icon name={icon} size={15} />
      <span className="label">{label}</span>
      {detail === undefined || detail === '' ? null : <span className="detail">{detail}</span>}
      {failed === true ? <span className="status-failed">失败</span> : null}
      {onClick === undefined ? null : <Icon name={open === true ? 'chevronUp' : 'chevronDown'} size={13} strokeWidth={2} />}
    </>
  );
  if (onClick === undefined) return <div className="step-line">{inner}</div>;
  return (
    <button type="button" className="step-line" onClick={onClick} aria-expanded={open === true}>
      {inner}
    </button>
  );
}

function StepRow({
  event,
  highlight,
  onOpenDiff,
}: {
  event: StoredEvent;
  highlight?: boolean;
  onOpenDiff: (fileId: string, path: string) => void;
}): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [subagentText, setSubagentText] = useState('');
  const [subagentBusy, setSubagentBusy] = useState(false);
  const className = `step-row ${highlight === true ? 'highlight' : ''}`;
  // 渲染前再校验一次：不合格的事件显示占位，而不是让组件崩掉（F2）
  if (!isValidEventData(event.kind, event.data)) {
    return <div className="render-fallback">这条内容无法显示 · 在轨迹中查看</div>;
  }
  const toggle = (): void => setOpen((value) => !value);

  switch (event.kind) {
    case 'assistant.message': {
      const data = event.data as EventData['assistant.message'];
      return (
        <div className={`${className} assistant`} id={`e-${event.seq}`} data-testid="assistant-message" data-raw-text={data.text}>
          <Markdown text={data.text} />
        </div>
      );
    }
    case 'reasoning': {
      const data = event.data as EventData['reasoning'];
      if (data.text.trim() === '') return null;
      return (
        <div className={className}>
          <StepLine icon="sparkle" label="思考" onClick={toggle} open={open} />
          {open ? <div className="step-detail">{data.text}</div> : null}
        </div>
      );
    }
    case 'command': {
      const data = event.data as EventData['command'];
      const failed = data.status === 'failed';
      return (
        <div className={className} id={`e-${event.seq}`}>
          <StepLine icon="terminal" label="运行命令" detail={data.label ?? data.command} onClick={toggle} open={open} failed={failed} />
          {open ? <pre className="output">{data.outputTail === undefined || data.outputTail === '' ? '（无输出）' : data.outputTail}</pre> : null}
        </div>
      );
    }
    case 'file.read': {
      const data = event.data as EventData['file.read'];
      return (
        <div className={className}>
          <StepLine icon="fileText" label="读取" detail={data.label ?? data.path} />
        </div>
      );
    }
    case 'file.change': {
      const data = event.data as EventData['file.change'];
      const first = data.changes[0];
      const detail =
        first === undefined ? '' : data.changes.length > 1 ? `${first.path} 等 ${data.changes.length} 个文件` : first.path;
      return (
        <div className={className}>
          <StepLine
            icon="edit"
            label="编辑"
            detail={detail}
            failed={data.status === 'failed'}
            {...(first?.diffFileId === undefined ? {} : { onClick: () => onOpenDiff(first.diffFileId ?? '', first.path) })}
          />
        </div>
      );
    }
    case 'tool.call': {
      const data = event.data as EventData['tool.call'];
      const toolInput = data.input as Record<string, unknown>;
      const childId = data.name === 'subagent' && typeof toolInput?.['childId'] === 'string' ? toolInput['childId'] : undefined;
      const canControlChild = childId !== undefined && toolInput?.['mode'] === 'continuable';
      const sendSubagent = async (): Promise<void> => {
        if (childId === undefined || subagentText.trim() === '') return;
        setSubagentBusy(true);
        try {
          await api.sendSubagent(event.sessionId, childId, subagentText);
          setSubagentText('');
        } finally {
          setSubagentBusy(false);
        }
      };
      const stopSubagent = async (): Promise<void> => {
        if (childId === undefined) return;
        setSubagentBusy(true);
        try {
          await api.interruptSubagent(event.sessionId, childId);
        } finally {
          setSubagentBusy(false);
        }
      };
      return (
        <div className={className}>
          <StepLine
            icon={data.name === 'ToolSearch' ? 'search' : data.name === 'WebFetch' || data.name === 'WebSearch' || data.name === 'web_search' ? 'globe' : 'tool'}
            label={data.label ?? data.name}
            detail={toolDetail(data.input)}
            onClick={toggle}
            open={open}
            failed={data.status === 'failed'}
          />
          {open ? (
            <pre className="output">
              {JSON.stringify(data.input, null, 2)}
              {data.output === undefined ? '' : `\n\n→ ${typeof data.output === 'string' ? data.output : JSON.stringify(data.output, null, 2)}`}
            </pre>
          ) : null}
          {canControlChild ? <div className="subagent-controls"><input className="text-input" value={subagentText} onChange={(event) => setSubagentText(event.target.value)} placeholder="给子 Agent 发送消息" disabled={subagentBusy} /><button type="button" className="btn small" onClick={() => void sendSubagent()} disabled={subagentBusy || subagentText.trim() === ''}>继续</button><button type="button" className="btn small ghost danger-text" onClick={() => void stopSubagent()} disabled={subagentBusy}>打断</button></div> : null}
        </div>
      );
    }
    case 'plan': {
      const data = event.data as EventData['plan'];
      return (
        <div className={className}>
          <StepLine icon="listChecks" label="更新了计划" detail={`${data.items.length} 项`} />
        </div>
      );
    }
    case 'goal': {
      const data = event.data as EventData['goal'];
      return (
        <div className={className}>
          <StepLine icon="target" label="更新了目标" detail={data.objective} />
        </div>
      );
    }
    case 'approval.request': {
      const data = event.data as EventData['approval.request'];
      return <ApprovalCard event={event} data={data} />;
    }
    case 'question': {
      const data = event.data as EventData['question'];
      return <QuestionCard event={event} data={data} />;
    }
    case 'notice': {
      const data = event.data as EventData['notice'];
      return (
        <div className="notice-card" data-testid="notice-card">
          <Icon name="alert" size={15} />
          <span>{data.text}</span>
        </div>
      );
    }
    case 'error': {
      const data = event.data as EventData['error'];
      return (
        <div className="error-card" data-testid="error-card" role="alert">
          <Icon name="alert" size={15} />
          <span>{data.message}</span>
        </div>
      );
    }
    case 'unknown': {
      const data = event.data as EventData['unknown'];
      return (
        <div className={className} data-testid="unknown-card">
          <StepLine icon="help" label="未知事件" detail={data.nativeType} onClick={toggle} open={open} />
          {open ? <pre className="output">{JSON.stringify(event.native ?? event.data, null, 2)}</pre> : null}
        </div>
      );
    }
    default:
      return null;
  }
}

function toolDetail(input: unknown): string {
  if (input === null || typeof input !== 'object') return typeof input === 'string' ? input : '';
  const record = input as Record<string, unknown>;
  for (const key of ['query', 'url', 'file_path', 'path', 'pattern', 'command', 'description', 'subject', 'prompt']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/** 从审批详情里取出最该让人看到的那一行：命令原文或文件路径 */
function approvalWhat(data: EventData['approval.request']): string {
  try {
    const parsed = JSON.parse(data.detail) as Record<string, unknown>;
    const input = (parsed['input'] ?? parsed['arguments'] ?? parsed) as Record<string, unknown>;
    for (const key of ['command', 'cmd', 'file_path', 'path', 'url']) {
      const value = input[key] ?? parsed[key];
      if (typeof value === 'string' && value !== '') return value;
      if (Array.isArray(value)) return value.join(' ');
    }
  } catch {
    // detail 不是 JSON：取第一行
  }
  return data.detail.split('\n')[0] ?? '';
}

function ApprovalCard({ event, data }: { event: StoredEvent; data: EventData['approval.request'] }): React.ReactElement {
  useStoreVersion();
  const submission = store.getInteractionSubmission(event.sessionId, 'approve', data.approvalId);
  const busy = submission !== undefined && ['pending', 'sent', 'uncertain'].includes(submission.status);
  // 处理过的审批要显示结果、不再显示按钮（F11 / F17）；结果也可能来自其他界面
  const resolution = [...store.getEvents(event.sessionId)]
    .reverse()
    .find((item) => item.kind === 'approval.resolved' && (item.data as EventData['approval.resolved']).approvalId === data.approvalId);
  const resolvedText = (() => {
    if (resolution === undefined) return null;
    const resolved = resolution.data as EventData['approval.resolved'];
    const option = resolved.optionId.toLowerCase();
    const result = ['allow', 'accept', 'acceptforsession', 'allowed-once', 'approved', 'approved_for_session', 'approve', 'allow-always', 'allowed-always'].includes(option)
      ? '已允许一次'
      : ['reject', 'rejected', 'deny', 'decline', 'declined', 'denied'].includes(option)
        ? '已拒绝'
        : ['cancelled', 'cancel', 'canceled', 'aborted'].includes(option)
          ? '已取消'
          : '已处理';
    return resolved.by === 'other' ? `已在其他界面处理：${result}` : result;
  })();
  const what = approvalWhat(data);
  const toolName = data.tool ?? data.title;

  if (resolvedText !== null) {
    return (
      <div className="approval-card resolved" data-testid="approval-card" data-state="resolved" data-tool={toolName} data-resolved="true" id={`e-${event.seq}`}>
        <Icon name="check" size={15} strokeWidth={2.2} />
        <span>{resolvedText}</span>
        {what === '' ? null : <span className="what">· {what}</span>}
      </div>
    );
  }
  return (
    <div className="approval-card" data-testid="approval-card" data-state="pending" data-tool={toolName} id={`e-${event.seq}`}>
      <div className="approval-title">
        <Icon name="shield" size={16} />
        {data.title}
      </div>
      {data.planMarkdown === undefined && what !== '' ? <div className="approval-command">{what}</div> : null}
      {data.reason === undefined || data.reason === '' ? null : <div className="approval-reason">{data.reason}</div>}
      {data.planMarkdown === undefined ? null : (
        <div className="approval-plan">
          <Markdown text={data.planMarkdown} />
        </div>
      )}
      <details className="approval-details">
        <summary>详情</summary>
        <pre className="output">{data.detail}</pre>
      </details>
      <InteractionStatus submission={submission} />
      <div className="approval-actions">
        {data.options.map((option, index) => {
          const deny = /deny|reject|decline|cancel/i.test(option.id);
          return (
            <button
              key={option.id}
              type="button"
              className={`btn ${index === 0 && !deny ? 'primary' : ''}`}
              disabled={busy}
              onClick={() => {
                store.approve(event.sessionId, data.approvalId, option.id);
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function InteractionStatus({ submission }: { submission: ReturnType<typeof store.getInteractionSubmission> }): React.ReactElement | null {
  if (submission === undefined) return null;
  const text = submission.status === 'failed' ? submission.error ?? '提交失败，请重试'
    : submission.status === 'uncertain' ? '提交结果待核对，请等待会话同步'
    : submission.status === 'collected' ? '此答案已保存，等待其他问题'
    : submission.status === 'sent' ? '已提交，等待原生结果'
    : store.connectionState === 'online' ? '正在提交…' : '等待连接后提交…';
  return <p role={submission.status === 'failed' ? 'alert' : 'status'}>{text}</p>;
}

function QuestionCard({ event, data }: { event: StoredEvent; data: EventData['question'] }): React.ReactElement {
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState('');
  useStoreVersion();
  const submission = store.getInteractionSubmission(event.sessionId, 'answer', data.questionId);
  const busy = submission !== undefined && ['pending', 'sent', 'uncertain'].includes(submission.status);
  if (data.status === 'answered' || data.status === 'skipped') {
    return (
      <div className="approval-card resolved" data-testid="question-card" data-state="resolved">
        <Icon name="check" size={15} strokeWidth={2.2} />
        <span>{data.status === 'skipped' ? '已取消' : '已回答'}</span>
        <span className="what">· {data.prompt}</span>
      </div>
    );
  }
  return (
    <div className="question-card" data-testid="question-card" data-state="pending">
      <div className="approval-title">
        <Icon name="help" size={16} />
        {data.header ?? '需要你回答'}
      </div>
      <div style={{ fontSize: 14 }}>{data.prompt}</div>
      <div className="question-options" role={data.multiSelect === true ? 'group' : 'radiogroup'} aria-label={data.prompt}>
        {(data.options ?? []).map((option) => (
          <label key={option.id} className="question-option">
            <input
              type={data.multiSelect === true ? 'checkbox' : 'radio'}
              name={data.questionId}
              checked={selected.includes(option.id)}
              onChange={() =>
                setSelected((prev) => (data.multiSelect === true ? (prev.includes(option.id) ? prev.filter((id) => id !== option.id) : [...prev, option.id]) : [option.id]))
              }
            />
            <span>
              {option.label}
              {option.description !== undefined ? <span className="desc">{option.description}</span> : null}
            </span>
          </label>
        ))}
      </div>
      {data.allowsFreeText !== false ? (
        <input className="text-input" placeholder="其他（可选）" aria-label="其他回答" value={text} onChange={(event_) => setText(event_.target.value)} />
      ) : null}
      <InteractionStatus submission={submission} />
      <div className="approval-actions">
        <button
          type="button"
          className="btn primary"
          disabled={busy || selected.length === 0 && text.trim() === ''}
          onClick={() => {
            store.answer(event.sessionId, data.questionId, { selected, custom: text });
          }}
        >
          提交
        </button>
      </div>
    </div>
  );
}
