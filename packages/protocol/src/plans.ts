import type { EventKind } from './events.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Read the native Markdown document, including old rows which retained the
 * original ThreadItem but projected only an empty checklist. */
export function nativePlanText(item: { kind: EventKind; data: unknown; native?: unknown }): string | undefined {
  if (item.kind !== 'plan') return undefined;
  const data = record(item.data);
  if (typeof data?.['text'] === 'string') return data['text'];
  const native = record(item.native);
  return native?.['type'] === 'plan' && typeof native['text'] === 'string' ? native['text'] : undefined;
}
