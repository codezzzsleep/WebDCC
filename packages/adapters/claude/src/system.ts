import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeTaskKey, claudeTaskStatusLabel, type AdapterEvent, type ClaudeTask } from '@webdcc/protocol';

export function claudeSystemEvent(message: Extract<SDKMessage, { type: 'system' }>, sequence: number, task?: ClaudeTask): AdapterEvent {
  const key = `system-${message.subtype}-${message.uuid ?? sequence}`;
  switch (message.subtype) {
    case 'init': return { type: 'item.complete', itemKey: key, kind: 'internal', data: { nativeType: 'system/init' }, native: message };
    case 'background_tasks_changed': return { type: 'item.complete', itemKey: key, kind: 'internal', data: { nativeType: 'system/background_tasks_changed' }, native: message, scope: 'session' };
    case 'compact_boundary': return { type: 'item.complete', itemKey: key, kind: 'notice', data: { level: 'info', text: 'Claude 已压缩会话上下文', nativeType: 'system/compact_boundary' }, native: message };
    case 'local_command_output': return { type: 'item.complete', itemKey: key, kind: 'assistant.message', data: { text: message.content }, native: message };
    case 'status': return { type: 'item.complete', itemKey: key, kind: message.status === null ? 'internal' : 'notice', data: message.status === null ? { nativeType: 'system/status' } : { level: 'info', text: message.status === 'compacting' ? 'Claude 正在压缩会话上下文' : String(message.status), nativeType: 'system/status' }, native: message };
    case 'task_started':
    case 'task_progress':
    case 'task_updated':
    case 'task_notification': {
      const status = task?.status ?? (message.subtype === 'task_notification' ? message.status : message.subtype === 'task_updated' ? 'unknown' : 'running');
      const description = task?.description || ('description' in message ? message.description : 'summary' in message ? message.summary : 'Claude 任务');
      return { type: 'item.complete', itemKey: claudeTaskKey(task ?? { taskId: message.task_id, runId: message.run_id, nativeSessionId: message.session_id }), kind: 'tool.call',
        data: { name: 'claude-task', label: `${description} · ${claudeTaskStatusLabel(status)}`, status,
          input: { taskId: message.task_id, runId: message.run_id, nativeSessionId: message.session_id,
            parentTaskId: task?.parentTaskId, toolUseId: task?.toolUseId, nativeStatus: task?.nativeStatus ?? (message.subtype === 'task_notification' ? message.status : undefined),
            outputFile: task?.outputFile }, ...(task?.summary === undefined ? {} : { output: task.summary }) }, native: message, scope: 'session' };
    }
    default: return { type: 'item.complete', itemKey: key, kind: 'unknown', data: { nativeType: `system/${message.subtype}` }, native: message };
  }
}
