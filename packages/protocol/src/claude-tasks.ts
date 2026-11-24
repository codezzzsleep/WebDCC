import type { EventKind, StoredEvent } from './events.js';
import { claudeBlockOrigin, isIncompleteClaudeOutput, orderClaudeBlocks, type ClaudeBlockOrigin } from './claude-content.js';

/** The spawning tool, native message and block identify a child output. A run
 * is attached only when the native tool-to-task join is unambiguous. */
export interface ClaudeOutputOrigin {
  agent: 'claude-code';
  nativeSessionId: string;
  parentToolUseId: string;
  nativeMessageId?: string;
  blockIndex?: number;
  taskId?: string;
  runId?: string;
}

export type ClaudeTaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'unknown';
/** WebDCC observes query lifetime independently from native system/init,
 * which the pinned CLI also emits for later turns in the same process. */
export interface ClaudeTaskRuntime { id: string; state: 'started' | 'unavailable' }
export interface ClaudeTask {
  taskId: string;
  runId?: string;
  nativeSessionId?: string;
  parentTaskId?: string;
  toolUseId?: string;
  description: string;
  status: ClaudeTaskStatus;
  /** The native lifecycle and the level signal are independent evidence. */
  nativeStatus?: string;
  backgroundPresence: 'present' | 'absent' | 'unknown';
  taskType?: string;
  subagentType?: string;
  background?: boolean;
  ambient?: boolean;
  skipTranscript?: boolean;
  spawnDepth?: number;
  workflowName?: string;
  usage?: unknown;
  summary?: string;
  outputFile?: string;
  resourceLinks?: unknown[];
  lastToolName?: string;
  error?: string;
  endTime?: number;
  totalPausedMs?: number;
  terminalNotification?: 'completed' | 'failed' | 'stopped';
  reason?: string;
  native: unknown;
}

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined;
const terminal = (status: string | undefined): boolean => status !== undefined && ['completed', 'failed', 'stopped', 'killed'].includes(status);
const taskSubtypes = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed']);

/** Current snapshot membership permits a targeted stop without inferring a
 * lifecycle phase. Known terminal or unconfirmed/absent tasks stay fenced. */
export function canStopClaudeTask(task: { status?: unknown; nativeStatus?: unknown; backgroundPresence?: unknown }): boolean {
  if (terminal(text(task.status)) || terminal(text(task.nativeStatus))) return false;
  return ['pending', 'running', 'paused'].includes(String(task.status)) || task.status === 'unknown' && task.backgroundPresence === 'present';
}

export function isClaudeTaskMessage(value: unknown): boolean {
  const message = object(value);
  return message['type'] === 'system' && taskSubtypes.has(String(message['subtype']));
}
export function claudeTaskKey(task: Pick<ClaudeTask, 'nativeSessionId' | 'taskId' | 'runId'>): string {
  return `claude-task:${JSON.stringify([task.nativeSessionId ?? null, task.taskId, task.runId ?? null])}`;
}
export function claudeTaskStatusLabel(status: string): string {
  return ({ pending: '待处理', running: '运行中', paused: '已暂停', completed: '已完成', failed: '失败', stopped: '已停止', unknown: '状态待确认' } as Record<string, string>)[status] ?? '状态待确认';
}

/** Fold the pinned SDK's task_* messages and level signal. This reducer is
 * shared by the live adapter and recovery from stored original envelopes. */
export class ClaudeTaskProjection {
  readonly tasks = new Map<string, ClaudeTask>();
  readonly runs = new Map<string, ClaudeTask>();
  private backgroundSnapshot?: Map<string, string | undefined>;
  private runtimeId?: string;
  private readonly unconfirmedLifecycle = new Set<string>();

  runtime(signal: ClaudeTaskRuntime): void {
    if (signal.state === 'started' && signal.id !== this.runtimeId) {
      this.resetLiveness();
      this.runtimeId = signal.id;
    } else if (signal.state === 'unavailable' && (this.runtimeId === undefined || signal.id === this.runtimeId)) this.resetLiveness();
  }

  event(event: Pick<StoredEvent, 'kind' | 'data' | 'native'>): void {
    const signal = object(object(event.data)['claudeTaskRuntime']);
    if (event.kind === 'internal' && text(signal['id']) !== undefined && ['started', 'unavailable'].includes(String(signal['state']))) {
      this.runtime(signal as unknown as ClaudeTaskRuntime);
    }
    this.system(event.native);
  }

  resetLiveness(): void {
    this.backgroundSnapshot = undefined;
    for (const task of this.tasks.values()) {
      task.backgroundPresence = 'unknown';
      if (!terminal(task.nativeStatus)) {
        this.unconfirmedLifecycle.add(claudeTaskKey(task));
        task.status = 'unknown';
      }
    }
  }

  system(value: unknown): boolean {
    const message = object(value);
    if (message['type'] !== 'system') return true;
    if (message['subtype'] === 'init') {
      // Legacy stored events have no observed query identity. Keep their
      // unproven restart boundary conservative instead of inferring liveness.
      if (this.runtimeId === undefined) this.resetLiveness();
      return true;
    }
    if (!isClaudeTaskMessage(message)) return true;
    const nativeSessionId = text(message['session_id']);
    if (message['subtype'] === 'background_tasks_changed') {
      const entries = message['tasks'];
      if (!Array.isArray(entries) || !entries.every(value => {
        const entry = object(value);
        return text(entry['task_id']) !== undefined && typeof entry['description'] === 'string' && typeof entry['task_type'] === 'string'
          && (entry['run_id'] === undefined || text(entry['run_id']) !== undefined);
      })) return false;
      this.backgroundSnapshot = new Map(entries.map(value => { const entry = object(value); return [String(entry['task_id']), text(entry['run_id'])]; }));
      for (const task of this.tasks.values()) {
        // An entry identifying an older run cannot rewrite the displayed run.
        if (!task.background || this.backgroundSnapshot.has(task.taskId)) continue;
        task.backgroundPresence = 'absent';
        this.status(task);
      }
      for (const value of entries) {
        const entry = object(value);
        const task = this.prepare(entry, nativeSessionId);
        if (task === undefined) continue;
        task.description = String(entry['description']);
        task.taskType = String(entry['task_type']);
        task.parentTaskId = text(entry['parent_task_id']) ?? task.parentTaskId;
        task.subagentType = text(entry['subagent_type']) ?? task.subagentType;
        task.background = true;
        task.backgroundPresence = 'present';
        task.ambient = entry['ambient'] === true;
        // Membership proves live background work, not a particular lifecycle
        // phase. It cannot turn an unknown/pending/paused task into running.
        this.status(task);
        this.save(task);
      }
      return true;
    }
    const task = this.prepare(message, nativeSessionId);
    if (task === undefined) return false;
    switch (message['subtype']) {
      case 'task_started':
        this.unconfirmedLifecycle.delete(claudeTaskKey(task));
        this.details(task, message);
        if (!terminal(task.nativeStatus)) task.nativeStatus = 'running';
        break;
      case 'task_progress':
        // A delayed progress edge cannot replace a terminal summary/output.
        if (!terminal(task.nativeStatus)) {
          this.unconfirmedLifecycle.delete(claudeTaskKey(task));
          this.details(task, message);
          task.nativeStatus = 'running';
          if (typeof message['summary'] === 'string') task.summary = message['summary'];
          if (message['usage'] !== undefined) task.usage = message['usage'];
        }
        break;
      case 'task_updated': {
        const patch = object(message['patch']);
        this.details(task, patch);
        const status = text(patch['status']);
        if (status !== undefined) this.unconfirmedLifecycle.delete(claudeTaskKey(task));
        if (status !== undefined && task.terminalNotification === undefined && (!terminal(task.nativeStatus) || terminal(status))) task.nativeStatus = status;
        if (typeof patch['error'] === 'string') task.error = patch['error'];
        if (typeof patch['end_time'] === 'number') task.endTime = patch['end_time'];
        if (typeof patch['total_paused_ms'] === 'number') task.totalPausedMs = patch['total_paused_ms'];
        break;
      }
      case 'task_notification': {
        const status = text(message['status']);
        if (status === undefined || !['completed', 'failed', 'stopped'].includes(status)) return false;
        this.unconfirmedLifecycle.delete(claudeTaskKey(task));
        task.nativeStatus = status;
        task.terminalNotification = status as ClaudeTask['terminalNotification'];
        if (typeof message['summary'] === 'string') task.summary = message['summary'];
        if (typeof message['output_file'] === 'string') task.outputFile = message['output_file'];
        if (message['usage'] !== undefined) task.usage = message['usage'];
        if (Array.isArray(message['resource_links'])) task.resourceLinks = message['resource_links'];
        this.details(task, message);
        if (typeof message['reason'] === 'string') task.reason = message['reason'];
        break;
      }
    }
    if (task.background && this.backgroundSnapshot !== undefined) {
      const run = this.backgroundSnapshot.get(task.taskId);
      if (!this.backgroundSnapshot.has(task.taskId)) task.backgroundPresence = 'absent';
      else if (run === task.runId) task.backgroundPresence = 'present';
    }
    this.status(task);
    this.save(task);
    return true;
  }

  sourceForTool(nativeSessionId: string, toolUseId: string): Pick<ClaudeOutputOrigin, 'taskId' | 'runId'> | undefined {
    const matches = [...this.runs.values()].filter(task => task.nativeSessionId === nativeSessionId && task.toolUseId === toolUseId);
    if (matches.length !== 1) return undefined;
    const task = matches[0]!;
    return { taskId: task.taskId, ...(task.runId === undefined ? {} : { runId: task.runId }) };
  }

  private save(task: ClaudeTask): void {
    const previous = this.tasks.get(task.taskId);
    if (previous !== undefined && claudeTaskKey(previous) !== claudeTaskKey(task) && !terminal(previous.nativeStatus)) {
      previous.status = 'unknown';
      previous.backgroundPresence = 'unknown';
    }
    this.tasks.set(task.taskId, task);
    this.runs.set(claudeTaskKey(task), task);
  }

  private prepare(native: Record<string, unknown>, nativeSessionId?: string): ClaudeTask | undefined {
    const taskId = text(native['task_id']);
    if (taskId === undefined) return undefined;
    const runId = text(native['run_id']);
    const previous = this.tasks.get(taskId);
    const sameSession = previous?.nativeSessionId === undefined || nativeSessionId === undefined || previous.nativeSessionId === nativeSessionId;
    // Native run IDs sort by plain string comparison. Their format is opaque.
    if (sameSession && previous?.runId !== undefined && (runId === undefined || runId < previous.runId)) return undefined;
    return sameSession && previous !== undefined && previous.runId === runId
      ? { ...previous, ...(nativeSessionId === undefined ? {} : { nativeSessionId }), native }
      : { taskId, ...(runId === undefined ? {} : { runId }), ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
          description: '', status: 'unknown', backgroundPresence: 'unknown', native };
  }

  private details(task: ClaudeTask, native: Record<string, unknown>): void {
    const strings = { description: 'description', parentTaskId: 'parent_task_id', toolUseId: 'tool_use_id', taskType: 'task_type',
      subagentType: 'subagent_type', workflowName: 'workflow_name', lastToolName: 'last_tool_name' } as const;
    for (const [field, key] of Object.entries(strings)) if (typeof native[key] === 'string') Object.assign(task, { [field]: native[key] });
    if (typeof native['is_backgrounded'] === 'boolean') task.background = native['is_backgrounded'];
    if (typeof native['spawn_depth'] === 'number') task.spawnDepth = native['spawn_depth'];
    if (typeof native['skip_transcript'] === 'boolean') task.skipTranscript = native['skip_transcript'];
    if (typeof native['ambient'] === 'boolean') task.ambient = native['ambient'];
    else if (native['skip_transcript'] === true) task.ambient = true;
  }

  private status(task: ClaudeTask): void {
    const status = task.nativeStatus === 'killed' ? 'stopped' : task.nativeStatus;
    task.status = status !== undefined && ['pending', 'running', 'paused', 'completed', 'failed', 'stopped'].includes(status) ? status as ClaudeTaskStatus : 'unknown';
    if (!terminal(task.nativeStatus) && this.unconfirmedLifecycle.has(claudeTaskKey(task))) task.status = 'unknown';
    if (task.background && task.backgroundPresence === 'absent' && !terminal(task.nativeStatus)) task.status = 'unknown';
  }
}

/** Missing tasks in a process snapshot never mean completed. Prior events
 * remain available even when reconnecting produces an empty live set. */
export function currentClaudeTasks(events: readonly StoredEvent[]): ClaudeTask[] {
  const projection = new ClaudeTaskProjection();
  for (const event of events) projection.event(event);
  return [...projection.tasks.values()];
}

export function claudeOutputOrigin(item: { data?: unknown; native?: unknown }): ClaudeOutputOrigin | undefined {
  const actor = object(object(item.data)['claudeActor']);
  if (actor['agent'] === 'claude-code' && text(actor['nativeSessionId']) !== undefined && text(actor['parentToolUseId']) !== undefined) return actor as unknown as ClaudeOutputOrigin;
  // Old persisted rows still carry the original SDK envelope.
  const native = object(item.native);
  const parent = text(native['parent_tool_use_id']);
  const session = text(native['session_id']);
  if (parent === undefined || session === undefined) return undefined;
  const message = object(native['message']);
  return { agent: 'claude-code', nativeSessionId: session, parentToolUseId: parent,
    ...(text(message['id']) === undefined ? {} : { nativeMessageId: text(message['id']) }) };
}

export interface ClaudeTaskOutput {
  itemKey: string;
  kind: EventKind;
  text: string;
  origin: ClaudeOutputOrigin;
  claudeBlock?: ClaudeBlockOrigin;
  live: boolean;
  incomplete?: boolean;
}
export interface ClaudeTaskRun extends ClaudeTask { outputs: ClaudeTaskOutput[] }
export interface ClaudeTaskView extends ClaudeTaskRun { previousRuns: ClaudeTaskRun[] }
export interface ClaudeTaskViews { tasks: ClaudeTaskView[]; unassignedOutputs: ClaudeTaskOutput[] }

function taskOutput(item: { itemKey: string; kind: EventKind; data: unknown; native?: unknown }, live: boolean): ClaudeTaskOutput | undefined {
  const origin = claudeOutputOrigin(item);
  if (origin === undefined) return undefined;
  const data = object(item.data);
  let output: string;
  switch (item.kind) {
    case 'unknown':
      if (!isIncompleteClaudeOutput(item)) return undefined;
      output = '原生不透明内容未完成（原文保留在轨迹）'; break;
    case 'assistant.message': case 'reasoning': output = String(data['text'] ?? ''); break;
    case 'command': output = `$ ${String(data['command'] ?? '')}\n${String(data['outputTail'] ?? '')}`; break;
    case 'tool.call': output = `${String(data['name'] ?? '')}\n${typeof data['output'] === 'string' ? data['output'] : JSON.stringify(data['output'] ?? data['input'])}`; break;
    case 'file.read': output = `读取 ${String(data['path'] ?? '')}${typeof data['output'] === 'string' ? `\n${data['output']}` : typeof data['error'] === 'string' ? `\n${data['error']}` : ''}`; break;
    case 'file.change': output = `编辑 ${JSON.stringify(data['changes'] ?? [])}${typeof data['output'] === 'string' ? `\n${data['output']}` : typeof data['error'] === 'string' ? `\n${data['error']}` : ''}`; break;
    default: return undefined;
  }
  const block = claudeBlockOrigin(item);
  return { itemKey: item.itemKey, kind: item.kind, text: output, origin, live, ...(block === undefined ? {} : { claudeBlock: block }),
    ...(isIncompleteClaudeOutput(item) ? { incomplete: true } : {}) };
}

/** Includes previous runs without attributing an ambiguous legacy output to
 * the newest run. Live items are the same keyed blocks before persistence. */
export function currentClaudeTaskViews(events: readonly StoredEvent[], live: readonly { itemKey: string; kind: EventKind; data: unknown }[] = []): ClaudeTaskViews {
  const projection = new ClaudeTaskProjection();
  for (const event of events) projection.event(event);
  const runs = new Map<string, ClaudeTaskRun>([...projection.runs].map(([key, task]) => [key, { ...task, outputs: [] }]));
  const outputs = new Map<string, ClaudeTaskOutput>();
  for (const item of events) { const output = taskOutput(item, false); if (output !== undefined) outputs.set(item.itemKey, output); }
  for (const item of live) { const output = taskOutput(item, true); if (output !== undefined) outputs.set(item.itemKey, output); }
  const unassignedOutputs: ClaudeTaskOutput[] = [];
  for (const output of orderClaudeBlocks([...outputs.values()])) {
    const origin = output.origin;
    const matches = [...runs.values()].filter(task => task.nativeSessionId === origin.nativeSessionId && (origin.taskId === undefined
      ? task.toolUseId === origin.parentToolUseId : task.taskId === origin.taskId && task.runId === origin.runId));
    if (matches.length === 1) matches[0]!.outputs.push(output);
    else unassignedOutputs.push(output);
  }
  const tasks = [...projection.tasks.values()].map(task => ({ ...runs.get(claudeTaskKey(task))!, previousRuns: [...runs.values()]
    .filter(run => run.nativeSessionId === task.nativeSessionId && run.taskId === task.taskId && run.runId !== task.runId) }));
  return { tasks, unassignedOutputs };
}

export interface ClaudeTaskNode { task: ClaudeTaskView; children: ClaudeTaskNode[] }
export function claudeTaskTree(tasks: readonly ClaudeTaskView[]): ClaudeTaskNode[] {
  const key = (task: Pick<ClaudeTask, 'nativeSessionId' | 'taskId'>) => JSON.stringify([task.nativeSessionId ?? null, task.taskId]);
  const nodes = new Map(tasks.map(task => [key(task), { task, children: [] as ClaudeTaskNode[] }]));
  const roots: ClaudeTaskNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(key({ ...node.task, taskId: node.task.parentTaskId ?? '' }));
    const seen = new Set([key(node.task)]);
    let current = parent;
    let cycle = false;
    while (current !== undefined) {
      if (seen.has(key(current.task))) { cycle = true; break; }
      seen.add(key(current.task));
      current = nodes.get(key({ ...current.task, taskId: current.task.parentTaskId ?? '' }));
    }
    if (parent === undefined || cycle) roots.push(node);
    else parent.children.push(node);
  }
  return roots;
}
