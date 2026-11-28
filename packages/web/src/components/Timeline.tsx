import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Link } from '@tanstack/react-router';
import type { EventData, InteractionKind, LiveItem, StoredEvent, SubmittedQuestionAnswer, TurnView as ProtocolTurnView, UsageData } from '@webdcc/protocol';
import { goalLabel, isValidEventData, displayCodexAsyncReply, failedFileOperation, fileOperationError, nativePlanText, nativeOperationDeclined, nativeReasoningContent, codexReviewItem, codexCollabCallStatus, codexCollabCallStatusLabel } from '@webdcc/protocol';
import { NativeReasoningContent } from './NativeReasoningContent.js';
import type { DshApprovalRecoveryView } from '@webdcc/protocol';
import { DshQuestionRecovery } from './DshQuestionRecovery.js';
import { useStoreVersion } from '../lib/hooks.js';
import { store } from '../lib/store.js';
import { api } from '../lib/api.js';
import { duration, shortNumber } from '../lib/format.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { Icon, Spinner, type IconName } from './Icon.js';
import { Markdown, MarkdownWorkspace } from './Markdown.js';
import { AgentError } from './AgentError.js';
import { ElicitationForm } from './ElicitationForm.js';
import { InputAttachments } from './InputAttachments.js';
import { DshSubagentPanel } from './DshSubagentPanel.js';
import { openDshSubagent } from '../lib/dsh-subagent-navigation.js';
import { DshQuestionWait, useDshQuestionWait } from './DshQuestionWait.js';
import { ClaudeStructuredOutput } from './ClaudeStructuredOutput.js';
import { OlderHistoryRecovery } from './OlderHistoryRecovery.js';
import { CodexNativeToolStatus } from './CodexNativeToolStatus.js';
import { HotRecoveryNotice, RecoveredHotItem } from './RecoveredHot.js';
import { NativeTerminalResults } from './NativeTerminalResults.js';
import { isIncompleteClaudeOutput, orderClaudeBlocks } from '@webdcc/protocol';
import { CompletedRecoveryNotice, RecoveredCompletionCard } from './RecoveredCompletion.js';
import { acceptQuestionAnswer, acceptSecretQuestionAnswer, clearQuestionDraft, markSecretQuestionEdited, questionDraftKey, questionDraftVersion, questionHasUnsavedChanges, readQuestionDraft, saveQuestionDraft, subscribeQuestionDrafts } from '../lib/question-drafts.js';
import { awaitsQuestionAnswer, focusQuestion, latestQuestions, needsQuestionAnswer } from '../lib/question-navigation.js';

function useTurns(sessionId: string): ProtocolTurnView[] {
  useStoreVersion();
  return useMemo(() => store.getTurns(sessionId), [sessionId, store.getVersion()]);
}

interface TimelineProps {
  sessionId: string;
  highlightSeq?: number;
  jumpRevision?: number;
  onOpenDiff: (fileId: string, path: string) => void;
  onHandoff: (text: string) => void;
  /** 停靠区里只读对照：不显示"带到…"等操作 */
  compact?: boolean;
}

export function Timeline({ sessionId, highlightSeq, jumpRevision, onOpenDiff, onHandoff, compact = false }: TimelineProps): React.ReactElement {
  const turns = useTurns(sessionId);
  const conversation = store.getSession(sessionId)?.conversation;
  const history = store.isViewingConversationHistory(sessionId);
  const hotCount = store.getHot(sessionId).length;
  const standalone = new Map<string, StoredEvent>();
  for (const event of store.getConversationEvents(sessionId, history)) {
    if (event.kind === 'notice' && ['slash.command', 'conversation_reset_projection_failed'].includes((event.data as EventData['notice']).nativeType ?? '')) standalone.set(event.itemKey, event);
    if (event.kind === 'question') standalone.set(`question:${(event.data as EventData['question']).questionId}`, event);
    if (event.kind === 'approval.request') standalone.set(`approval:${(event.data as EventData['approval.request']).approvalId}`, event);
    if (event.kind === 'approval.resolved' && store.getSession(sessionId)?.agent !== 'dsh') standalone.delete(`approval:${(event.data as EventData['approval.resolved']).approvalId}`);
  }
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [stickToBottom, setStickToBottom] = useState(true);

  useEffect(() => { setExpanded({}); setStickToBottom(true); }, [sessionId, conversation?.uuid, history]);

  useEffect(() => {
    if (!performance.getEntriesByName('wdcc:first-turns').length && turns.length > 0) {
      performance.mark('wdcc:first-turns');
    }
  }, [turns.length]);

  // Older history prepends turns. Measurements and observer ownership must
  // follow the same identity as React's rows, rather than their old index.
  const getTurnKey = useCallback((index: number) => JSON.stringify([sessionId, conversation?.uuid, history, turns[index]!.turnId]),
    [sessionId, conversation?.uuid, history, turns]);
  const virtualizer = useVirtualizer({
    count: turns.length,
    getItemKey: getTurnKey,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 260,
    overscan: 6,
  });
  const targetEvent = highlightSeq === undefined ? undefined : store.getEvents(sessionId).find(event => event.seq === highlightSeq);
  const targetTurn = targetEvent === undefined ? -1 : turns.findIndex(turn => turn.turnId === targetEvent.turnId || turn.userSeq === targetEvent.seq);
  const targetHasRow = targetEvent !== undefined && targetTurn >= 0 && (turns[targetTurn]?.userSeq === targetEvent.seq || turns[targetTurn]?.steps.some(event => event.seq === targetEvent.seq));
  const lastJump = useRef('');
  useEffect(() => {
    if (highlightSeq === undefined || targetEvent === undefined) return;
    const key = JSON.stringify([sessionId, highlightSeq, jumpRevision, targetTurn, targetHasRow, history]);
    if (lastJump.current === key) return;
    lastJump.current = key;
    setStickToBottom(false);
    if (targetTurn >= 0 && targetHasRow) {
      setExpanded(previous => ({ ...previous, [turns[targetTurn]!.turnId]: true }));
      virtualizer.scrollToIndex(targetTurn, { align: 'start' });
    }
    let cancelled = false, attempts = 0;
    const focus = (): void => {
      if (cancelled) return;
      const selector = targetHasRow ? `[data-event-seq="${highlightSeq}"]` : '[data-testid="trajectory-event-detail"]';
      const element = scrollRef.current?.querySelector<HTMLElement>(selector);
      if (element) { element.scrollIntoView({ block: 'center' }); element.focus({ preventScroll: true }); }
      else if (attempts++ < 30) requestAnimationFrame(focus);
    };
    const frame = requestAnimationFrame(focus);
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [sessionId, highlightSeq, jumpRevision, targetTurn, targetHasRow, history]);
  useSyncExternalStore(subscribeQuestionDrafts, questionDraftVersion);
  const pendingQuestions = latestQuestions(store.getConversationEvents(sessionId, history)).filter(needsQuestionAnswer);
  const goToQuestion = (question: StoredEvent): void => {
    const questionId = (question.data as EventData['question']).questionId;
    setStickToBottom(false);
    const index = turns.findIndex(turn => turn.turnId === question.turnId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'start' });
    let attempts = 0;
    const focus = (): void => { if (!focusQuestion(scrollRef.current, questionId) && attempts++ < 15) requestAnimationFrame(focus); };
    requestAnimationFrame(focus);
  };

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
    if (element.scrollTop < 40 && store.getOlderHistoryState(sessionId).phase !== 'error') void store.loadOlder(sessionId);
  };

  return (
    <MarkdownWorkspace.Provider value={store.getSession(sessionId)?.workspaceId}>
    {pendingQuestions.length && !history ? <div className="question-pending-bar" data-testid="question-pending-bar">
      <span>{pendingQuestions.length} 个问题待回答</span>
      <button type="button" className="btn" onClick={() => goToQuestion(pendingQuestions[0]!)}>去回答</button>
    </div> : null}
    <div className="timeline" ref={scrollRef} onScroll={onScroll} data-testid="timeline">
      {targetEvent !== undefined && !targetHasRow ? <div className="timeline-inner trajectory-event-detail highlight" tabIndex={-1} data-testid="trajectory-event-detail">
        <p>事件 {targetEvent.seq} · {targetEvent.kind}：此记录没有独立的对话卡片，原始内容如下。</p>
        <pre>{JSON.stringify(targetEvent.data, null, 2)}</pre>
        <Link to="/settings/native-events" search={{ sessionId }}>查看原生记录</Link>
      </div> : null}
      <OlderHistoryRecovery sessionId={sessionId} />
      {!history ? <NativeTerminalResults sessionId={sessionId} /> : null}
      {!history ? <HotRecoveryNotice sessionId={sessionId} /> : null}
      {!history ? <CompletedRecoveryNotice sessionId={sessionId} /> : null}
      {!history ? store.getCompletedProjection(sessionId).filter(item => item.turnId === null).map(item =>
        <div className="timeline-inner" key={item.projectionId}><RecoveredCompletionCard item={item} /></div>) : null}
      {!history ? store.getHot(sessionId).filter(item => item.turnId === null && item.observation?.state === 'lost').map(item =>
        <div className="timeline-inner" key={item.itemKey}><RecoveredHotItem item={item as LiveItem} /></div>) : null}
      {store.getSession(sessionId)?.agent === 'dsh' && !history ? <DshSubagentPanel key={`${sessionId}:${store.getSession(sessionId)?.nativeId ?? ''}`} sessionId={sessionId} nativeId={store.getSession(sessionId)?.nativeId} /> : null}
      {conversation !== undefined ? <div className="timeline-inner" role="status" data-testid="conversation-boundary">
        <span>{history ? `此前对话${conversation.previousTitle ? ` · ${conversation.previousTitle}` : ''}（只读）` : '当前对话'}</span>
        <button type="button" className="btn ghost" onClick={() => store.viewConversationHistory(sessionId, !history)}>
          {history ? '返回当前对话' : '查看此前对话'}
        </button>
      </div> : null}
      {[...standalone.values()].filter(event => event.turnId === null).map(event => <div key={event.itemKey} className="timeline-inner">
        {event.kind === 'notice' ? <pre className="notice-card" style={{ whiteSpace: 'pre-wrap' }}>{(event.data as EventData['notice']).text}</pre> : event.kind === 'question' ? <QuestionCard event={event} data={event.data as EventData['question']} /> : <ApprovalCard event={event} data={event.data as EventData['approval.request']} />}
      </div>)}
      <div className="timeline-inner" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const turn = turns[item.index];
          if (turn === undefined) return null;
          const isLast = item.index === turns.length - 1;
          const isExpanded = expanded[turn.turnId] ?? false;
          return (
            <div
              key={item.key}
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
  const observationLost = turn.observation === 'lost';
  const steps = turn.steps;
  const reviewTexts = new Set(steps.flatMap(event => {
    const review = codexReviewItem(event); return review?.phase === 'finished' ? [review.text] : [];
  }));
  // Codex emits both the formatted mode result and the same agent message.
  // Retain both source events and display that exact native text once.
  const reviewCopy = (data: EventData['assistant.message']) =>
    (data.nativePhase === undefined || data.nativePhase === 'final_answer') && reviewTexts.has(data.text);
  const visibleSteps = steps.filter(event => event.kind !== 'structured.output' && (event.kind !== 'assistant.message' || !reviewCopy(event.data as EventData['assistant.message'])));
  const answerKeys = new Set(turn.answer.map((answer) => answer.itemKey));
  for (const output of turn.structuredOutputs ?? []) answerKeys.add(output.itemKey);
  const changes = turn.changes.map((change) => ({ ...change, ...(change.diffFileId === undefined ? {} : { fileId: change.diffFileId }) }));
  // 运行中、或用户展开时显示全部步骤；完成后默认只显示摘要和最终回答（DSH 的做法）
  const showAll = running || expanded;
  const claude = store.getSession(sessionId)?.agent === 'claude-code';
  const displayedSteps = showAll ? visibleSteps : visibleSteps.filter(event => INTERACTIVE_KINDS.has(event.kind) || event.kind === 'error' || answerKeys.has(event.itemKey)
    || failedFileOperation(event) || codexReviewItem(event)?.phase === 'finished');
  const displayedLive = turn.live.filter(item => item.kind !== 'assistant.message' || !reviewCopy(item.data as EventData['assistant.message']));
  const waitingOnUser = turn.activity?.kind === 'waiting';
  const finalText = turn.answer.map((answer) => answer.text).join('\n');

  const headLabel =
    !['completed', 'interrupted', 'failed'].includes(turn.state)
      ? ''
      : `${turn.state === 'interrupted' ? '已中断' : turn.state === 'failed' ? '出错' : '已完成'}${turn.durationMs === undefined ? '' : `，用时 ${duration(turn.durationMs)}`}`;

  return (
    <section className={`turn ${running && !observationLost ? 'turn-running' : ''}${highlightSeq === turn.userSeq ? ' highlight' : ''}`} tabIndex={-1} data-event-seq={turn.userSeq} id={turn.userSeq === undefined ? undefined : `e-${turn.userSeq}`}>
      {turn.pending !== undefined || user.text !== '' || (user.images?.length ?? 0) > 0 || user.contentParts?.parts.some(part => part.type !== 'text') ? (
        <div className="user-message" data-testid="user-message">
          <div className="user-bubble">
            <Markdown text={displayCodexAsyncReply(user.text)} />
            <InputAttachments contentParts={user.contentParts} images={user.images} />
          </div>
          <div className="user-meta">
            {turn.pending !== undefined || turn.commandState !== undefined ? <span className="outbox-status">{outboxLabel(turn.pending?.status ?? turn.commandState ?? 'pending')}</span> : null}
            {turn.pending?.status === 'queued' ? <button type="button" className="btn" onClick={() => { void store.cancelQueued(sessionId, turn.pending?.clientCommandId ?? '').catch(error => setCancelError(String(error))); }}>取消排队</button> : null}
            {turn.pending?.status === 'queued' ? ([-1, 1] as const).map(direction => <button type="button" className="btn" key={direction}
              disabled={!store.canMoveQueuedInput(sessionId, turn.pending!.clientCommandId, direction)}
              onClick={() => void store.moveQueuedInput(sessionId, turn.pending!.clientCommandId, direction).then(() => setCancelError('')).catch(error => setCancelError(String(error)))}>
              {direction === -1 ? '提前一位' : '延后一位'}
            </button>) : null}
            {turn.pending?.status === 'queued' && turn.pending.error !== undefined ? <button type="button" className="btn" onClick={() => void api.retryQueuedInput(sessionId, turn.pending!.clientCommandId).then(() => store.refreshQueue(sessionId)).catch(error => setCancelError(String(error)))}>重新核对附件并发送</button> : null}
            {turn.pending?.status === 'uncertain' || turn.commandState === 'uncertain' ? <Link to="/settings/native-events" search={{ sessionId }} className="btn">核对原生执行</Link> : null}
            <span>{new Date(user.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
            {store.canRecoverFailedInput(turn.pending?.clientCommandId ?? user.commandId) ? <button type="button" className="btn" onClick={() => {
              try { store.recoverFailedInput(sessionId, turn.pending?.clientCommandId ?? user.commandId ?? ''); setCancelError(''); } catch (error) { setCancelError(String(error)); }
            }}>放回输入框</button> : null}
          </div>
          {cancelError ? <p role="alert">{cancelError}</p> : null}
          {turn.pending?.error !== undefined ? <p role="alert">{turn.pending.error}</p> : null}
        </div>
      ) : null}

      {[...(turn.inputs?.slice(1) ?? []), ...(turn.pendingInputs ?? [])].map((input, index) => <div className="user-message" data-testid="additional-user-input" key={`additional-${index}`}>
        <div className="user-bubble"><Markdown text={displayCodexAsyncReply(input.text)} /><InputAttachments contentParts={input.contentParts} images={input.images} /></div>
        <div className="user-meta"><span>本轮补充消息</span>{'status' in input ? <span className="outbox-status">{outboxLabel(input.status)}</span> : null}<span>{new Date(input.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span></div>
        {'error' in input && input.error !== undefined ? <p role="alert">{input.error}</p> : null}
      </div>)}

      {turn.pending !== undefined ? null : (
        <div className="turn-header">
          {observationLost ? <span className="turn-title" data-testid="turn-observation-lost">观测已丢失，原生结果待核对</span> : running ? (
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

        {claude ? <ClaudeBlockRows events={displayedSteps} live={displayedLive} sessionId={sessionId} highlightSeq={highlightSeq} onOpenDiff={onOpenDiff} /> : <>{showAll
          ? visibleSteps.map((event) => (
              <ErrorBoundary key={`${event.itemKey}-${event.seq}`} label="timeline-item">
                <StepRow event={event} highlight={highlightSeq === event.seq} onOpenDiff={onOpenDiff} />
              </ErrorBoundary>
            ))
          : visibleSteps
              .filter((event) => INTERACTIVE_KINDS.has(event.kind) || event.kind === 'error' || answerKeys.has(event.itemKey)
                || failedFileOperation(event) || codexReviewItem(event)?.phase === 'finished')
              .map((event) => (
                <ErrorBoundary key={`always-${event.itemKey}-${event.seq}`} label="timeline-item">
                  <StepRow event={event} highlight={highlightSeq === event.seq} onOpenDiff={onOpenDiff} />
                </ErrorBoundary>
              ))}

        {displayedLive.map((item) => <HotRow key={item.itemKey} sessionId={sessionId} item={item} />)}</>}
        {turn.recovered?.map(item => <RecoveredCompletionCard key={item.projectionId} item={item} />)}

        {turn.structuredOutputs?.map(output => <ClaudeStructuredOutput key={output.itemKey} output={output} />)}

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

function ClaudeBlockRows({ events, live, sessionId, highlightSeq, onOpenDiff }: {
  events: StoredEvent[]; live: LiveItem[]; sessionId: string; highlightSeq?: number; onOpenDiff: (fileId: string, path: string) => void;
}): React.ReactElement {
  const rows = orderClaudeBlocks([
    ...events.map(event => ({ data: event.data, event, live: undefined })),
    ...live.map(item => ({ data: item.data, event: undefined, live: item })),
  ]);
  return <>{rows.map(row => row.event === undefined
    ? <HotRow key={row.live!.itemKey} sessionId={sessionId} item={row.live!} />
    : <ErrorBoundary key={`${row.event.itemKey}-${row.event.seq}`} label="timeline-item">
      <StepRow event={row.event} highlight={highlightSeq === row.event.seq} onOpenDiff={onOpenDiff} />
    </ErrorBoundary>)}</>;
}

function summaryLabel(turn: ProtocolTurnView): string {
  const { commands, reads, edits, tools } = turn.summary;
  const parts: string[] = [];
  if (turn.steps.some(step => codexReviewItem(step) !== undefined)) parts.push('原生 Review');
  if (turn.plan !== undefined || turn.steps.some(step => nativePlanText(step) !== undefined)) parts.push('更新了计划');
  if (turn.goal !== undefined) parts.push(goalLabel(turn.goal));
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
    parts.push(`输入 ${data.inputTokens === undefined ? '未提供' : shortNumber(data.inputTokens)} / 输出 ${data.outputTokens === undefined ? '未提供' : shortNumber(data.outputTokens)} tok`);
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

function HotRow({ sessionId, item }: { sessionId: string; item: LiveItem }): React.ReactElement {
  if (item.observation?.state === 'lost') return <RecoveredHotItem item={item} />;
  const planText = nativePlanText(item);
  if (planText !== undefined) return <NativePlan text={planText} itemKey={item.itemKey} live />;
  const data = item.data as { text?: string; command?: string; outputTail?: string };
  if (item.kind === 'assistant.message') {
    return <div className="hot-text">{data.text ?? ''}</div>;
  }
  if (item.kind === 'reasoning') {
    return (
      <div>
      <div className="step-line">
        <Icon name="sparkle" size={15} />
        <span className="label shimmer">思考中…</span>
        {data.text === undefined || data.text === '' ? null : <span className="detail reasoning-live-text">{data.text}</span>}
      </div>
      <NativeReasoningContent item={item} />
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
      {item.kind === 'tool.call' ? <CodexNativeToolStatus sessionId={sessionId} data={item.data as EventData['tool.call']} /> : null}
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

function StepRow(props: { event: StoredEvent; highlight?: boolean; onOpenDiff: (fileId: string, path: string) => void }): React.ReactElement {
  return <div id={`e-${props.event.seq}`} data-event-seq={props.event.seq} tabIndex={-1} className={props.highlight ? 'event-target highlight' : 'event-target'}>
    <StepContent {...props} />
  </div>;
}

function StepContent({
  event,
  highlight,
  onOpenDiff,
}: {
  event: StoredEvent;
  highlight?: boolean;
  onOpenDiff: (fileId: string, path: string) => void;
}): React.ReactElement | null {
  const [open, setOpen] = useState(highlight === true);
  useEffect(() => { if (highlight) setOpen(true); }, [highlight]);
  const [subagentText, setSubagentText] = useState('');
  const [subagentBusy, setSubagentBusy] = useState(false);
  const [subagentNotice, setSubagentNotice] = useState<string>();
  const [subagentError, setSubagentError] = useState<string>();
  const className = `step-row ${highlight === true ? 'highlight' : ''}`;
  // 渲染前再校验一次：不合格的事件显示占位，而不是让组件崩掉（F2）
  if (!isValidEventData(event.kind, event.data)) {
    return <div className="render-fallback">这条内容无法显示 · 在轨迹中查看</div>;
  }
  const toggle = (): void => setOpen((value) => !value);
  const claudeIncomplete = store.getSession(event.sessionId)?.agent === 'claude-code' && isIncompleteClaudeOutput(event);

  switch (event.kind) {
    case 'assistant.message': {
      const data = event.data as EventData['assistant.message'];
      return (
        <div className={`${className} assistant`} data-testid="assistant-message" data-raw-text={data.text}>
          <Markdown text={data.text} />
          {claudeIncomplete ? <small className="muted" role="status" data-testid="claude-incomplete-output">原生输出未完成</small> : null}
        </div>
      );
    }
    case 'reasoning': {
      const data = event.data as EventData['reasoning'];
      if (data.text.trim() === '' && nativeReasoningContent(event).length === 0) return null;
      return (
        <div className={className}>
          <StepLine icon="sparkle" label="思考" onClick={toggle} open={open} />
          {claudeIncomplete ? <small className="muted" role="status" data-testid="claude-incomplete-output">原生思考未完成</small> : null}
          {open ? <div className="step-detail">{data.text}<NativeReasoningContent item={event} /></div> : null}
        </div>
      );
    }
    case 'command': {
      const data = event.data as EventData['command'];
      const declined = nativeOperationDeclined(event);
      const failed = data.status === 'failed' || declined;
      return (
        <div className={className}>
          <StepLine icon="terminal" label={declined ? '命令已拒绝' : '运行命令'} detail={data.label ?? data.command} onClick={toggle} open={open} failed={failed} />
          {open ? <pre className="output">{data.outputTail === undefined || data.outputTail === '' ? '（无输出）' : data.outputTail}</pre> : null}
        </div>
      );
    }
    case 'file.read': {
      const data = event.data as EventData['file.read'];
      return (
        <div className={className}>
          <StepLine icon="fileText" label={failedFileOperation(event) ? '读取失败' : '读取'} detail={data.label ?? data.path} failed={failedFileOperation(event)} />
          {fileOperationError(event) === undefined ? null : <pre className="output">{fileOperationError(event)}</pre>}
        </div>
      );
    }
    case 'file.change': {
      const data = event.data as EventData['file.change'];
      const first = data.changes[0];
      const detail =
        first === undefined ? data.path ?? '' : data.changes.length > 1 ? `${first.path} 等 ${data.changes.length} 个文件` : first.path;
      return (
        <div className={className}>
          <StepLine
            icon="edit"
            label={nativeOperationDeclined(event) ? '改动已拒绝' : failedFileOperation(event) ? '编辑失败' : '编辑'}
            detail={detail}
            failed={failedFileOperation(event)}
            {...(failedFileOperation(event) || first?.diffFileId === undefined ? {} : { onClick: () => onOpenDiff(first.diffFileId ?? '', first.path) })}
          />
          {fileOperationError(event) === undefined ? null : <pre className="output">{fileOperationError(event)}</pre>}
        </div>
      );
    }
    case 'tool.call': {
      const review = codexReviewItem(event);
      if (review !== undefined) return <div className={className}>
        <StepLine icon="listChecks" label={review.phase === 'started' ? '开始原生 Review' : '原生 Review 结果'} detail={review.phase === 'started' ? review.text : undefined} />
        {review.phase === 'finished' ? <div data-testid="codex-review-result" data-native-item-key={event.itemKey} data-raw-text={review.text}><Markdown text={review.text} /></div> : null}
      </div>;
      const data = event.data as EventData['tool.call'];
      const toolInput = data.input as Record<string, unknown>;
      const collabStatus = store.getSession(event.sessionId)?.agent === 'codex' ? codexCollabCallStatus(data) : undefined;
      const childId = data.name === 'subagent' && typeof toolInput?.['childId'] === 'string' ? toolInput['childId'] : undefined;
      const dsh = store.getSession(event.sessionId)?.agent === 'dsh';
      const parentSessionId = typeof toolInput?.['parentSessionId'] === 'string' ? toolInput['parentSessionId'] : undefined;
      const canOpenDshChild = dsh && childId !== undefined && parentSessionId !== undefined && toolInput?.['mode'] !== 'external'
        && !store.isViewingConversationHistory(event.sessionId) && parentSessionId === store.getSession(event.sessionId)?.nativeId;
      const canControlChild = !dsh && childId !== undefined && toolInput?.['mode'] === 'continuable';
      const sendSubagent = async (): Promise<void> => {
        if (childId === undefined || subagentText.trim() === '') return;
        setSubagentBusy(true); setSubagentNotice(undefined); setSubagentError(undefined);
        try {
          const result = await api.sendSubagent(event.sessionId, childId, subagentText);
          if ('receipt' in result && result.receipt.state === 'completed') { setSubagentText(''); setSubagentNotice('原生已接收子消息；运行结果请查看子会话。'); }
          else setSubagentError('子消息接收待核对，请打开子会话查看回执和原生队列。');
        } catch (cause) {
          setSubagentError(`${cause instanceof Error ? cause.message : String(cause)}。子消息接收待核对。`);
        } finally {
          setSubagentBusy(false);
        }
      };
      const stopSubagent = async (): Promise<void> => {
        if (childId === undefined) return;
        setSubagentBusy(true); setSubagentNotice(undefined); setSubagentError(undefined);
        try {
          const result = await api.interruptSubagent(event.sessionId, childId);
          setSubagentNotice('receipt' in result && result.receipt.state === 'submitted'
            ? '停止请求已被原生接受，请查看子 Agent 当前状态。' : '请核对子 Agent 当前状态；刷新不会重发停止请求。');
        } catch (cause) {
          setSubagentError(`${cause instanceof Error ? cause.message : String(cause)}。停止结果待核对。`);
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
            failed={(collabStatus ?? data.status) === 'failed'}
          />
          {collabStatus === undefined ? null : <p className="muted" role="status" data-testid="codex-collab-call-status"
            data-native-call-id={typeof toolInput?.['id'] === 'string' ? toolInput['id'] : undefined}>
            原生 {typeof toolInput?.['tool'] === 'string' ? toolInput['tool'] : data.name} 调用 · {codexCollabCallStatusLabel(collabStatus)}
          </p>}
          {claudeIncomplete ? <p className="muted" role="status" data-testid="claude-incomplete-tool">原生工具输入未完成，执行状态待核对</p> : null}
          {open ? (
            <pre className="output">
              {JSON.stringify(data.input, null, 2)}
              {data.output === undefined ? '' : `\n\n→ ${typeof data.output === 'string' ? data.output : JSON.stringify(data.output, null, 2)}`}
            </pre>
          ) : null}
          <CodexNativeToolStatus sessionId={event.sessionId} data={data} />
          {canControlChild ? <div className="subagent-controls"><input className="text-input" value={subagentText} onChange={(event) => setSubagentText(event.target.value)} placeholder="给子 Agent 发送消息" disabled={subagentBusy} /><button type="button" className="btn small" onClick={() => void sendSubagent()} disabled={subagentBusy || subagentText.trim() === ''}>继续</button><button type="button" className="btn small ghost danger-text" onClick={() => void stopSubagent()} disabled={subagentBusy}>打断</button></div> : null}
          {canOpenDshChild ? <div className="subagent-controls"><button type="button" className="btn small" data-testid="dsh-timeline-child-open" onClick={() => openDshSubagent({ sessionId: event.sessionId, parentSessionId, childSessionId: childId })}>打开子会话</button></div> : null}
          {dsh && childId !== undefined && !canOpenDshChild ? <p className="muted">请从当前子 Agent 面板核对子会话身份和可用操作。</p> : null}
          {subagentNotice === undefined ? null : <p role="status">{subagentNotice}</p>}
          {subagentError === undefined ? null : <p role="alert">{subagentError}</p>}
        </div>
      );
    }
    case 'plan': {
      const data = event.data as EventData['plan'];
      const text = nativePlanText(event);
      if (text !== undefined) return <NativePlan text={text} itemKey={event.itemKey} incomplete={data.incomplete} />;
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
          <StepLine icon="target" label={goalLabel(data)} detail={data.objective} />
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
          <div><span>{data.text}</span>{data.details === undefined ? null : <details>
            <summary>查看失败尝试的部分输出</summary><pre className="output">{data.details}</pre>
          </details>}</div>
        </div>
      );
    }
    case 'error': {
      const data = event.data as EventData['error'];
      return <AgentError message={data.message} />;
    }
    case 'unknown': {
      const data = event.data as EventData['unknown'];
      return (
        <div className={className} data-testid="unknown-card">
          <StepLine icon="help" label="未知事件" detail={data.nativeType} onClick={toggle} open={open} />
          {claudeIncomplete ? <small className="muted" role="status" data-testid="claude-incomplete-output">原生不透明内容未完成，原文保留在轨迹</small> : null}
          {open ? <pre className="output">{JSON.stringify(event.native ?? event.data, null, 2)}</pre> : null}
        </div>
      );
    }
    default:
      return null;
  }
}

function NativePlan({ text, itemKey, incomplete, live }: { text: string; itemKey: string; incomplete?: boolean; live?: boolean }): React.ReactElement {
  return <div className="step" data-testid="native-plan" data-item-key={itemKey}>
    <StepLine icon="listChecks" label={live ? '正在生成计划' : incomplete ? '计划未完成' : '原生计划'} />
    <div className="step-detail" data-testid="native-plan-text" data-raw-text={text}><Markdown text={text} /></div>
  </div>;
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

function DshApprovalRecovery({ event, data }: { event: StoredEvent; data: EventData['approval.request'] }): React.ReactElement {
  const [view, setView] = useState<DshApprovalRecoveryView>();
  const [error, setError] = useState(''); const [refresh, setRefresh] = useState(0);
  const submission = store.getInteractionSubmission(event.sessionId, 'approve', data.approvalId);
  const isRetry = store.isDshApprovalRetry(event.sessionId, data.approvalId);
  const retrying = isRetry && submission?.status === 'pending';
  useEffect(() => {
    let current = true; setView(undefined); setError('');
    void api.dshApprovalRecovery(event.sessionId, data.approvalId).then(value => { if (current) setView(value); })
      .catch(error => { if (current) setError(String(error)); });
    return () => { current = false; };
  }, [event.sessionId, event.seq, data.approvalId, refresh]);
  useEffect(() => {
    if (isRetry && submission !== undefined && ['failed', 'uncertain'].includes(submission.status)) {
      setView(undefined); setError(submission.error ?? '原回应提交结果待核对，请重新核对审批');
    }
  }, [isRetry, submission]);
  if (view?.status === 'available') return <div className="approval-recovery">
    <p>原回应：{data.options.find(option => option.id === view.optionId)?.label ?? view.optionId}</p>
    <button type="button" className="btn" disabled={retrying} onClick={() => store.retryDshApproval(event.sessionId, view)}>{retrying ? '正在提交原回应…' : '重试原回应'}</button>
  </div>;
  return <div className="approval-recovery">
    <p role={error ? 'alert' : 'status'}>{error || (view?.status === 'unavailable' ? view.reason : '正在核对原审批…')}</p>
    {view !== undefined || error ? <button type="button" className="btn" onClick={() => setRefresh(value => value + 1)}>重新核对审批</button> : null}
  </div>;
}

function ApprovalCard({ event, data }: { event: StoredEvent; data: EventData['approval.request'] }): React.ReactElement {
  useStoreVersion();
  const submission = data.submission === 'sent' || data.submission === 'uncertain'
    ? { commandId: '', status: data.submission } : store.getInteractionSubmission(event.sessionId, 'approve', data.approvalId)
      ?? (data.submission === undefined ? undefined : { commandId: '', status: data.submission });
  const synchronized = store.isInteractionSynced(event.sessionId, 'approve', data.approvalId);
  const isRetry = store.isDshApprovalRetry(event.sessionId, data.approvalId);
  const busy = !synchronized || isRetry || submission !== undefined && ['pending', 'sent', 'uncertain'].includes(submission.status);
  // 处理过的审批要显示结果、不再显示按钮（F11 / F17）；结果也可能来自其他界面
  const resolution = [...store.getEvents(event.sessionId)]
    .reverse()
    .find((item) => item.kind === 'approval.resolved' && (item.data as EventData['approval.resolved']).approvalId === data.approvalId);
  const resolvedText = (() => {
    if (resolution === undefined) return null;
    const resolved = resolution.data as EventData['approval.resolved'];
    if (resolved.optionId === 'outcome-unknown') return '原生轮次已结束，审批结果未确认';
    if (resolved.optionId === 'allow-native-suggestions') return '已允许一次并提交原生权限建议';
    const option = resolved.optionId.toLowerCase();
    if (option === 'grant-turn') return '已允许本轮额外权限';
    if (option === 'grant-session') return '已允许本会话额外权限';
    if (option === 'deny-permissions') return '已拒绝额外权限';
    const result = ['allow', 'accept', 'acceptforsession', 'allowed-once', 'approved', 'approved_for_session', 'approve', 'allow-always', 'allowed-always'].includes(option)
      ? '已允许一次'
      : ['reject', 'rejected', 'deny', 'decline', 'declined', 'denied'].includes(option)
        ? '已拒绝'
        : ['cancelled', 'cancel', 'canceled', 'aborted'].includes(option)
          ? '已取消'
          : '已处理';
    if (store.getSession(event.sessionId)?.agent === 'dsh') return option === 'unavailable' ? '原生未取得审批回应，权限未获准' : `原生${result}`;
    return resolved.by === 'other' ? `已在其他界面处理：${result}` : result;
  })();
  const what = approvalWhat(data);
  const toolName = data.tool ?? data.title;

  if (resolvedText !== null) {
    return (
      <div className="approval-card resolved" data-testid="approval-card" data-state="resolved" data-sync={synchronized ? 'ready' : 'loading'} data-tool={toolName} data-resolved="true">
        <Icon name="check" size={15} strokeWidth={2.2} />
        <span className="approval-result">{resolvedText}</span>
        {what === '' ? null : <span className="what">· {what}</span>}
        {synchronized ? null : <span>历史记录，当前状态尚未核对</span>}
      </div>
    );
  }
  return (
    <div className="approval-card" data-testid="approval-card" data-state="pending" data-sync={synchronized ? 'ready' : 'loading'} data-tool={toolName}>
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
      {synchronized ? <InteractionStatus submission={submission} /> : <InteractionSyncStatus sessionId={event.sessionId} kind="approve" id={data.approvalId} />}
      {synchronized && (submission?.status === 'uncertain' || isRetry) && store.getSession(event.sessionId)?.agent === 'dsh'
        ? <DshApprovalRecovery event={event} data={data} /> : null}
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
    : submission.status === 'queued' ? '回答已排队，等待发送；可在输入队列中取消'
    : submission.status === 'sent' ? '已提交，等待原生结果'
    : store.connectionState === 'online' ? '正在提交…' : '等待连接后提交…';
  return <p role={submission.status === 'failed' ? 'alert' : 'status'}>{text}</p>;
}

function InteractionSyncStatus({ sessionId, kind, id }: { sessionId: string; kind: InteractionKind; id: string }): React.ReactElement {
  const [error, setError] = useState('');
  return <div>
    <p role="status">交互状态尚未确认，暂时不能提交。</p>
    <button type="button" className="btn" onClick={() => { setError(''); void store.refreshInteraction(sessionId, kind, id).catch(error => setError(String(error))); }}>重新核对状态</button>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}

function QuestionCard({ event, data }: { event: StoredEvent; data: EventData['question'] }): React.ReactElement {
  useSyncExternalStore(subscribeQuestionDrafts, questionDraftVersion);
  const identity = store.getSession(event.sessionId)?.agent === 'dsh' ? data.dshQuestion : undefined;
  const generalDraftKey = questionDraftKey(event, data);
  const draft = () => data.isSecret ? { selected: [], custom: '' } : identity === undefined ? readQuestionDraft(generalDraftKey) : store.dshQuestionWaits.drafts.read(event.sessionId, identity);
  const [selected, setSelected] = useState<string[]>(() => draft().selected);
  const [text, setText] = useState(() => draft().custom);
  const draftIdentity = data.isSecret ? undefined : identity === undefined ? generalDraftKey
    : JSON.stringify([event.sessionId, identity.nativeId, identity.callId, identity.itemId]);
  const edited = useRef(false);
  const restoredDraft = useRef(draftIdentity);
  useEffect(() => {
    if (draftIdentity === undefined || restoredDraft.current === draftIdentity) return;
    restoredDraft.current = draftIdentity;
    edited.current = false;
    const saved = draft(); setSelected(saved.selected); setText(saved.custom);
  }, [draftIdentity]);
  const [hidden, setHidden] = useState(false);
  const [submittedAnswer, setSubmittedAnswer] = useState<SubmittedQuestionAnswer>();
  const [checkingGroup, setCheckingGroup] = useState(false);
  const [groupError, setGroupError] = useState('');
  useStoreVersion();
  const submission = data.submission === 'sent' || data.submission === 'queued' || data.submission === 'uncertain'
    ? { commandId: '', status: data.submission, error: data.submissionError } : store.getInteractionSubmission(event.sessionId, 'answer', data.questionId)
      ?? (data.submission === undefined ? undefined : { commandId: '', status: data.submission, error: data.submissionError });
  const synchronized = store.isInteractionSynced(event.sessionId, 'answer', data.questionId);
  const isRetry = store.isDshQuestionRetry(event.sessionId, data.questionId);
  const submitting = submission !== undefined && ['pending', 'sent', 'queued', 'uncertain'].includes(submission.status);
  const wait = useDshQuestionWait(event.sessionId, data.questionId, identity, data.status !== 'answered' && data.status !== 'skipped', synchronized && !submitting && store.connectionState === 'online');
  const collapsed = wait?.hidden ?? hidden;
  const busy = !synchronized || submitting || checkingGroup || identity?.timed === true && identity.phase === 'open' && wait?.card.snapshot().channel !== 'waterfall';
  const edit = (nextSelected: string[], nextText: string): void => {
    edited.current = true;
    setSelected(nextSelected); setText(nextText); wait?.card.engage();
    if (!data.isSecret) {
      if (identity !== undefined) store.dshQuestionWaits.drafts.save(event.sessionId, identity, 'editing', { selected: nextSelected, custom: nextText });
      saveQuestionDraft(generalDraftKey, { selected: nextSelected, custom: nextText }, identity === undefined);
    } else if (submission?.status === 'collected') markSecretQuestionEdited(generalDraftKey);
  };
  useEffect(() => {
    if (data.isSecret && submission?.status === 'collected') acceptSecretQuestionAnswer(generalDraftKey, submission.commandId);
  }, [generalDraftKey, data.isSecret, submission?.status, submission?.commandId]);
  useEffect(() => {
    if (identity === undefined || data.isSecret || data.status === 'answered' || data.status === 'skipped') return;
    const current = draft();
    if (current.selected.length || current.custom !== '') saveQuestionDraft(generalDraftKey, current, false);
  }, [draftIdentity]);
  useEffect(() => {
    let current = true;
    setSubmittedAnswer(undefined);
    if (data.isSecret || data.submission === undefined && data.status !== 'answered') return;
    void api.interaction(event.sessionId, 'answer', data.questionId).then(result => {
      if (!current || result.event?.kind !== 'question' || (result.event.data as EventData['question']).questionId !== data.questionId) return;
      setSubmittedAnswer(result.submittedAnswer);
      if (result.submittedAnswer !== undefined && data.status !== 'answered' && data.status !== 'skipped') acceptQuestionAnswer(generalDraftKey, { selected: result.submittedAnswer.selected, custom: result.submittedAnswer.custom ?? '' });
      const local = draft();
      if (result.submittedAnswer !== undefined && !edited.current && local.selected.length === 0 && local.custom === '' && data.status !== 'answered' && data.status !== 'skipped') {
        const saved = { selected: result.submittedAnswer.selected, custom: result.submittedAnswer.custom ?? '' };
        setSelected(saved.selected); setText(saved.custom);
      }
    }).catch(() => undefined);
    return () => { current = false; };
  }, [event.sessionId, data.questionId, data.isSecret, data.submission, data.status]);
  useEffect(() => {
    if (data.status === 'answered' || data.status === 'skipped') clearQuestionDraft(generalDraftKey);
  }, [generalDraftKey, data.status]);
  const group = data.groupId === undefined ? [event] : latestQuestions(store.getEvents(event.sessionId)).filter(item => item.turnId === event.turnId && (item.data as EventData['question']).groupId === data.groupId);
  const position = group.findIndex(item => (item.data as EventData['question']).questionId === data.questionId) + 1;
  const remaining = group.filter(needsQuestionAnswer);
  const unsaved = submission?.status === 'collected' && questionHasUnsavedChanges(generalDraftKey);
  const completesGroup = group.length > 1 && group.filter(awaitsQuestionAnswer).every(item => (item.data as EventData['question']).questionId === data.questionId);
  const otherEdits = completesGroup ? group.filter(item => (item.data as EventData['question']).questionId !== data.questionId
    && (item.data as EventData['question']).submission === 'collected' && questionHasUnsavedChanges(questionDraftKey(item, item.data as EventData['question']))) : [];
  const next = remaining.find(item => (item.data as EventData['question']).questionId !== data.questionId);
  const groupLabel = group.length > 1 ? `第 ${position} / ${group.length} 题 · ${remaining.length} 题待回答` : undefined;
  const answerPreview = submittedAnswer === undefined || data.isSecret ? null : <div className="question-answer-preview" data-testid="question-answer-preview">
    <span className="muted">提交的回答</span>
    {submittedAnswer.selected.length ? <ul>{submittedAnswer.selected.map((id, index) => <li key={`${id}-${index}`}>{data.options?.find(option => option.id === id)?.label ?? id}</li>)}</ul> : null}
    {submittedAnswer.custom ? <div className="question-answer-text">{submittedAnswer.custom}</div> : null}
  </div>;
  const submitAnswer = async (intent?: 'queue'): Promise<void> => {
    setGroupError('');
    if (completesGroup) {
      setCheckingGroup(true);
      try {
        for (const item of group) {
          const question = item.data as EventData['question'];
          if (question.questionId === data.questionId || question.submission !== 'collected') continue;
          const result = await api.interaction(event.sessionId, 'answer', question.questionId);
          if (!question.isSecret && result.submittedAnswer === undefined) {
            setGroupError('暂时无法核对本组已保存的答案，请稍后重试。'); return;
          }
          if (result.submittedAnswer !== undefined && !question.isSecret) acceptQuestionAnswer(questionDraftKey(item, question), { selected: result.submittedAnswer.selected, custom: result.submittedAnswer.custom ?? '' });
          if (questionHasUnsavedChanges(questionDraftKey(item, question))) {
            setGroupError('其他题还有未保存的修改，请先更新对应答案。');
            return;
          }
        }
      } catch {
        setGroupError('暂时无法核对本组已保存的答案，请稍后重试。'); return;
      } finally { setCheckingGroup(false); }
    }
    store.answer(event.sessionId, data.questionId, { selected, custom: text }, intent === undefined ? undefined : { intent });
    if (data.isSecret) setText('');
  };
  const blocking = data.isBlocking !== false;
  const nonblockingLabel = blocking ? null : <span className="what">非阻塞提问</span>;
  const nativeDshCancelled = store.getSession(event.sessionId)?.agent === 'dsh' && data.status === 'skipped' && data.outcome === 'cancel';
  if (data.status === 'answered' || data.status === 'skipped') {
    return (
      <div className="approval-card resolved question-resolved" data-testid="question-card" data-question-id={data.questionId} data-state="resolved" data-sync={synchronized ? 'ready' : 'loading'} data-blocking={blocking}>
        <Icon name="check" size={15} strokeWidth={2.2} />
        <span>{data.resolution === 'outcome-unknown' ? '原生轮次已结束，答案结果未确认' : nativeDshCancelled ? '已取消' : data.resolution === 'native-resolved' ? '原生已回答' : data.resolution === 'external' ? data.asyncReply ? '已在原生客户端回答' : '已由原生结束' : data.outcome === 'decline' ? '已拒绝' : data.status === 'skipped' ? '已取消' : data.asyncReply ? '原生已收到回答' : '已回答'}</span>
        <span className="what">· {data.prompt}</span>
        {nonblockingLabel}
        {answerPreview}
        {synchronized ? null : <span>历史记录，当前状态尚未核对</span>}
      </div>
    );
  }
  if (data.elicitation !== undefined) return <div className="question-card" data-testid="question-card" data-question-id={data.questionId} tabIndex={-1} data-state="pending" data-sync={synchronized ? 'ready' : 'loading'} data-blocking={blocking}>
    <div className="approval-title">{data.header ?? '原生交互'}</div><p>{data.prompt}</p>
    {blocking ? null : <p>原生标记为非阻塞，你仍可以回答。</p>}
    {data.isSecret ? <p>敏感表单内容只在本页面保留，刷新后需要重新输入。</p> : null}
    {synchronized ? <InteractionStatus submission={submission} /> : <InteractionSyncStatus sessionId={event.sessionId} kind="answer" id={data.questionId} />}
    <ElicitationForm form={data.elicitation} busy={busy} submit={answer => store.answer(event.sessionId, data.questionId, answer)} />
  </div>;
  return (
    <div className="question-card" data-testid="question-card" data-question-id={data.questionId} tabIndex={-1} data-state="pending" data-sync={synchronized ? 'ready' : 'loading'} data-blocking={blocking}>
      <div className="approval-title">
        <Icon name="help" size={16} />
        {data.header ?? (blocking ? '需要你回答' : '非阻塞提问')}
      </div>
      <div className="question-progress">{groupLabel ? <span>{groupLabel}</span> : null}<span>{data.options?.length ? data.multiSelect ? '可多选' : '请选择一项' : '文字回答'}</span></div>
      {blocking || identity?.phase === 'continued' ? null : <p>{data.asyncReply ? 'Codex 会继续执行。提交回答会送入当前对话；也可以排队等本轮结束。' : '原生标记为非阻塞，你仍可以回答。'}</p>}
      <div className="question-prompt">{data.prompt}</div>
      {wait !== undefined && identity?.timed ? <DshQuestionWait entry={wait} /> : null}
      {identity === undefined ? null : <button type="button" className="btn ghost" onClick={() => { if (wait === undefined) setHidden(!hidden); else store.dshQuestionWaits.toggleSurface(wait); }}>{collapsed ? '展开回答' : '收起回答'}</button>}
      {collapsed ? null : <div onFocusCapture={() => wait?.card.holdFocus()} onBlurCapture={event_ => {
        if (!event_.currentTarget.contains(event_.relatedTarget as Node | null)) wait?.card.releaseFocus();
      }}>
      <div className="question-options" role={data.multiSelect === true ? 'group' : 'radiogroup'} aria-label={data.prompt}>
        {(data.options ?? []).map((option) => (
          <label key={option.id} className={`question-option${selected.includes(option.id) ? ' selected' : ''}`}>
            <input
              type={data.multiSelect === true ? 'checkbox' : 'radio'}
              name={data.questionId}
              disabled={busy}
              checked={selected.includes(option.id)}
              onChange={() => edit(data.multiSelect === true ? selected.includes(option.id) ? selected.filter(id => id !== option.id) : [...selected, option.id] : [option.id], text)}
            />
            <span>
              {option.label}
              {option.description !== undefined ? <span className="desc">{option.description}</span> : null}
            </span>
          </label>
        ))}
      </div>
      {data.allowsFreeText !== false ? (
        !data.isSecret ? <label className="question-custom-label">{data.options?.length ? '补充说明（可选）' : '你的回答'}<textarea className="text-input" rows={3} disabled={busy} placeholder={data.options?.length ? '也可以直接写出你的要求，支持多行' : '输入回答，Enter 换行'} aria-label="其他回答" value={text} onChange={event_ => edit(selected, event_.target.value)} /></label>
          : <input className="text-input" type={data.isSecret ? 'password' : 'text'} autoComplete={data.isSecret ? 'off' : undefined} spellCheck={data.isSecret ? false : undefined} disabled={busy} placeholder={data.isSecret ? '输入敏感回答' : '其他（可选）'} aria-label="其他回答" value={text} onChange={(event_) => edit(selected, event_.target.value)} />
      ) : null}
      {data.isSecret ? <p>敏感回答只在本页面保留，刷新后需要重新输入。</p> : null}
      {synchronized ? unsaved ? <p role="status" data-testid="question-unsaved">本题有未保存的修改，请更新答案后再提交整组。</p> : <InteractionStatus submission={submission} /> : <InteractionSyncStatus sessionId={event.sessionId} kind="answer" id={data.questionId} />}
      {submission?.status === 'collected' ? answerPreview : null}
      {otherEdits.length ? <div className="question-unsaved-warning" role="status" data-testid="question-group-unsaved">
        <span>其他题还有未保存的修改，请先更新：</span>
        {otherEdits.map(item => <button key={(item.data as EventData['question']).questionId} type="button" className="btn" onClick={event_ => focusQuestion(event_.currentTarget.closest('.timeline'), (item.data as EventData['question']).questionId)}>返回第 {group.indexOf(item) + 1} 题修改</button>)}
      </div> : null}
      {groupError ? <p role="alert">{groupError}</p> : null}
      {synchronized && (submission?.status === 'uncertain' || isRetry) && store.getSession(event.sessionId)?.agent === 'dsh'
        ? <DshQuestionRecovery event={event} questionId={data.questionId} /> : null}
      <div className="approval-actions">
        <button
          type="button"
          className="btn primary"
          disabled={busy || otherEdits.length > 0 || selected.length === 0 && text.trim() === ''}
          onClick={() => void submitAnswer()}
        >
          {checkingGroup ? '正在核对本组答案…' : group.length > 1 ? submission?.status === 'collected' ? '更新本题答案' : completesGroup ? '提交本组回答' : '保存本题答案' : '提交'}
        </button>
        {next ? <button type="button" className="btn" onClick={event_ => focusQuestion(event_.currentTarget.closest('.timeline'), (next.data as EventData['question']).questionId)}>回答下一题</button> : null}
        {data.asyncReply && ['running', 'waiting'].includes(store.getSession(event.sessionId)?.status ?? '') ? <button type="button" className="btn" data-testid="question-queue-answer" disabled={busy || otherEdits.length > 0 || selected.length === 0 && text.trim() === ''}
          onClick={() => void submitAnswer('queue')}>排队回答</button> : null}
      </div>
      </div>}
    </div>
  );
}
