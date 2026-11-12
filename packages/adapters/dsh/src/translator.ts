import type { AdapterEvent, EventData, EventKind, TraceFrame } from '@webdcc/protocol';
import { buildFileChanges, isValidEventData } from '@webdcc/protocol';

export const DELTA_FRAMES = new Set(['assistant-stream:chunk:text-delta', 'assistant-stream:chunk:reasoning-delta']);
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}; }
function key(prefix: string, frame: TraceFrame, id?: unknown): string { return `${prefix}-${typeof id === 'string' || typeof id === 'number' ? id : `${frame.ch}-${frame.i}`}`; }

export class DshTranslator {
  private readonly tools = new Map<string, { kind: EventKind; name: string; input: Record<string, unknown> }>();

  feed(frame: TraceFrame): AdapterEvent[] {
    const raw = record(frame.frame);
    if (frame.dir === 'out') return [{ type: 'item.complete', itemKey: key('rpc-out', frame), kind: 'internal', data: { nativeType: `rpc/out:${String(raw['endpoint'] ?? '')}` }, native: raw }];
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
    if (type === 'subagent/catalog' || type === 'subagent/start' || type === 'subagent/updated' || type === 'subagent/end') {
      const childId = String(data['childId'] ?? data['child_id'] ?? data['agentId'] ?? '');
      const label = String(data['label'] ?? data['name'] ?? data['mode'] ?? 'DSH 子 Agent');
      const terminal = type === 'subagent/end' || data['status'] === 'completed' || data['status'] === 'failed';
      return [{
        type: 'item.complete',
        itemKey: `subagent-${childId || nativeSeq}`,
        kind: 'tool.call',
        data: {
          name: 'subagent',
          label,
          input: { childId, ...(data['name'] === undefined ? {} : { name: String(data['name']) }), ...(data['mode'] === undefined ? {} : { mode: String(data['mode']) }), ...(data['status'] === undefined ? {} : { status: String(data['status']) }) },
          status: terminal ? 'completed' : 'running',
        },
        nativeSeq,
        nativeTurnId,
        native: raw,
      }];
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
      this.tools.set(String(id), { kind, name, input });
      return [{ type: 'item.start', itemKey: key('tool', frame, id), kind, data: eventData, nativeTurnId, native: raw }];
    }
    if (type === 'assistant/message') {
      const message = record(data['message']);
      const content = Array.isArray(message['content']) ? message['content'] as unknown[] : [];
      const text = content.map((item) => record(item)).filter((item) => item['type'] === 'text').map((item) => String(item['text'] ?? '')).join('\n');
      const messageId = typeof message['id'] === 'string' ? message['id'] : undefined;
      return [{ type: 'item.complete', itemKey: key('message', frame, messageId), kind: 'assistant.message', data: { text }, nativeSeq, nativeTurnId, native: raw }];
    }
    if (type === 'tool/result') {
      const resultMessage = record(data['message']);
      const callId = String(data['toolCallId'] ?? resultMessage['toolCallId'] ?? resultMessage['callId'] ?? '');
      const tool = this.tools.get(callId);
      this.tools.delete(callId);
      const message = resultMessage;
      const output = Array.isArray(message['content'])
        ? (message['content'] as unknown[]).map((part) => record(part)['text']).filter((text): text is string => typeof text === 'string').join('')
        : String(message['text'] ?? '');
      const failed = message['isError'] === true;
      if (tool?.kind === 'command') return [{ type: 'item.complete', itemKey: key('tool', frame, callId), kind: 'command', data: { command: String(tool.input['command'] ?? ''), status: failed ? 'failed' : 'completed', outputTail: output }, nativeSeq, nativeTurnId, native: raw }];
      if (tool?.kind === 'file.read') return [{ type: 'item.complete', itemKey: key('tool', frame, callId), kind: 'file.read', data: { path: String(tool.input['file_path'] ?? tool.input['pattern'] ?? '') }, nativeSeq, nativeTurnId, native: raw }];
      if (tool?.kind === 'file.change') return [{ type: 'item.complete', itemKey: key('tool', frame, callId), kind: 'file.change', data: { changes: buildFileChanges(tool.name, tool.input), status: failed ? 'failed' : 'completed' }, nativeSeq, nativeTurnId, native: raw }];
      return [{ type: 'item.complete', itemKey: key('tool', frame, callId), kind: 'tool.call', data: { name: tool?.name ?? 'tool', input: tool?.input ?? {}, status: failed ? 'failed' : 'completed', output }, nativeSeq, nativeTurnId, native: raw }];
    }
    if (type === 'todo/write') return [{ type: 'item.complete', itemKey: key('plan', frame), kind: 'plan', data: { items: [] }, nativeSeq, nativeTurnId, native: raw }];
    const kind = type === '' ? 'unknown' : 'internal';
    const dataOut = { nativeType: type || 'unknown' };
    if (!isValidEventData(kind, dataOut)) return [{ type: 'item.complete', itemKey: key('unknown', frame, nativeSeq), kind: 'unknown', data: dataOut, nativeSeq, nativeTurnId, native: raw }];
    return [{ type: 'item.complete', itemKey: key(kind, frame), kind, data: dataOut, nativeSeq, nativeTurnId, native: raw }];
  }
}

export function translateDshFrame(frame: TraceFrame): AdapterEvent[] { return new DshTranslator().feed(frame); }
