import type { DshSubagentIdentity, DshSubagentSummary, DshSubagentState, DshSubagentRecord } from '@webdcc/protocol';
import { dshNativeError } from './native.js';
import type { DshPage, DshSessionAddress } from './contracts.js';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The catalog is membership, not a lifecycle notification. */
export function dshSubagentCatalog(parentSessionId: string, value: unknown): DshSubagentIdentity[] {
  if (!Array.isArray(value)) throw dshNativeError('DSH 未提供可确认的子 Agent 目录', 409);
  const seen = new Set<string>();
  return value.map(raw => {
    const row = object(raw);
    if (typeof row['id'] !== 'string' || row['id'] === '' || row['id'] === parentSessionId || seen.has(row['id'])
      || !['continuable', 'one-shot', 'external', 'unknown'].includes(String(row['mode']))
      || !Number.isSafeInteger(row['createdAt']) || (row['createdAt'] as number) < 0
      || row['mode'] === 'continuable' && typeof row['label'] !== 'string'
      || row['label'] !== undefined && typeof row['label'] !== 'string'
      || row['name'] !== undefined && typeof row['name'] !== 'string') throw dshNativeError('DSH 子 Agent 目录身份无效', 409);
    seen.add(row['id']);
    return { parentSessionId, childId: row['id'], createdAt: row['createdAt'] as number, mode: row['mode'] as DshSubagentIdentity['mode'],
      ...(typeof row['name'] === 'string' ? { name: row['name'] } : {}), ...(typeof row['label'] === 'string' ? { label: row['label'] } : {}) };
  });
}

export function dshSubagentAddress(child: DshSubagentIdentity): DshSessionAddress & { kind: 'subagent' } {
  if (child.mode === 'external') throw dshNativeError('外部子 Agent 没有可查看的本地原生子会话', 409);
  return { kind: 'subagent', parentSessionId: child.parentSessionId, childSessionId: child.childId, mode: child.mode };
}

/** Validate a whole contiguous native window before exposing any of it. */
export function checkDshSubagentPage(page: DshPage, throughSeq?: number, beforeSeq?: number): void {
  if (!Number.isSafeInteger(page.cursor) || page.cursor < -1 || throughSeq !== undefined && page.cursor !== throughSeq
    || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') throw dshNativeError('DSH 子会话历史水位无效', 409);
  let previous: number | undefined;
  for (const record of page.records) {
    const seq = record.event?.seq;
    if (record.type !== 'event' || !Number.isSafeInteger(seq) || seq < 0 || seq > page.cursor
      || beforeSeq !== undefined && seq >= beforeSeq || previous !== undefined && seq !== previous + 1
      || typeof record.event.type !== 'string' || !Number.isFinite(record.event.time)) throw dshNativeError('DSH 子会话历史存在缺口或身份无效', 409);
    previous = seq;
  }
  if (page.hasMore && page.records.length === 0) throw dshNativeError('DSH 子会话历史分页没有推进', 409);
  if (beforeSeq === undefined && (previous ?? -1) !== page.cursor) throw dshNativeError('DSH 子会话历史未覆盖声明水位', 409);
}

export function dshSubagentText(record: DshSubagentRecord): string | undefined {
  if (record.event.type !== 'assistant/message') return undefined;
  const content = object(object(record.event.data)['message'])['content'];
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap(block => { const part = object(block); return part['type'] === 'text' && typeof part['text'] === 'string' ? [part['text']] : []; }).join('\n');
  return text === '' ? undefined : text;
}

export function dshSubagentSummary(child: DshSubagentIdentity, state: DshSubagentState, page: DshPage): DshSubagentSummary {
  const end = page.records.findLast(record => record.event.type === 'turn/end');
  const start = page.records.findLast(record => record.event.type === 'turn/start');
  const data = object(end?.event.data);
  const reason = object(data['reason'])['kind'];
  let status: DshSubagentSummary['status'] = 'unknown';
  if (state.pendingInput.length > 0) status = 'waiting';
  else if (state.running) status = 'running';
  else if ((state.queue?.length ?? 0) > 0) status = 'pending';
  else if (end !== undefined && (start === undefined || end.event.seq > start.event.seq)) {
    if (reason === 'completed') status = 'completed';
    else if (['interrupted', 'cancelled', 'aborted'].includes(String(reason))) status = 'stopped';
    else if (['error', 'failed', 'max-tokens', 'refusal'].includes(String(reason))) status = 'failed';
  } else if (start === undefined && state.active) status = 'idle';
  const lastText = page.records.findLast(record => dshSubagentText(record) !== undefined);
  return { ...child, status, state,
    ...(end === undefined ? {} : { lastTurn: { seq: end.event.seq, ...(typeof data['turn'] === 'number' ? { turn: data['turn'] } : {}), reason: data['reason'] } }),
    ...(lastText === undefined ? {} : { result: { seq: lastText.event.seq, text: dshSubagentText(lastText)! } }) };
}
