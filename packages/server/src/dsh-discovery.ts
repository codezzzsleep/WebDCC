/**
 * Discover a DSH that is already running on this machine.
 *
 * DSH deliberately keeps its launch token in process memory. When DSH is
 * managed by systemd, its startup URL is written to the unit journal; that is
 * the only supported local hand-off we can use without changing DSH or
 * bypassing its authentication. The token is never logged by WebDCC.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
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
    const host = argValue(argv, '--host') ?? new URL(argValue(argv, '--public-url') ?? 'http://127.0.0.1').hostname;
    if (host === '0.0.0.0' || host === '::') continue;
    const protocol = (argValue(argv, '--public-url') ?? '').startsWith('https:') ? 'https' : 'http';
    candidates.push({
      pid,
      origin: `${protocol}://${host}:${port}`,
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

export async function discoverRunningDsh(options: { service?: string } = {}): Promise<RunningDsh | null> {
  for (const candidate of processCandidates()) {
    const service = options.service ?? candidate.service;
    if (service === undefined) continue;
    try {
      const result = await execFile('journalctl', ['-u', service, '-n', '120', '-o', 'cat'], {
        timeout: 3000,
        maxBuffer: 512 * 1024,
      });
      const token = tokenFromJournal(result.stdout);
      if (token !== undefined) return { ...candidate, token, service };
    } catch {
      // journalctl is optional; manual attach remains available when absent.
    }
  }
  return null;
}

export function parseDshTokenFromJournal(text: string): string | undefined {
  return tokenFromJournal(text);
}
