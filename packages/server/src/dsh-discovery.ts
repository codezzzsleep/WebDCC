/**
 * Discover a DSH that is already running on this machine.
 *
 * DSH deliberately keeps its launch token in process memory. When DSH is
 * managed by systemd, its startup URL is written to the unit journal; that is
 * the only supported local hand-off we can use without changing DSH or
 * bypassing its authentication. The token is never logged by WebDCC.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export interface RunningDsh {
  pid: number;
  origin: string;
  token: string;
  service?: string;
}

interface ProcessCandidate {
  pid: number;
  origin: string;
  service?: string;
}

function commandLine(pid: number): string[] | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return undefined;
  }
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function serviceName(pid: number): string | undefined {
  try {
    const cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    const match = /\/([^/]+\.service)\s*$/.exec(cgroup.trim());
    return match?.[1];
  } catch {
    return undefined;
  }
}

function processCandidates(): ProcessCandidate[] {
  const candidates: ProcessCandidate[] = [];
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const argv = commandLine(pid);
    if (argv === undefined || !argv.some((arg) => arg === 'dsh' || arg.endsWith('/dsh'))) continue;
    const webProfile = argv.includes('web') || (argv.includes('--profile') && argv.includes('web'));
    if (!webProfile) continue;
    const port = argValue(argv, '--port');
    if (port === undefined || !/^\d+$/.test(port)) continue;
    const publicUrl = argValue(argv, '--public-url');
    const publicOrigin = publicUrl === undefined ? undefined : new URL(publicUrl).origin;
    const host = publicOrigin === undefined ? argValue(argv, '--host') ?? '127.0.0.1' : new URL(publicOrigin).hostname;
    if (host === '0.0.0.0' || host === '::') continue;
    candidates.push({
      pid,
      origin: publicOrigin ?? `http://${host}:${port}`,
      ...(serviceName(pid) === undefined ? {} : { service: serviceName(pid) }),
    });
  }
  return candidates;
}

function tokenFromJournal(text: string): string | undefined {
  let found: string | undefined;
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+[?&]token=([A-Za-z0-9_-]+)/g)) found = match[1];
  return found;
}

/**
 * A manually launched DSH is often in a user scope instead of a systemd
 * service. Its startup URL is still available through the stdout/stderr file
 * inherited by the process, so use that as the local discovery fallback.
 */
function tokenFromProcessOutput(pid: number): string | undefined {
  for (const fd of ['1', '2']) {
    try {
      const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      if (!target.startsWith('/') || target === '/dev/null' || !statSync(target).isFile()) continue;
      const text = readFileSync(target, 'utf8').slice(-512 * 1024);
      const token = tokenFromJournal(text);
      if (token !== undefined) return token;
    } catch {
      // The process may close or redirect its output while discovery runs.
    }
  }
  return undefined;
}

export async function discoverRunningDsh(options: { service?: string } = {}): Promise<RunningDsh | null> {
  for (const candidate of processCandidates()) {
    const service = options.service ?? candidate.service;
    let token: string | undefined;
    if (service !== undefined) {
      try {
        const result = await execFile('journalctl', ['-u', service, '-n', '120', '-o', 'cat'], {
          timeout: 3000,
          maxBuffer: 512 * 1024,
        });
        token = tokenFromJournal(result.stdout);
      } catch {
        // Fall through to the process output fallback below.
      }
    }
    token ??= tokenFromProcessOutput(candidate.pid);
    if (token !== undefined) return { ...candidate, token, ...(service === undefined ? {} : { service }) };
  }
  return null;
}

export function parseDshTokenFromJournal(text: string): string | undefined {
  return tokenFromJournal(text);
}
