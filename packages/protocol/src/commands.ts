import type { Command } from './sync.js';
import type { UserInput } from './adapter.js';

export type CommandState = 'received' | 'queued' | 'dispatching' | 'native-accepted' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
export interface CommandRecord {
  commandId: string;
  payloadHash: string | null;
  payload: Command | null;
  op: string;
  sessionId: string | null;
  state: CommandState;
  turnId: string | null;
  result?: unknown;
  updatedAt: string;
}
export interface QueuedInput {
  ordinal: number;
  commandId: string;
  sessionId: string;
  turnId: string;
  input: UserInput;
  state: CommandState;
  createdAt: string;
  preparationError?: string;
}

export interface QueueSnapshot {
  inputs: QueuedInput[];
  /** Feed sequence used to reject late browser reads. */
  revision: number;
  /** Exact queue state and order used for compare-and-set mutations. */
  orderRevision: string;
}

export function isQueueInputReorderable(input: QueuedInput): boolean {
  return input.state === 'queued' && input.input.delivery !== 'steer';
}
