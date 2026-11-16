import type { StoredEvent } from './events.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Codex's explicit refusal means no command or proposed patch was applied.
 * Read the original item so older successful-looking rows remain recoverable. */
export function nativeOperationDeclined(event: Pick<StoredEvent, 'kind' | 'native'>): boolean {
  const native = record(event.native);
  return native['status'] === 'declined' && (event.kind === 'command' && native['type'] === 'commandExecution'
    || event.kind === 'file.change' && native['type'] === 'fileChange');
}

/** Read older events from their own native tool result; never use a sibling
 * failed result in the same SDK message as evidence for this operation. */
export function failedFileOperation(event: StoredEvent): boolean {
  if (event.kind !== 'file.read' && event.kind !== 'file.change' && event.kind !== 'turn.diff') return false;
  if (nativeOperationDeclined(event)) return true;
  if (record(event.data)['status'] === 'failed') return true;
  const native = record(event.native);
  if (native['type'] === 'tool/result' && record(record(native['data'])['message'])['isError'] === true) return true;
  const content = record(native['message'])['content'];
  return Array.isArray(content) && content.map(record).some(block => block['type'] === 'tool_result'
    && event.itemKey === `tool-${String(block['tool_use_id'])}` && block['is_error'] === true);
}

export function fileOperationError(event: StoredEvent): string | undefined {
  const data = record(event.data);
  if (typeof data['error'] === 'string') return data['error'];
  if (!failedFileOperation(event)) return undefined;
  const native = record(event.native);
  const dsh = record(record(native['data'])['message'])['content'];
  if (Array.isArray(dsh)) return dsh.map(part => String(record(part)['text'] ?? '')).join('');
  const content = record(native['message'])['content'];
  const block = Array.isArray(content) ? content.map(record).find(part => event.itemKey === `tool-${String(part['tool_use_id'])}`) : undefined;
  if (typeof block?.['content'] === 'string') return block['content'];
  return undefined;
}
