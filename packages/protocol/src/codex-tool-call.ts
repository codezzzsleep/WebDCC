import type { EventData } from './events.js';

/** Native call status or explicit item phase; no inference from results or success. */
export function codexNativeToolStatus(data: EventData['tool.call']): EventData['tool.call']['status'] | undefined {
  if (data.name !== 'mcpToolCall' && data.name !== 'dynamicToolCall' && data.name !== 'webSearch') return undefined;
  if (data.input === null || typeof data.input !== 'object' || Array.isArray(data.input)) return undefined;
  const input = data.input as Record<string, unknown>;
  if (input['type'] !== data.name) return undefined;
  if (data.name === 'webSearch') {
    if (data.codexItemPhase === 'started') return 'running';
    if (data.codexItemPhase === 'completed') return 'completed';
    if (data.codexItemPhase !== undefined) return 'unknown';
    const completedAt = input['completedAtMs'];
    return typeof completedAt === 'number' && Number.isSafeInteger(completedAt) && completedAt >= 0 ? 'completed' : 'unknown';
  }
  switch (Object.hasOwn(input, 'status') ? input['status'] : undefined) {
    case 'inProgress': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    default: return 'unknown';
  }
}

export function codexNativeToolStatusLabel(status: EventData['tool.call']['status']): string {
  switch (status) {
    case 'running': return '运行中';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    default: return '状态待确认';
  }
}
