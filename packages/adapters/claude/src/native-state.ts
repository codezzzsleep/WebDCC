import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { record } from './native.js';

export interface ClaudeTask {
  taskId: string;
  runId?: string;
  parentTaskId?: string;
  toolUseId?: string;
  description: string;
  status: string;
  taskType?: string;
  background?: boolean;
  ambient?: boolean;
  usage?: unknown;
  summary?: string;
  outputFile?: string;
  error?: string;
  native: unknown;
}
export interface ClaudePlanTask {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
  description?: string;
  owner?: string;
  blockedBy?: string[];
}
/** Native run IDs are ordered only by plain lexical comparison, never parsed as numbers. */
export class ClaudeNativeState {
  readonly tasks = new Map<string, ClaudeTask>();
  readonly plans = new Map<string, ClaudePlanTask>();
  usage?: unknown;
  rateLimit?: unknown;
  auth?: unknown;
  structuredOutput?: unknown;
  transport: 'live' | 'closed' | 'failed' = 'live';

  system(message: Extract<SDKMessage, { type: 'system' }>): boolean {
    if (message.subtype === 'background_tasks_changed') {
      // This snapshot owns liveness; preserve completed rows for inspection.
      const alive = new Set(message.tasks.map(task => task.task_id));
      for (const task of this.tasks.values()) if (task.background && !alive.has(task.taskId) && ['pending', 'running', 'paused'].includes(task.status)) task.status = 'not-in-background-snapshot';
      for (const entry of message.tasks) {
        const raw = record(entry);
        const existing = this.tasks.get(entry.task_id);
        if (existing?.runId !== undefined && entry.run_id !== undefined && entry.run_id < existing.runId) continue;
        this.tasks.set(entry.task_id, { ...existing, taskId: entry.task_id, runId: entry.run_id, description: entry.description,
          taskType: entry.task_type, background: true, status: 'running', ambient: raw['ambient'] === true, native: entry });
      }
      return true;
    }
    if (!['task_started', 'task_progress', 'task_notification', 'task_updated'].includes(message.subtype)) return true;
    const raw = record(message);
    const id = String(raw['task_id']);
    const runId = typeof raw['run_id'] === 'string' ? raw['run_id'] : undefined;
    const previous = this.tasks.get(id);
    if (previous?.runId !== undefined && (runId === undefined || runId < previous.runId)) return false;
    const sameRun = previous === undefined || previous.runId === runId;
    const task: ClaudeTask = sameRun && previous !== undefined ? { ...previous, native: message } : { taskId: id, runId, description: '', status: 'running', native: message };
    if (message.subtype === 'task_started') Object.assign(task, { description: message.description, taskType: message.task_type,
      parentTaskId: message.parent_task_id, background: message.is_backgrounded, toolUseId: message.tool_use_id, ambient: message.ambient ?? message.skip_transcript });
    if (message.subtype === 'task_progress') Object.assign(task, { description: message.description, summary: message.summary, usage: message.usage, toolUseId: message.tool_use_id });
    if (message.subtype === 'task_updated') Object.assign(task, { ...(message.patch.description === undefined ? {} : { description: message.patch.description }),
      ...(message.patch.status === undefined ? {} : { status: message.patch.status }), ...(message.patch.is_backgrounded === undefined ? {} : { background: message.patch.is_backgrounded }),
      ...(message.patch.error === undefined ? {} : { error: message.patch.error }) });
    if (message.subtype === 'task_notification') Object.assign(task, { status: message.status, summary: message.summary, usage: message.usage, outputFile: message.output_file });
    this.tasks.set(id, task);
    return true;
  }
  /** Only successful structured native results may create or update task identities. */
  toolResult(name: string, _input: Record<string, unknown>, output: unknown, failed: boolean): boolean {
    if (failed) return false;
    const result = record(output);
    const task = record(result['task']);
    if (name === 'TaskCreate' && typeof task['id'] === 'string' && typeof task['subject'] === 'string') {
      this.plans.set(task['id'], { id: task['id'], text: task['subject'], status: 'pending', ...(typeof task['description'] === 'string' ? { description: task['description'] } : {}) });
      return true;
    }
    if (name === 'TaskUpdate' && result['success'] === true && typeof result['taskId'] === 'string') {
      const existing = this.plans.get(result['taskId']);
      if (existing === undefined) return false;
      const to = record(result['statusChange'])['to'];
      if (to === 'pending' || to === 'in_progress' || to === 'completed') existing.status = to;
      // updatedFields names changes but does not echo their stored values. A PreToolUse hook
      // can change them, so subject/owner wait for the authoritative TaskGet/TaskList output.
      return true;
    }
    if (name === 'TaskList' && Array.isArray(result['tasks'])) {
      if (!result['tasks'].every(value => { const task = record(value); return typeof task['id'] === 'string' && typeof task['subject'] === 'string' && ['pending', 'in_progress', 'completed'].includes(String(task['status'])); })) return false;
      this.plans.clear();
      for (const value of result['tasks']) this.plan(record(value));
      return true;
    }
    if (name === 'TaskGet' && typeof task['id'] === 'string') { this.plan(task); return true; }
    return false;
  }
  private plan(value: Record<string, unknown>): void {
    if (typeof value['id'] !== 'string' || typeof value['subject'] !== 'string' || !['pending', 'in_progress', 'completed'].includes(String(value['status']))) return;
    this.plans.set(value['id'], { id: value['id'], text: value['subject'], status: value['status'] as ClaudePlanTask['status'],
      ...(typeof value['owner'] === 'string' ? { owner: value['owner'] } : {}), ...(Array.isArray(value['blockedBy']) ? { blockedBy: value['blockedBy'].filter((id): id is string => typeof id === 'string') } : {}) });
  }
}
