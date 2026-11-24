import { createHash } from 'node:crypto';
import type { SDKAssistantMessage, SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterEvent, ClaudeBlockOrigin, ClaudeOutputOrigin } from '@webdcc/protocol';

type ContentEvent = Exclude<AdapterEvent, { type: 'history' }>;
type Kind = 'assistant.message' | 'reasoning';
interface Block { itemKey: string; kind: Kind; text: string; completed: boolean; incomplete?: boolean }
interface Slot { type: string; toolId?: string; completed: boolean }
export interface ClaudeBlockIdentity { itemKey: string; blockIndex: number; claudeBlock: ClaudeBlockOrigin; claudeActor?: ClaudeOutputOrigin }
interface Message {
  key: string;
  actor: string;
  nativeSessionId: string;
  parentToolUseId: string | null;
  nativeId?: string;
  blocks: Map<number, Block>;
  slots: Map<number, Slot>;
  seen: Set<string>;
  ended: boolean;
  origin?: Omit<ClaudeOutputOrigin, 'nativeMessageId' | 'blockIndex' | 'taskId' | 'runId'>;
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
      const [nativeSessionId, parentToolUseId] = JSON.parse(actor) as [string, string | null];
      message = { key: createHash('sha256').update(key).digest('hex').slice(0, 24), actor, nativeSessionId, parentToolUseId, nativeId: id, blocks: new Map(), slots: new Map(), seen: new Set(), ended: false,
        ...(parentToolUseId === null ? {} : { origin: { agent: 'claude-code', nativeSessionId, parentToolUseId } }) };
      this.messages.set(key, message);
      if (this.messages.size > 256) for (const [oldKey, old] of this.messages) {
        if (old !== message && old.ended && [...old.blocks.values()].every(block => block.completed)) { this.messages.delete(oldKey); if (this.messages.size <= 256) break; }
      }
    }
    this.active.set(actor, message);
    return message;
  }

  private key(message: Message, index: number): string { return `msg-${this.generation}-${message.key}-${index}`; }
  private data(message: Message, index: number, text: string): { text: string; claudeBlock: ClaudeBlockOrigin; claudeActor?: ClaudeOutputOrigin } {
    return { text, claudeBlock: { agent: 'claude-code', nativeSessionId: message.nativeSessionId, parentToolUseId: message.parentToolUseId,
      ...(message.nativeId === undefined ? {} : { nativeMessageId: message.nativeId }), blockIndex: index },
    ...(message.origin === undefined ? {} : { claudeActor: { ...message.origin,
      ...(message.nativeId === undefined ? {} : { nativeMessageId: message.nativeId }), blockIndex: index } }) };
  }
  private identity(message: Message, index: number): ClaudeBlockIdentity {
    const { claudeActor, claudeBlock } = this.data(message, index, '');
    return { itemKey: this.key(message, index), blockIndex: index, claudeBlock, ...(claudeActor === undefined ? {} : { claudeActor }) };
  }

  private index(message: Message, raw: Record<string, unknown>, position: number, length: number): number {
    if (length !== 1) return position;
    // Partial indices and canonical single-block deliveries share all slots,
    // including tools and opaque blocks that do not contain visible text.
    const candidates = [...message.slots].filter(([, slot]) => slot.type === raw['type'] && (slot.type !== 'tool_use' || slot.toolId === raw['id']));
    const matching = candidates.find(([, slot]) => !slot.completed) ?? (raw['type'] === 'tool_use' ? candidates[0] : undefined);
    return matching?.[0] ?? (message.slots.size === 0 ? 0 : Math.max(...message.slots.keys()) + 1);
  }

  stream(message: SDKPartialAssistantMessage): ContentEvent[] {
    const actor = this.actor(message);
    const event = message.event as unknown as { type?: string; index?: number; message?: { id?: string }; content_block?: { type?: string; id?: string; text?: string; thinking?: string }; delta?: { type?: string; text?: string; thinking?: string } };
    if (event.type === 'message_start') { this.message(actor, event.message?.id); return []; }
    if (!this.active.has(actor) && !['content_block_start', 'content_block_delta'].includes(event.type ?? '')) return [];
    const state = this.active.get(actor) ?? this.message(actor);
    const index = event.index ?? 0;
    if (event.type === 'message_stop') { state.ended = true; this.active.delete(actor); return []; }
    if (state.ended) return [];
    if (event.type === 'content_block_start') {
      const raw = event.content_block;
      if (raw?.type !== undefined && !state.slots.has(index)) state.slots.set(index, { type: raw.type, toolId: raw.id, completed: false });
      if (raw?.type !== 'text' && raw?.type !== 'thinking') return [];
      const existing = state.blocks.get(index);
      if (existing !== undefined) return [];
      const kind: Kind = raw.type === 'thinking' ? 'reasoning' : 'assistant.message';
      const text = kind === 'reasoning' ? raw.thinking ?? '' : raw.text ?? '';
      const block = { itemKey: this.key(state, index), kind, text, completed: false };
      state.blocks.set(index, block);
      return [{ type: 'item.start', itemKey: block.itemKey, kind, data: this.data(state, index, text), native: message, ...(state.origin === undefined ? {} : { scope: 'session' as const }) }];
    }
    if (event.type !== 'content_block_delta') return [];
    const delta = event.delta;
    if (delta?.type !== 'text_delta' && delta?.type !== 'thinking_delta') return [];
    let block = state.blocks.get(index);
    const events: ContentEvent[] = [];
    if (block === undefined) {
      const kind: Kind = delta.type === 'thinking_delta' ? 'reasoning' : 'assistant.message';
      state.slots.set(index, { type: kind === 'reasoning' ? 'thinking' : 'text', completed: false });
      block = { itemKey: this.key(state, index), kind, text: '', completed: false };
      state.blocks.set(index, block);
      events.push({ type: 'item.start', itemKey: block.itemKey, kind, data: this.data(state, index, ''), native: message, ...(state.origin === undefined ? {} : { scope: 'session' as const }) });
    }
    if (block.completed) return events;
    const append = delta.type === 'thinking_delta' ? delta.thinking ?? '' : delta.text ?? '';
    block.text += append;
    events.push({ type: 'item.delta', itemKey: block.itemKey, field: 'text', append, ...(state.origin === undefined ? {} : { scope: 'session' as const }) });
    return events;
  }

  assistant(message: SDKAssistantMessage, tool?: (block: Record<string, unknown>, identity: ClaudeBlockIdentity) => ContentEvent[]): { events: ContentEvent[]; duplicate: boolean } {
    const actor = this.actor(message);
    const id = message.message?.id;
    const active = this.active.get(actor);
    const state = id === undefined ? active ?? this.message(actor) : this.messages.get(JSON.stringify([actor, id])) ?? (active?.nativeId === undefined && active !== undefined && !active.ended ? active : this.message(actor, id));
    if (id !== undefined) { this.messages.set(JSON.stringify([actor, id]), state); state.nativeId = id; }
    const identity = message.uuid ?? JSON.stringify(message.message?.content);
    if (state.seen.has(identity)) return { events: [], duplicate: true };
    state.seen.add(identity);
    const content = (message.message?.content ?? []) as unknown as (Record<string, unknown> & { type: string; text?: string; thinking?: string })[];
    const events: ContentEvent[] = [];
    for (const [position, raw] of content.entries()) {
      const index = this.index(state, raw, position, content.length);
      const slot = state.slots.get(index);
      state.slots.set(index, { type: raw.type, ...(typeof raw['id'] === 'string' ? { toolId: raw['id'] } : {}), completed: slot?.completed === true || message.aborted !== true });
      if (raw.type !== 'text' && raw.type !== 'thinking') {
        if (slot?.completed && slot.type === raw.type && (raw.type !== 'tool_use' || slot.toolId === raw['id'])) continue;
        const identity = this.identity(state, index);
        if (raw.type === 'tool_use') events.push(...tool?.(raw, identity) ?? []);
        else events.push({ type: 'item.complete', itemKey: `${identity.itemKey}-unknown`, kind: 'unknown', data: { nativeType: `assistant/content/${raw.type}`, claudeBlock: identity.claudeBlock,
          ...(identity.claudeActor === undefined ? {} : { claudeActor: identity.claudeActor }) }, native: message,
          ...(state.origin === undefined ? {} : { scope: 'session' as const }) });
        continue;
      }
      const kind: Kind = raw.type === 'thinking' ? 'reasoning' : 'assistant.message';
      const previous = state.blocks.get(index);
      const text = kind === 'reasoning' ? raw.thinking ?? '' : raw.text ?? '';
      const block: Block = { itemKey: previous?.itemKey ?? this.key(state, index), kind, text, completed: true, incomplete: message.aborted === true };
      state.blocks.set(index, block);
      if (previous?.completed && previous.kind === kind && previous.text === text && (!previous.incomplete || message.aborted === true)) continue;
      events.push({ type: 'item.complete', itemKey: block.itemKey, kind, data: { ...this.data(state, index, text), ...(message.aborted === true ? { incomplete: true } : {}) }, native: message, ...(state.origin === undefined ? {} : { scope: 'session' as const }) });
    }
    if (message.message?.stop_reason != null) state.ended = true;
    return { events, duplicate: false };
  }

  flush(sessionId: string): ContentEvent[] {
    const events: ContentEvent[] = [];
    const actor = this.actor({ session_id: sessionId, parent_tool_use_id: null });
    for (const state of this.messages.values()) for (const [index, block] of state.blocks) {
      if (state.actor !== actor) continue;
      if (block.completed) continue;
      block.completed = true;
      events.push({ type: 'item.complete', itemKey: block.itemKey, kind: block.kind, data: this.data(state, index, block.text) });
    }
    return events;
  }
}
