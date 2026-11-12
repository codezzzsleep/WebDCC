import type { AdapterEvent, EventData, EventKind, TraceFrame } from '@webdcc/protocol';
import { buildFileChanges, isValidEventData } from '@webdcc/protocol';

export const DELTA_FRAMES = new Set(['assistant-stream:chunk:text-delta', 'assistant-stream:chunk:reasoning-delta']);
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}; }
function key(prefix: string, frame: TraceFrame, id?: unknown): string { return `${prefix}-${typeof id === 'string' || typeof id === 'number' ? id : `${frame.ch}-${frame.i}`}`; }

export class DshTranslator {
  feed(frame: TraceFrame): AdapterEvent[] {
    const raw = record(frame.frame);
    if (frame.dir === 'out') return [{ type: 'item.complete', itemKey: key('rpc-out', frame, raw['endpoint']), kind: 'internal', data: { nativeType: `rpc/out:${String(raw['endpoint'] ?? '')}` }, native: raw }];
    const value = record(raw['value']);
    const event = record(value['event']);
    const type = String(event['type'] ?? value['type'] ?? '');
    const data = record(event['data'] ?? value['data']);
    const nativeSeq = Number(event['seq'] ?? value['seq'] ?? frame.i);
    const nativeTurnId = typeof data['turnId'] === 'string' ? data['turnId'] : undefined;
    if (type === 'turn/start') return [{ type: 'turn.start', ...(nativeTurnId === undefined ? {} : { nativeTurnId }), native: raw }];
    if (type === 'turn/end') {
      const reason = record(data['reason']);
      return [{ type: 'turn.end', nativeTurnId, status: ['interrupted', 'cancelled', 'aborted'].includes(String(reason['kind'])) ? 'interrupted' : ['failed', 'error'].includes(String(reason['kind'])) ? 'failed' : 'completed', native: raw }];
    }
    if (type === 'tool/call') {
      const id = data['callId'] ?? nativeSeq;
      const name = String(data['name'] ?? '');
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(String(data['arguments'] ?? '{}')) as Record<string, unknown>; } catch { /* retain empty input */ }
      const kind: EventKind = name === 'bash' ? 'command' : ['read', 'glob', 'grep'].includes(name) ? 'file.read' : ['write', 'edit'].includes(name) ? 'file.change' : 'tool.call';
      const eventData: EventData['command'] | EventData['file.read'] | EventData['file.change'] | EventData['tool.call'] = kind === 'command'
        ? { command: String(input['command'] ?? ''), status: 'running' }
        : kind === 'file.read'
          ? { path: String(input['file_path'] ?? input['pattern'] ?? '') }
          : kind === 'file.change'
            ? { changes: buildFileChanges(name, input), status: 'running' }
            : { name, input, status: 'running' };
      return [{ type: 'item.start', itemKey: key('tool', frame, id), kind, data: eventData, nativeTurnId, native: raw }];
    }
    if (type === 'assistant/message') {
      const message = record(data['message']);
      const content = Array.isArray(message['content']) ? message['content'] as unknown[] : [];
      const text = content.map((item) => record(item)).filter((item) => item['type'] === 'text').map((item) => String(item['text'] ?? '')).join('\n');
      return [{ type: 'item.complete', itemKey: key('message', frame, nativeSeq), kind: 'assistant.message', data: { text }, nativeSeq, nativeTurnId, native: raw }];
    }
    if (type === 'tool/result') return [{ type: 'item.complete', itemKey: key('tool', frame, data['toolCallId'] ?? nativeSeq), kind: 'tool.call', data: { name: 'tool', input: {}, status: 'completed', output: data['message'] }, nativeSeq, nativeTurnId, native: raw }];
    if (type === 'todo/write') return [{ type: 'item.complete', itemKey: key('plan', frame, nativeSeq), kind: 'plan', data: { items: [] }, nativeSeq, nativeTurnId, native: raw }];
    const kind = type === '' ? 'unknown' : 'internal';
    const dataOut = { nativeType: type || 'unknown' };
    if (!isValidEventData(kind, dataOut)) return [{ type: 'item.complete', itemKey: key('unknown', frame, nativeSeq), kind: 'unknown', data: dataOut, nativeSeq, nativeTurnId, native: raw }];
    return [{ type: 'item.complete', itemKey: key(kind, frame, nativeSeq), kind, data: dataOut, nativeSeq, nativeTurnId, native: raw }];
  }
}

export function translateDshFrame(frame: TraceFrame): AdapterEvent[] { return new DshTranslator().feed(frame); }
