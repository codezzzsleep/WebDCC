import type { StoredEvent } from './events.js';

export type ClaudeTaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'unknown';
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
  private backgroundSnapshot?: Map<string, string | undefined>;

  resetLiveness(): void {
    this.backgroundSnapshot = undefined;
    for (const task of this.tasks.values()) {
      task.backgroundPresence = 'unknown';
      if (!terminal(task.nativeStatus)) task.status = 'unknown';
    }
  }

  system(value: unknown): boolean {
    const message = object(value);
    if (message['type'] !== 'system') return true;
    if (message['subtype'] === 'init') { this.resetLiveness(); return true; }
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
        this.tasks.set(task.taskId, task);
      }
      return true;
    }
    const task = this.prepare(message, nativeSessionId);
    if (task === undefined) return false;
    switch (message['subtype']) {
      case 'task_started':
        this.details(task, message);
        if (!terminal(task.nativeStatus)) task.nativeStatus = 'running';
        break;
      case 'task_progress':
        // A delayed progress edge cannot replace a terminal summary/output.
        if (!terminal(task.nativeStatus)) {
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
        if (status !== undefined && task.terminalNotification === undefined && (!terminal(task.nativeStatus) || terminal(status))) task.nativeStatus = status;
        if (typeof patch['error'] === 'string') task.error = patch['error'];
        if (typeof patch['end_time'] === 'number') task.endTime = patch['end_time'];
        if (typeof patch['total_paused_ms'] === 'number') task.totalPausedMs = patch['total_paused_ms'];
        break;
      }
      case 'task_notification': {
        const status = text(message['status']);
        if (status === undefined || !['completed', 'failed', 'stopped'].includes(status)) return false;
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
    this.tasks.set(task.taskId, task);
    return true;
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
    if (task.background && task.backgroundPresence === 'absent' && !terminal(task.nativeStatus)) task.status = 'unknown';
  }
}

/** Missing tasks in a process snapshot never mean completed. Prior events
 * remain available even when reconnecting produces an empty live set. */
export function currentClaudeTasks(events: readonly StoredEvent[]): ClaudeTask[] {
  const projection = new ClaudeTaskProjection();
  for (const event of events) projection.system(event.native);
  return [...projection.tasks.values()];
}
