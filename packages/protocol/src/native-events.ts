import type { TraceFrame } from './trace.js';

export interface NativeFrameReceipt { envelopeId: number; accepted: boolean }
export interface NativeFrameSink { record(frame: TraceFrame): NativeFrameReceipt }
export interface NativeDshRpcCaptureMetadata {
  endpoint: string; rpcId: string; httpStatus?: number; jsonBytes?: number;
  /** Present for outgoing serialized request bytes; not reconstructed responses. */
  byteLength?: number;
  coverage: 'complete' | 'oversize' | 'invalid-json' | 'transport-error' | 'http-auth-rejected';
  verifiedHostFingerprint?: string; hostEpoch: number; muxGeneration: number;
}
/** A capture marker never contains the omitted transport bytes or their hash. */
export interface NativeStdioCaptureMetadata {
  stream: 'stdin' | 'stdout' | 'stderr';
  line: number;
  byteLength: number;
  terminated: boolean;
  coverage: 'complete' | 'oversize' | 'invalid-json' | 'invalid-utf8' | 'non-object' | 'incomplete' | 'unstructured';
}
export interface NativeEnvelopeSummary {
  id: number; sessionId: string; agent: string; nativeId: string | null;
  ownerId: string | null; generation: number | null; receivedAt: string;
  source: 'transport' | 'mapping'; direction: 'in' | 'out'; channel: string;
  disposition: string; schemaHash: string; rawEnvelopeId: number | null;
  nativeSeq: number | null; nativeTurnId: string | null; nativeRequestId: string | number | null;
  actorId: string | null; parentToolUseId: string | null; payloadCoverage: 'redacted' | 'restricted' | 'oversize' | 'unavailable';
}
export interface NativeEnvelopeDetail extends NativeEnvelopeSummary { payload: unknown }
