import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterEvent } from '@webdcc/protocol';

export function claudeSystemEvent(message: Extract<SDKMessage, { type: 'system' }>, sequence: number): AdapterEvent {
  const key = `system-${message.subtype}-${message.uuid ?? sequence}`;
  switch (message.subtype) {
    case 'init': return { type: 'item.complete', itemKey: key, kind: 'internal', data: { nativeType: 'system/init' }, native: message };
    case 'compact_boundary': return { type: 'item.complete', itemKey: key, kind: 'notice', data: { level: 'info', text: 'Claude 已压缩会话上下文', nativeType: 'system/compact_boundary' }, native: message };
    case 'status': return { type: 'item.complete', itemKey: key, kind: message.status === null ? 'internal' : 'notice', data: message.status === null ? { nativeType: 'system/status' } : { level: 'info', text: message.status === 'compacting' ? 'Claude 正在压缩会话上下文' : String(message.status), nativeType: 'system/status' }, native: message };
    case 'task_started':
    case 'task_progress':
    case 'task_notification': {
      const status = message.subtype === 'task_notification' ? message.status === 'failed' ? 'failed' : 'completed' : 'running';
      const label = 'description' in message ? message.description : message.summary;
      return { type: 'item.complete', itemKey: `claude-task-${message.task_id}-${message.run_id ?? 'legacy'}`, kind: 'tool.call', data: { name: 'claude-task', label, status, input: { taskId: message.task_id, runId: message.run_id, toolUseId: message.tool_use_id, ...(message.subtype === 'task_notification' ? { nativeStatus: message.status, outputFile: message.output_file } : {}) }, ...(message.subtype === 'task_notification' ? { output: message.summary } : {}) }, native: message };
    }
    default: return { type: 'item.complete', itemKey: key, kind: 'unknown', data: { nativeType: `system/${message.subtype}` }, native: message };
  }
}
