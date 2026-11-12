import type { AdapterEvent, TraceFrame } from '@webdcc/protocol';
import { mapItemData, mapItemKind, parseUnifiedDiff, routeNotification } from './adapter.js';

/** Notifications containing only a text/output delta are intentionally not
 * persisted; their completed item carries the authoritative value. */
export const DELTA_FRAMES = new Set(['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/commandExecution/outputDelta']);

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function nativeTurnId(params: Record<string, unknown>): string | undefined {
  if (typeof params['turnId'] === 'string') return params['turnId'];
  const turn = record(params['turn']);
  if (typeof turn['id'] === 'string') return turn['id'];
  const item = record(params['item']);
  return typeof item['turnId'] === 'string' ? item['turnId'] : undefined;
}
function key(prefix: string, frame: TraceFrame, nativeId?: unknown, stable = true): string {
  return `${prefix}-${stable && typeof nativeId === 'string' && nativeId !== '' ? nativeId : `${frame.ch}-${frame.i}`}`;
}

export class CodexTranslator {
  feed(frame: TraceFrame): AdapterEvent[] {
    const raw = record(frame.frame);
    if (frame.dir === 'out') return [{ type: 'item.complete', itemKey: key('rpc-out', frame), kind: 'internal', data: { nativeType: `rpc/out:${String(raw['method'] ?? '')}` }, native: raw }];
    const method = String(raw['method'] ?? '');
    const params = record(raw['params']);
    const route = routeNotification(method);
    const turn = nativeTurnId(params);
    switch (route) {
      case 'turn/started': return [{ type: 'turn.start', ...(turn === undefined ? {} : { nativeTurnId: turn }), native: params }];
      case 'turn/completed': {
        const data = record(params['turn']);
        const status = data['status'] === 'interrupted' ? 'interrupted' : data['status'] === 'failed' ? 'failed' : 'completed';
        return [{ type: 'turn.end', status, ...(turn === undefined ? {} : { nativeTurnId: turn }), native: params }];
      }
      case 'item/started': {
        const item = record(params['item']);
        const type = String(item['type'] ?? '');
        const kind = mapItemKind(type);
        return [{ type: 'item.start', itemKey: key('item', frame, item['id']), kind, data: mapItemData(item), ...(turn === undefined ? {} : { nativeTurnId: turn }), native: item }];
      }
      case 'item/completed': {
        const item = record(params['item']);
        const type = String(item['type'] ?? '');
        const kind = mapItemKind(type);
        return [{ type: 'item.complete', itemKey: key('item', frame, item['id']), kind, data: mapItemData(item), ...(turn === undefined ? {} : { nativeTurnId: turn }), native: item }];
      }
      case 'agentMessage/delta': return [{ type: 'item.delta', itemKey: key('message', frame, params['itemId']), field: 'text', append: String(params['delta'] ?? '') }];
      case 'reasoning/summaryTextDelta': return [{ type: 'item.delta', itemKey: key('reasoning', frame, params['itemId']), field: 'text', append: String(params['delta'] ?? '') }];
      case 'commandExecution/outputDelta': return [{ type: 'item.delta', itemKey: key('command', frame, params['itemId']), field: 'output', append: String(params['delta'] ?? '') }];
      case 'diff/updated': {
        const changes = parseUnifiedDiff(String(params['diff'] ?? '')).map(({ path, kind, added, removed, diff }) => ({ path, kind, added, removed, diff }));
        return [{ type: 'item.complete', itemKey: key('diff', frame, undefined, false), kind: 'turn.diff', data: { changes, status: 'completed' }, ...(turn === undefined ? {} : { nativeTurnId: turn }), native: params }];
      }
      case 'notice': return [{ type: 'item.complete', itemKey: key('notice', frame, undefined, false), kind: 'notice', data: { level: method === 'warning' ? 'warning' : 'info', text: String(params['summary'] ?? params['message'] ?? method), nativeType: method }, native: params }];
      case 'internal': return [{ type: 'item.complete', itemKey: key('internal', frame, undefined, false), kind: 'internal', data: { nativeType: method }, native: params }];
      default: return [{ type: 'item.complete', itemKey: key('unknown', frame, undefined, false), kind: 'unknown', data: { nativeType: method }, native: params }];
    }
  }
}

export function translateCodexFrame(frame: TraceFrame): AdapterEvent[] { return new CodexTranslator().feed(frame); }
