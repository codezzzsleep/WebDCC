import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { EventData, StoredEvent } from '@webdcc/protocol';
import { useStoreVersion } from '../lib/hooks.js';
import { store, type HotItem, type TurnModel } from '../lib/store.js';
import { duration, shortNumber } from '../lib/format.js';
import { Markdown } from './Markdown.js';

function useTurns(sessionId: string): TurnModel[] {
  useStoreVersion();
  return useMemo(() => store.getTurns(sessionId), [sessionId, store.getVersion()]);
}

function useHot(sessionId: string): HotItem[] {
  useStoreVersion();
  return store.getHot(sessionId);
}

interface TimelineProps {
  sessionId: string;
  highlightSeq?: number;
  onOpenDiff: (fileId: string, path: string) => void;
  onHandoff: (text: string) => void;
}

export function Timeline({ sessionId, highlightSeq, onOpenDiff, onHandoff }: TimelineProps): React.ReactElement {
  const turns = useTurns(sessionId);
  const hot = useHot(sessionId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [stickToBottom, setStickToBottom] = useState(true);

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
  }, [turns.length, hot.length, stickToBottom, virtualizer]);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (element === null) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setStickToBottom(distance < 80);
    if (element.scrollTop < 40) void store.loadOlder(sessionId);
  };

  return (
    <div className="timeline" ref={scrollRef} onScroll={onScroll} data-testid="timeline">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const turn = turns[item.index];
          if (turn === undefined) return null;
          const isExpanded = expanded[turn.turnId] ?? turn.completed === undefined;
          return (
            <div
              key={turn.turnId}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
            >
              <TurnView
                turn={turn}
                expanded={isExpanded}
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
  );
}

function TurnView({
  turn,
  expanded,
  onToggle,
  highlightSeq,
  onOpenDiff,
  onHandoff,
}: {
  turn: TurnModel;
  expanded: boolean;
  onToggle: () => void;
  highlightSeq?: number;
  onOpenDiff: (fileId: string, path: string) => void;
  onHandoff: (text: string) => void;
}): React.ReactElement {
  const user = turn.user;
  const completed = turn.completed;
  const running = completed === undefined && turn.pending === undefined;
  const durationMs = (completed?.data as EventData['turn.completed'] | undefined)?.durationMs;

  const steps = turn.events.filter(
    (event) => event.kind !== 'user.message' && event.kind !== 'turn.completed' && event.kind !== 'internal',
  );
  const finalMessage = [...turn.events]
    .reverse()
    .find((event) => event.kind === 'assistant.message' && (event.data as EventData['assistant.message']).phase !== 'interim');
  const changes = collectChanges(steps);
  const lastPlan = [...steps].reverse().find((event) => event.kind === 'plan');
  const usage = [...steps].reverse().find((event) => event.kind === 'usage');

  return (
    <section className={`turn ${running ? 'turn-running' : ''}`} id={user === undefined ? undefined : `e-${user.seq}`}>
      {user !== undefined ? (
        <div className="user-message" data-testid="user-message">
          <div className="user-bubble">
            <Markdown text={(user.data as EventData['user.message']).text} />
          </div>
          <div className="user-meta">
            <span>{new Date(user.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
            {turn.pending !== undefined ? <span className="outbox-status">{outboxLabel(turn.pending.status)}</span> : null}
          </div>
        </div>
      ) : null}

      {turn.pending !== undefined ? null : (
        <div className="turn-header">
          {running ? (
            <span className="turn-title running">运行中…</span>
          ) : (
            <button type="button" className="turn-title done" onClick={onToggle}>
              已完成{durationMs === undefined ? '' : `，用时 ${duration(durationMs)}`} {expanded ? '⌃' : '⌄'}
            </button>
          )}
        </div>
      )}

      <div className={`turn-body ${expanded ? 'expanded' : 'collapsed'}`}>
        {expanded
          ? steps.map((event) => (
              <StepRow
                key={`${event.itemKey}-${event.seq}`}
                event={event}
                highlight={highlightSeq === event.seq}
                onOpenDiff={onOpenDiff}
              />
            ))
          : finalMessage !== undefined
            ? <StepRow event={finalMessage} highlight={highlightSeq === finalMessage.seq} onOpenDiff={onOpenDiff} />
            : null}

        {turn.hot.map((item) => (
          <HotRow key={item.itemKey} item={item} />
        ))}

        {expanded && lastPlan !== undefined ? <PlanRow event={lastPlan} /> : null}

        {changes.length > 0 ? <ChangesCard changes={changes} onOpenDiff={onOpenDiff} /> : null}

        {completed !== undefined ? (
          <div className="turn-footer">
            <span className={`turn-status ${(completed.data as EventData['turn.completed']).status}`}>
              {(completed.data as EventData['turn.completed']).status === 'interrupted' ? '已打断' : '完成'}
            </span>
            {usage !== undefined ? <span className="usage">{formatUsage(usage)}</span> : null}
            {finalMessage !== undefined ? (
              <button
                type="button"
                className="link-button"
                onClick={() => onHandoff((finalMessage.data as EventData['assistant.message']).text)}
              >
                带到…
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function outboxLabel(status: 'pending' | 'sent' | 'failed'): string {
  if (status === 'pending') return '待发送';
  if (status === 'sent') return '已送达';
  return '发送失败';
}

function formatUsage(event: StoredEvent): string {
  const data = event.data as EventData['usage'];
  const parts: string[] = [];
  if (data.inputTokens !== undefined || data.outputTokens !== undefined) {
    parts.push(`${shortNumber((data.inputTokens ?? 0) + (data.outputTokens ?? 0))} tokens`);
  }
  if (data.tokensPerSecond !== undefined) parts.push(`${data.tokensPerSecond.toFixed(1)} tok/s`);
  if (data.cacheHitRatio !== undefined) parts.push(`缓存命中 ${Math.round(data.cacheHitRatio * 100)}%`);
  return parts.join(' · ');
}

interface ChangeSummary {
  path: string;
  added: number;
  removed: number;
  fileId?: string;
}

function collectChanges(steps: StoredEvent[]): ChangeSummary[] {
  const map = new Map<string, ChangeSummary>();
  for (const event of steps) {
    if (event.kind !== 'file.change') continue;
    for (const change of (event.data as EventData['file.change']).changes) {
      const existing = map.get(change.path);
      if (existing === undefined) {
        map.set(change.path, { path: change.path, added: change.added, removed: change.removed, ...(change.diffFileId === undefined ? {} : { fileId: change.diffFileId }) });
      } else {
        existing.added += change.added;
        existing.removed += change.removed;
        if (change.diffFileId !== undefined) existing.fileId = change.diffFileId;
      }
    }
  }
  return [...map.values()];
}

function ChangesCard({ changes, onOpenDiff }: { changes: ChangeSummary[]; onOpenDiff: (fileId: string, path: string) => void }): React.ReactElement {
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);
  return (
    <div className="changes-card" data-testid="changes-card">
      <div className="changes-title">
        已编辑 {changes.length} 个文件 <span className="added">+{added}</span> <span className="removed">-{removed}</span>
      </div>
      {changes.map((change) => (
        <button
          key={change.path}
          type="button"
          className="change-row"
          onClick={() => change.fileId !== undefined && onOpenDiff(change.fileId, change.path)}
        >
          <span className="change-path">{change.path}</span>
          <span className="added">+{change.added}</span>
          <span className="removed">-{change.removed}</span>
        </button>
      ))}
    </div>
  );
}

function PlanRow({ event }: { event: StoredEvent }): React.ReactElement {
  const data = event.data as EventData['plan'];
  const done = data.items.filter((item) => item.status === 'completed').length;
  const doing = data.items.filter((item) => item.status === 'in_progress').length;
  return (
    <div className="plan-row" data-testid="plan-panel">
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

function HotRow({ item }: { item: HotItem }): React.ReactElement {
  const data = item.data as { text?: string; command?: string; outputTail?: string };
  return (
    <div className="step-row hot">
      <span className="step-icon">◐</span>
      <span className="step-text">
        {item.kind === 'assistant.message' ? data.text ?? '' : item.kind === 'command' ? `运行中 · ${data.command ?? ''}` : item.kind}
      </span>
      {data.outputTail !== undefined ? <pre className="output">{data.outputTail}</pre> : null}
    </div>
  );
}

function StepRow({ event, highlight, onOpenDiff }: { event: StoredEvent; highlight?: boolean; onOpenDiff: (fileId: string, path: string) => void }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const className = `step-row ${highlight === true ? 'highlight' : ''}`;

  switch (event.kind) {
    case 'assistant.message': {
      const data = event.data as EventData['assistant.message'];
      return (
        <div className={`${className} assistant`} id={`e-${event.seq}`}>
          <Markdown text={data.text} />
        </div>
      );
    }
    case 'reasoning': {
      const data = event.data as EventData['reasoning'];
      return (
        <div className={className}>
          <button type="button" className="step-toggle" onClick={() => setOpen((value) => !value)}>
            <span className="step-icon">✦</span>思考 · {open ? '收起' : '展开'}
          </button>
          {open ? <div className="step-detail">{data.text}</div> : null}
        </div>
      );
    }
    case 'command': {
      const data = event.data as EventData['command'];
      return (
        <div className={className} id={`e-${event.seq}`}>
          <button type="button" className="step-toggle" onClick={() => setOpen((value) => !value)}>
            <span className="step-icon">⌘</span>运行命令 · {data.label ?? data.command}
          </button>
          {open || data.status === 'failed' ? (
            <pre className="output">{data.outputTail ?? '（无输出）'}</pre>
          ) : null}
        </div>
      );
    }
    case 'file.read': {
      const data = event.data as EventData['file.read'];
      return (
        <div className={className}>
          <span className="step-icon">▤</span>读取文件 · {data.path}
        </div>
      );
    }
    case 'file.change': {
      const data = event.data as EventData['file.change'];
      return (
        <div className={className}>
          <span className="step-icon">✎</span>
          修改 {data.changes.length} 个文件
          {data.changes[0]?.diffFileId !== undefined ? (
            <button type="button" className="link-button" onClick={() => onOpenDiff(data.changes[0]?.diffFileId ?? '', data.changes[0]?.path ?? '')}>
              查看 diff
            </button>
          ) : null}
        </div>
      );
    }
    case 'tool.call': {
      const data = event.data as EventData['tool.call'];
      return (
        <div className={className}>
          <button type="button" className="step-toggle" onClick={() => setOpen((value) => !value)}>
            <span className="step-icon">⚙</span>工具 · {data.name}
          </button>
          {open ? <pre className="output">{JSON.stringify(data.input, null, 2)}</pre> : null}
        </div>
      );
    }
    case 'approval.request': {
      const data = event.data as EventData['approval.request'];
      return <ApprovalCard event={event} data={data} className={className} />;
    }
    case 'approval.resolved': {
      const data = event.data as EventData['approval.resolved'];
      return <div className={className}>审批已处理 · {data.optionId}</div>;
    }
    case 'question': {
      const data = event.data as EventData['question'];
      return <QuestionCard event={event} data={data} className={className} />;
    }
    case 'plan': {
      return null;
    }
    case 'turn.started':
    case 'usage': {
      return null;
    }
    case 'error': {
      const data = event.data as EventData['error'];
      return (
        <div className={`${className} error-card`} data-testid="error-card">
          <span className="step-icon">!</span>
          {data.message}
        </div>
      );
    }
    case 'unknown': {
      const data = event.data as EventData['unknown'];
      return (
        <div className={className} data-testid="unknown-card">
          <button type="button" className="step-toggle" onClick={() => setOpen((value) => !value)}>
            <span className="step-icon">?</span>未知事件 · {data.nativeType}
          </button>
          {open ? <pre className="output">{JSON.stringify(event.native ?? event.data, null, 2)}</pre> : null}
        </div>
      );
    }
    default:
      return null;
  }
}

function ApprovalCard({ event, data, className }: { event: StoredEvent; data: EventData['approval.request']; className: string }): React.ReactElement {
  const [resolved, setResolved] = useState(false);
  return (
    <div className={`${className} approval-card`} data-testid="approval-card" id={`e-${event.seq}`}>
      <div className="approval-title">{data.title}</div>
      <pre className="output">{data.detail}</pre>
      <div className="approval-actions">
        {data.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={option.id === 'deny' || option.id === 'reject' ? 'button ghost' : 'button primary'}
            disabled={resolved}
            onClick={() => {
              setResolved(true);
              store.approve(event.sessionId, data.approvalId, option.id);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function QuestionCard({ event, data, className }: { event: StoredEvent; data: EventData['question']; className: string }): React.ReactElement {
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  return (
    <div className={`${className} question-card`} data-testid="question-card">
      <div className="approval-title">{data.prompt}</div>
      <div className="question-options">
        {(data.options ?? []).map((option) => (
          <label key={option.id}>
            <input
              type={data.multiSelect === true ? 'checkbox' : 'radio'}
              name={data.questionId}
              checked={selected.includes(option.id)}
              onChange={() => setSelected((prev) => (data.multiSelect === true ? (prev.includes(option.id) ? prev.filter((id) => id !== option.id) : [...prev, option.id]) : [option.id]))}
            />
            {option.label}
            {option.description !== undefined ? <span className="option-desc">{option.description}</span> : null}
          </label>
        ))}
      </div>
      {data.allowsFreeText !== false ? (
        <input className="text-input" placeholder="其他（可选）" value={text} onChange={(event_) => setText(event_.target.value)} />
      ) : null}
      <button
        type="button"
        className="button primary"
        disabled={submitted}
        onClick={() => {
          setSubmitted(true);
          store.answer(event.sessionId, data.questionId, { selected, custom: text });
        }}
      >
        提交
      </button>
    </div>
  );
}
