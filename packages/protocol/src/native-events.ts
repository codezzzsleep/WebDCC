import type { TraceFrame } from './trace.js';

export interface NativeFrameReceipt { envelopeId: number; accepted: boolean }
export interface NativeFrameSink { record(frame: TraceFrame): NativeFrameReceipt }
export interface NativeEnvelopeSummary {
  id: number; sessionId: string; agent: string; nativeId: string | null;
  ownerId: string | null; generation: number | null; receivedAt: string;
  source: 'transport' | 'mapping'; direction: 'in' | 'out'; channel: string;
  disposition: string; schemaHash: string; rawEnvelopeId: number | null;
  nativeSeq: number | null; nativeTurnId: string | null; nativeRequestId: string | number | null;
  actorId: string | null; parentToolUseId: string | null; payloadCoverage: 'redacted' | 'restricted' | 'oversize';
}
export interface NativeEnvelopeDetail extends NativeEnvelopeSummary { payload: unknown }
