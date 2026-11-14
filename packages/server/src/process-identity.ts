import { readFileSync } from 'node:fs';
import type { ManagedProcessIdentity } from '@webdcc/protocol';

function bootId(): string | undefined {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return undefined; }
}
function machineId(): string | undefined {
  try { return readFileSync('/etc/machine-id', 'utf8').trim() || undefined; } catch { return undefined; }
}
function stat(pid: number): { startTicks: string; state: string } | 'missing' | undefined {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, 'utf8'); const fields = value.slice(value.lastIndexOf(')') + 2).split(' ');
    return fields[0] && fields[19] && /^\d+$/.test(fields[19]) ? { state: fields[0], startTicks: fields[19] } : undefined;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : undefined; }
}
export function captureProcess(pid: number, profilePath?: string): ManagedProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  const boot = bootId(); const machine = machineId(); const value = stat(pid);
  return boot && machine && value && value !== 'missing' ? { pid, bootId: boot, startTicks: value.startTicks, machineId: machine, profilePath: profilePath ?? null } : undefined;
}
export function processState(identity: ManagedProcessIdentity | null): 'running' | 'exited' | 'unknown' {
  if (identity === null || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || !/^\d+$/.test(identity.startTicks) || !identity.bootId) return 'unknown';
  const machine = machineId(); if (machine === undefined || machine !== identity.machineId) return 'unknown';
  const boot = bootId(); if (boot === undefined) return 'unknown';
  if (boot !== identity.bootId) return 'exited';
  const value = stat(identity.pid);
  if (value === undefined) return 'unknown';
  if (value === 'missing' || value.startTicks !== identity.startTicks || value.state === 'Z' || value.state === 'X') return 'exited';
  return 'running';
}
