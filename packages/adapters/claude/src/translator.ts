import type { AdapterEvent, TraceFrame } from '@webdcc/protocol';

export const DELTA_FRAMES = new Set(['stream_event:content_block_delta']);
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}; }
function key(prefix: string, frame: TraceFrame, id?: unknown): string { return `${prefix}-${typeof id === 'string' || typeof id === 'number' ? id : `${frame.ch}-${frame.i}`}`; }

export class ClaudeTranslator {
  feed(frame: TraceFrame): AdapterEvent[] {
    const message = record(frame.frame);
    if (frame.dir === 'out') return [{ type: 'item.complete', itemKey: key('input', frame), kind: 'internal', data: { nativeType: 'input' }, native: message }];
    if (message['type'] === 'stream_event') {
      const event = record(message['event']);
      const type = String(event['type'] ?? '');
      const index = typeof event['index'] === 'number' ? event['index'] : frame.i;
      if (type === 'content_block_start') {
        const block = record(event['content_block'] ?? event['block']);
        const kind = block['type'] === 'thinking' ? 'reasoning' : 'assistant.message';
        return [{ type: 'item.start', itemKey: key('msg', frame, index), kind, data: { text: '' } }];
      }
      if (type === 'content_block_delta') {
        const delta = record(event['delta']);
        if (delta['type'] === 'thinking_delta') return [{ type: 'item.delta', itemKey: key('msg', frame, index), field: 'text', append: String(delta['thinking'] ?? '') }];
        if (delta['type'] === 'text_delta') return [{ type: 'item.delta', itemKey: key('msg', frame, index), field: 'text', append: String(delta['text'] ?? '') }];
      }
      return [{ type: 'item.complete', itemKey: key('stream', frame, undefined), kind: 'internal', data: { nativeType: `stream_event:${type}` }, native: message }];
    }
    if (message['type'] === 'assistant') {
      const nativeMessage = record(message['message']);
      const content = Array.isArray(nativeMessage['content']) ? nativeMessage['content'] as unknown[] : [];
      const out: AdapterEvent[] = [];
      content.forEach((value, _index) => {
        const block = record(value);
        if (block['type'] === 'thinking') out.push({ type: 'item.complete', itemKey: key('msg', frame, undefined), kind: 'reasoning', data: { text: String(block['thinking'] ?? '') }, native: message });
        if (block['type'] === 'text') out.push({ type: 'item.complete', itemKey: key('msg', frame, undefined), kind: 'assistant.message', data: { text: String(block['text'] ?? '') }, native: message });
      });
      return out.length === 0 ? [{ type: 'item.complete', itemKey: key('assistant', frame), kind: 'internal', data: { nativeType: 'assistant' }, native: message }] : out;
    }
    if (message['type'] === 'result') {
      const usage = record(message['usage']);
      const resultText = typeof message['result'] === 'string' ? message['result'] : '';
      return [
        ...(resultText === '' ? [] : [{ type: 'item.complete' as const, itemKey: key('result', frame), kind: 'assistant.message' as const, data: { text: resultText, nativePhase: 'final_answer' }, native: message }]),
        { type: 'turn.end', status: message['is_error'] === true ? 'failed' : 'completed', ...(Object.keys(usage).length === 0 ? {} : { usage: { inputTokens: Number(usage['input_tokens'] ?? 0), outputTokens: Number(usage['output_tokens'] ?? 0) } }), native: message },
      ];
    }
    return [{ type: 'item.complete', itemKey: key('native', frame, undefined), kind: 'internal', data: { nativeType: String(message['type'] ?? 'unknown') }, native: message }];
  }
}

export function translateClaudeFrame(frame: TraceFrame): AdapterEvent[] { return new ClaudeTranslator().feed(frame); }
