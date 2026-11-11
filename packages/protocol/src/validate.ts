/** 每种事件 kind 的数据校验（SPEC-M8 F2）：adapter 发送前、前端渲染前各校验一次 */
import type { EventData, EventKind } from './events.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidEventData<K extends EventKind>(kind: K, data: unknown): data is EventData[K] {
  if (!isRecord(data)) return false;
  switch (kind) {
    case 'user.message':
      return typeof data['text'] === 'string';
    case 'assistant.message':
      return typeof data['text'] === 'string';
    case 'reasoning':
      return typeof data['text'] === 'string';
    case 'command':
      return typeof data['command'] === 'string' && typeof data['status'] === 'string';
    case 'file.read':
      return typeof data['path'] === 'string';
    case 'file.change':
      return Array.isArray(data['changes']) && typeof data['status'] === 'string';
    case 'tool.call':
      return typeof data['name'] === 'string' && typeof data['status'] === 'string';
    case 'plan':
      return (
        Array.isArray(data['items']) &&
        (data['items'] as unknown[]).every(
          (item) => isRecord(item) && typeof item['text'] === 'string' && typeof item['status'] === 'string',
        )
      );
    case 'goal':
      return typeof data['objective'] === 'string' && typeof data['status'] === 'string';
    case 'notice':
      return typeof data['text'] === 'string' && typeof data['level'] === 'string';
    case 'approval.request':
      return typeof data['approvalId'] === 'string' && typeof data['title'] === 'string' && Array.isArray(data['options']);
    case 'approval.resolved':
      return typeof data['approvalId'] === 'string' && typeof data['optionId'] === 'string';
    case 'question':
      return typeof data['questionId'] === 'string' && typeof data['prompt'] === 'string';
    case 'turn.started':
      return true;
    case 'turn.completed':
      return typeof data['status'] === 'string' && typeof data['durationMs'] === 'number';
    case 'usage':
      return isRecord(data);
    case 'error':
      return typeof data['message'] === 'string';
    case 'unknown':
    case 'internal':
      return typeof data['nativeType'] === 'string';
    default:
      return false;
  }
}
