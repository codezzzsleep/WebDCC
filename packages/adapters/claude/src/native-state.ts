import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeTaskProjection } from '@webdcc/protocol';
import { record } from './native.js';

export type { ClaudeTask } from '@webdcc/protocol';
export interface ClaudePlanTask {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
  description?: string;
  owner?: string;
  blockedBy?: string[];
}
export class ClaudeNativeState {
  readonly taskProjection = new ClaudeTaskProjection();
  readonly tasks = this.taskProjection.tasks;
  readonly plans = new Map<string, ClaudePlanTask>();
  usage?: unknown;
  rateLimit?: unknown;
  auth?: unknown;
  structuredOutput?: unknown;
  transport: 'live' | 'closed' | 'failed' = 'live';

  system(message: Extract<SDKMessage, { type: 'system' }>): boolean {
    return this.taskProjection.system(message);
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
      if (to === 'deleted') return this.plans.delete(result['taskId']);
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
