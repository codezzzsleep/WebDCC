import { createHash } from 'node:crypto';
import type { SDKAssistantMessage, SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterEvent } from '@webdcc/protocol';

type ContentEvent = Exclude<AdapterEvent, { type: 'history' }>;
type Kind = 'assistant.message' | 'reasoning';
interface Block { itemKey: string; kind: Kind; text: string; completed: boolean }
interface Message {
  key: string;
  actor: string;
  nativeId?: string;
  blocks: Map<number, Block>;
  seen: Set<string>;
  ended: boolean;
}

/** Content indices belong to one actor and one native message. SDK assistant
 * deliveries may contain a full message or just its newly completed block. */
export class ClaudeContentReducer {
  private sequence = 0;
  private readonly active = new Map<string, Message>();
  private readonly messages = new Map<string, Message>();

  constructor(private readonly generation: number) {}

  private actor(message: { session_id: string; parent_tool_use_id: string | null }): string {
    return JSON.stringify([message.session_id ?? '', message.parent_tool_use_id ?? null]);
  }

  private message(actor: string, id?: string): Message {
    const key = JSON.stringify([actor, id ?? `unidentified-${++this.sequence}`]);
    let message = this.messages.get(key);
    if (message === undefined) {
      message = { key: createHash('sha256').update(key).digest('hex').slice(0, 24), actor, nativeId: id, blocks: new Map(), seen: new Set(), ended: false };
      this.messages.set(key, message);
      if (this.messages.size > 256) for (const [oldKey, old] of this.messages) {
        if (old !== message && old.ended && [...old.blocks.values()].every(block => block.completed)) { this.messages.delete(oldKey); if (this.messages.size <= 256) break; }
      }
    }
    this.active.set(actor, message);
    return message;
  }

  private key(message: Message, index: number): string { return `msg-${this.generation}-${message.key}-${index}`; }

  stream(message: SDKPartialAssistantMessage): ContentEvent[] {
    const actor = this.actor(message);
    const event = message.event as unknown as { type?: string; index?: number; message?: { id?: string }; content_block?: { type?: string; text?: string; thinking?: string }; delta?: { type?: string; text?: string; thinking?: string } };
    if (event.type === 'message_start') { this.message(actor, event.message?.id); return []; }
    if (!this.active.has(actor) && !['content_block_start', 'content_block_delta'].includes(event.type ?? '')) return [];
    const state = this.active.get(actor) ?? this.message(actor);
    const index = event.index ?? 0;
    if (event.type === 'message_stop') { state.ended = true; this.active.delete(actor); return []; }
    if (state.ended) return [];
    if (event.type === 'content_block_start') {
      const raw = event.content_block;
      if (raw?.type !== 'text' && raw?.type !== 'thinking') return [];
      const existing = state.blocks.get(index);
      if (existing !== undefined) return [];
      const kind: Kind = raw.type === 'thinking' ? 'reasoning' : 'assistant.message';
      const text = kind === 'reasoning' ? raw.thinking ?? '' : raw.text ?? '';
      const block = { itemKey: this.key(state, index), kind, text, completed: false };
      state.blocks.set(index, block);
      return [{ type: 'item.start', itemKey: block.itemKey, kind, data: { text }, native: message }];
    }
    if (event.type !== 'content_block_delta') return [];
    const delta = event.delta;
    if (delta?.type !== 'text_delta' && delta?.type !== 'thinking_delta') return [];
    let block = state.blocks.get(index);
    const events: ContentEvent[] = [];
    if (block === undefined) {
      const kind: Kind = delta.type === 'thinking_delta' ? 'reasoning' : 'assistant.message';
      block = { itemKey: this.key(state, index), kind, text: '', completed: false };
      state.blocks.set(index, block);
      events.push({ type: 'item.start', itemKey: block.itemKey, kind, data: { text: '' }, native: message });
    }
    if (block.completed) return events;
    const append = delta.type === 'thinking_delta' ? delta.thinking ?? '' : delta.text ?? '';
    block.text += append;
    events.push({ type: 'item.delta', itemKey: block.itemKey, field: 'text', append });
    return events;
  }

  assistant(message: SDKAssistantMessage): { events: ContentEvent[]; duplicate: boolean } {
    const actor = this.actor(message);
    const id = message.message?.id;
    const active = this.active.get(actor);
    const state = id === undefined ? active ?? this.message(actor) : this.messages.get(JSON.stringify([actor, id])) ?? (active?.nativeId === undefined && active !== undefined && !active.ended ? active : this.message(actor, id));
    if (id !== undefined) { this.messages.set(JSON.stringify([actor, id]), state); state.nativeId = id; }
    const identity = message.uuid ?? JSON.stringify(message.message?.content);
    if (state.seen.has(identity)) return { events: [], duplicate: true };
    state.seen.add(identity);
    const content = (message.message?.content ?? []) as unknown as { type: string; text?: string; thinking?: string }[];
    const events: ContentEvent[] = [];
    for (const [position, raw] of content.entries()) {
      if (raw.type !== 'text' && raw.type !== 'thinking') {
        if (raw.type !== 'tool_use') events.push({ type: 'item.complete', itemKey: `${this.key(state, position)}-unknown`, kind: 'unknown', data: { nativeType: `assistant/content/${raw.type}` }, native: message });
        continue;
      }
      const kind: Kind = raw.type === 'thinking' ? 'reasoning' : 'assistant.message';
      let index = position;
      if (content.length === 1) {
        const live = [...state.blocks].find(([, block]) => !block.completed && block.kind === kind);
        index = live?.[0] ?? (state.blocks.size === 0 ? 0 : Math.max(...state.blocks.keys()) + 1);
      }
      const previous = state.blocks.get(index);
      const text = kind === 'reasoning' ? raw.thinking ?? '' : raw.text ?? '';
      const block: Block = { itemKey: previous?.itemKey ?? this.key(state, index), kind, text, completed: true };
      state.blocks.set(index, block);
      if (previous?.completed && previous.kind === kind && previous.text === text) continue;
      events.push({ type: 'item.complete', itemKey: block.itemKey, kind, data: { text }, native: message });
    }
    if (message.message?.stop_reason != null) state.ended = true;
    return { events, duplicate: false };
  }

  flush(sessionId: string): ContentEvent[] {
    const events: ContentEvent[] = [];
    const actor = this.actor({ session_id: sessionId, parent_tool_use_id: null });
    for (const state of this.messages.values()) for (const block of state.blocks.values()) {
      if (state.actor !== actor) continue;
      if (block.completed) continue;
      block.completed = true;
      events.push({ type: 'item.complete', itemKey: block.itemKey, kind: block.kind, data: { text: block.text } });
    }
    return events;
  }
}
