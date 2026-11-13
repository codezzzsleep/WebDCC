import type { AdapterEvent, TraceFrame } from '@webdcc/protocol';
import { CodexAdapter } from './adapter.js';

/** Compatibility entry; all replay paths use the production Handler. */
export const DELTA_FRAMES = new Set(['item/agentMessage/delta']);
export class CodexTranslator {
  private readonly handler = CodexAdapter.replay();
  feed(frame: TraceFrame): AdapterEvent[] { return this.handler.feed(frame); }
}
export function translateCodexFrame(frame: TraceFrame): AdapterEvent[] { return new CodexTranslator().feed(frame); }
