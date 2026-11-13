import type { AdapterEvent, TraceFrame } from '@webdcc/protocol';
import { ClaudeAdapter } from './adapter.js';

/** Compatibility entry; all replay paths use the production Handler. */
export const DELTA_FRAMES = new Set(['content_block_delta']);
export class ClaudeTranslator {
  private readonly handler = ClaudeAdapter.replay();
  feed(frame: TraceFrame): AdapterEvent[] { return this.handler.feed(frame); }
}
export function translateClaudeFrame(frame: TraceFrame): AdapterEvent[] { return new ClaudeTranslator().feed(frame); }
