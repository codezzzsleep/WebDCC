import type { AdapterEvent, TraceFrame } from '@webdcc/protocol';
import { DshAdapter } from './adapter.js';

/** Compatibility entry; all replay paths use the production Handler. */
export const DELTA_FRAMES = new Set(['assistant-stream:chunk:text-delta']);
export class DshTranslator {
  private readonly handler = DshAdapter.replay();
  feed(frame: TraceFrame): AdapterEvent[] { return this.handler.feed(frame); }
}
export function translateDshFrame(frame: TraceFrame): AdapterEvent[] { return new DshTranslator().feed(frame); }
