import type { EventData } from './events.js';

/** The caller's native lifecycle, independent of agentsStates and child turns. */
export function codexCollabCallStatus(data: EventData['tool.call']): EventData['tool.call']['status'] | undefined {
  if (data.name !== 'collabAgentToolCall' || data.input === null || typeof data.input !== 'object' || Array.isArray(data.input)) return undefined;
  const input = data.input as Record<string, unknown>;
  if (input['type'] !== 'collabAgentToolCall') return undefined;
  switch (Object.hasOwn(input, 'status') ? input['status'] : undefined) {
    case 'inProgress': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'interrupted': return 'stopped';
    default: return 'unknown';
  }
}

export function codexCollabCallStatusLabel(status: EventData['tool.call']['status']): string {
  switch (status) {
    case 'running': return '运行中';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'stopped': return '已中断';
    default: return '状态待确认';
  }
}
