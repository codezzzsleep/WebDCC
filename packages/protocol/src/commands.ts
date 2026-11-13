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
}
