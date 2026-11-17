import type { EventData } from './events.js';

/** Status strings emitted by the reviewed official 0.169 image extension. */
export function codexNativeImageStatus(data: EventData['tool.call']): EventData['tool.call']['status'] | undefined {
  if (data.name !== 'imageGeneration' || data.input === null || typeof data.input !== 'object' || Array.isArray(data.input)) return undefined;
  const input = data.input as Record<string, unknown>;
  if (input['type'] !== 'imageGeneration') return undefined;
  switch (Object.hasOwn(input, 'status') ? input['status'] : undefined) {
    case 'in_progress': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    default: return 'unknown';
  }
}
