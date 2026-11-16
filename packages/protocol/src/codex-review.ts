import type { StoredEvent } from './events.js';

export interface CodexReviewItem { phase: 'started' | 'finished'; text: string }

/** Read original native Review text, including native fallback/error text. */
export function codexReviewItem(event: Pick<StoredEvent, 'kind' | 'native'>): CodexReviewItem | undefined {
  if (event.kind !== 'tool.call' || event.native === null || typeof event.native !== 'object') return undefined;
  const native = event.native as { type?: unknown; review?: unknown };
  if (typeof native.review !== 'string') return undefined;
  if (native.type === 'enteredReviewMode') return { phase: 'started', text: native.review };
  if (native.type === 'exitedReviewMode') return { phase: 'finished', text: native.review };
  return undefined;
}
