import { createHash } from 'node:crypto';
import type { Command, CommandRecord } from '@webdcc/protocol';

const PREFIX = 'sha256-json-v2:';
export type CommandIdentity = 'same' | 'different' | 'unverified';

/** Versioned JSON identity uses deterministic key order, independent of the
 * process's Intl locale. Arrays and ordinary JSON conversion retain order. */
export function commandDigest(command: Command): string {
  const canonical = JSON.stringify(command, (_key, value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  return PREFIX + createHash('sha256').update(canonical).digest('hex');
}

function completePayload(payload: Command | null): payload is Command {
  if (payload === null) return false;
  if (payload.op !== 'answer') return true;
  const answer = payload.answer;
  // The old format did not carry a separate redaction flag. Conservatively
  // treat its reserved marker as unavailable rather than inventing an answer.
  return !(answer !== null && typeof answer === 'object' && !Array.isArray(answer)
    && (answer as Record<string, unknown>)['omitted'] === 'sensitive-answer');
}

export function compareCommandIdentity(command: Command, record: CommandRecord, legacyHash: (command: Command) => string): CommandIdentity {
  const digest = record.payloadHash;
  if (digest === null) return 'unverified';
  if (/^sha256-json-v2:[0-9a-f]{64}$/.test(digest)) return digest === commandDigest(command) ? 'same' : 'different';
  if (!/^[0-9a-f]{64}$/.test(digest)) return 'unverified';
  if (digest === legacyHash(command)) return 'same';
  if (!completePayload(record.payload)) return 'unverified';
  return commandDigest(record.payload) === commandDigest(command) ? 'same' : 'different';
}
