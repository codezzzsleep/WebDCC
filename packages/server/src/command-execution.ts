import type { ManagedProcessIdentity } from '@webdcc/protocol';
import type { Db } from './db.js';
import { captureProcess, processState } from './process-identity.js';

const key = (commandId: string) => `command-execution:${commandId}`;

/** Called inside the same transaction that claims command execution. This
 * identity describes the Web executor, never the native writer or outcome. */
export function recordCommandExecution(db: Db, commandId: string): void {
  const witness = { formatVersion: 1, process: captureProcess(process.pid) ?? null };
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key(commandId), JSON.stringify(witness));
}

function executor(db: Db, commandId: string): ManagedProcessIdentity | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key(commandId)) as { value: string } | undefined;
  if (row === undefined) return null;
  try {
    const value = JSON.parse(row.value) as { formatVersion?: unknown; process?: unknown } | null;
    if (value === null || value.formatVersion !== 1 || value.process === null || typeof value.process !== 'object') return null;
    const identity = value.process as Partial<ManagedProcessIdentity>;
    if (!Number.isSafeInteger(identity.pid) || Number(identity.pid) < 1 || typeof identity.startTicks !== 'string' || !/^\d+$/.test(identity.startTicks)
      || typeof identity.bootId !== 'string' || identity.bootId === '' || typeof identity.machineId !== 'string' || identity.machineId === '') return null;
    return identity as ManagedProcessIdentity;
  } catch { return null; }
}

/** Global creation commands have no sessionId yet, so session-owner recovery
 * cannot cover them. A missing/dead/unverifiable executor leaves the native
 * result unknown. A live executor may still be awaiting its original call. */
export function recoverSessionlessExecutions(db: Db): void {
  const rows = db.prepare("SELECT command_id FROM command_journal WHERE op = 'create-session' AND session_id IS NULL AND state = 'dispatching'").all() as { command_id: string }[];
  const uncertain = db.prepare("UPDATE command_journal SET state = 'uncertain', updated_at = ? WHERE command_id = ? AND op = 'create-session' AND session_id IS NULL AND state = 'dispatching'");
  for (const row of rows) if (processState(executor(db, row.command_id)) !== 'running') uncertain.run(new Date().toISOString(), row.command_id);
}
