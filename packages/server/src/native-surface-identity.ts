import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { open, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import type { ManagedProcessIdentity } from '@webdcc/protocol';
import { captureProcess, processState } from './process-identity.js';
import type { NativeTerminalTarget } from './native-surface.js';

export interface NativeIdentityCandidate { nativeId: string; cwd: string; nativeVersion?: string; path: string; createdAt: number }
export interface NativeIdentitySnapshot { capturedAt: number; nativeIds: string[]; complete: boolean }
export interface NativeIdentityInspection {
  status: 'verified' | 'unverified' | 'ambiguous';
  nativeId?: string;
  evidence?: string;
  reason: string;
}

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
// SDK helpers have no profile option, so run read-only helpers in a fixed child
// with the selected profile environment rather than mutating the server env.
const CLAUDE_HISTORY_READER = `const sdk = await import(process.argv[1]);
const entries = await sdk.listSessions({dir:process.argv[2],limit:257,includeWorktrees:false,includeProgrammatic:true});
process.stdout.write(JSON.stringify(entries.map(entry=>({sessionId:entry.sessionId,cwd:entry.cwd,createdAt:entry.createdAt}))));`;

async function claudeCandidates(target: NativeTerminalTarget): Promise<{ candidates: NativeIdentityCandidate[]; complete: boolean }> {
  const sdk = pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', CLAUDE_HISTORY_READER, sdk, target.cwd], { cwd: target.cwd, env: target.env, timeout: 10_000, maxBuffer: 256 * 1024 });
  const rows = JSON.parse(stdout) as { sessionId?: string; cwd?: string; createdAt?: number }[];
  if (!Array.isArray(rows)) return { candidates: [], complete: false };
  // SDK uses its standard project directory encoding; the fd check below is
  // authoritative if the layout changes or a worktree aliases this path.
  const project = target.cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const candidates = rows.slice(0, 256).flatMap(row => /^[a-f0-9-]{36}$/i.test(row.sessionId ?? '') && row.cwd === target.cwd && Number.isFinite(row.createdAt)
    ? [{ nativeId: row.sessionId!, cwd: row.cwd!, createdAt: row.createdAt!, nativeVersion: target.nativeVersion, path: join(target.profilePath, 'projects', project, `${row.sessionId}.jsonl`) }] : []);
  return { candidates, complete: rows.length <= 256 };
}

async function firstSessionMeta(path: string): Promise<NativeIdentityCandidate | undefined> {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(64 * 1024); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const line = bytes.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    if (!line || line.length >= bytes.length) return undefined;
    const record = JSON.parse(line) as { type?: string; payload?: { id?: string; cwd?: string; cli_version?: string; timestamp?: string }; timestamp?: string };
    if (record?.type !== 'session_meta' || typeof record.payload?.id !== 'string' || !record.payload.id || record.payload.id.length > 128 || typeof record.payload.cwd !== 'string') return undefined;
    const createdAt = Date.parse(record.payload.timestamp ?? record.timestamp ?? '');
    if (!Number.isFinite(createdAt)) return undefined;
    return { nativeId: record.payload.id, cwd: record.payload.cwd, nativeVersion: record.payload.cli_version, path, createdAt };
  } finally { await handle.close(); }
}

async function codexCandidates(target: NativeTerminalTarget): Promise<{ candidates: NativeIdentityCandidate[]; complete: boolean }> {
  const candidates: NativeIdentityCandidate[] = [];
  let complete = true;
  const files = (await readdir(target.profilePath)).filter(name => /^state_\d+\.sqlite$/.test(name)).slice(0, 8);
  for (const file of files) {
    let db: Database.Database | undefined;
    try {
      db = new Database(join(target.profilePath, file), { readonly: true, fileMustExist: true, timeout: 500 });
      const columns = new Set((db.prepare('PRAGMA table_info(threads)').all() as { name: string }[]).map(row => row.name));
      if (!['id', 'cwd', 'cli_version', 'rollout_path', 'created_at'].every(column => columns.has(column))) { complete = false; continue; }
      const rows = db.prepare('SELECT id, cwd, cli_version, rollout_path, created_at FROM threads WHERE cwd = ? ORDER BY created_at DESC LIMIT 257').all(target.cwd) as { id: string; cwd: string; cli_version: string; rollout_path: string; created_at: number }[];
      if (rows.length > 256) complete = false;
      for (const row of rows.slice(0, 256)) {
        if (typeof row.id !== 'string' || !row.id || row.id.length > 128 || typeof row.rollout_path !== 'string' || !isAbsolute(row.rollout_path) || !Number.isFinite(row.created_at)) continue;
        const inside = relative(target.profilePath, row.rollout_path);
        if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue;
        candidates.push({ nativeId: row.id, cwd: row.cwd, nativeVersion: row.cli_version, path: row.rollout_path, createdAt: row.created_at < 1e12 ? row.created_at * 1_000 : row.created_at });
      }
    } catch { complete = false; } finally { db?.close(); }
  }
  // Legacy rollouts remain a supported evidence source for this exact baseline.
  const queue = [{ path: join(target.profilePath, 'sessions'), depth: 0 }];
  let scanned = 0;
  while (queue.length && scanned < 512) {
    const directory = queue.shift()!;
    const entries = await readdir(directory.path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++scanned > 512) { complete = false; break; }
      const path = join(directory.path, entry.name);
      if (entry.isDirectory() && directory.depth < 3 && /^\d{2,4}$/.test(entry.name)) queue.push({ path, depth: directory.depth + 1 });
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const candidate = await firstSessionMeta(path).catch(() => undefined);
        if (candidate?.cwd === target.cwd && !candidates.some(previous => previous.nativeId === candidate.nativeId)) candidates.push(candidate);
      }
    }
  }
  if (queue.length) complete = false;
  return { candidates, complete };
}

async function candidates(target: NativeTerminalTarget) { return target.agent === 'codex' ? codexCandidates(target) : claudeCandidates(target); }

export async function captureNativeIdentitySnapshot(target: NativeTerminalTarget): Promise<NativeIdentitySnapshot> {
  const capturedAt = Date.now(); const result = await candidates(target);
  return { capturedAt, nativeIds: result.candidates.map(candidate => candidate.nativeId), complete: result.complete };
}

async function processFiles(identity: ManagedProcessIdentity): Promise<string[]> {
  if (processState(identity) !== 'running') return [];
  const entries = (await readdir(`/proc/${identity.pid}/fd`).catch(() => [])).slice(0, 256);
  const result = await Promise.all(entries.map(async entry => {
    const [path, info] = await Promise.all([readlink(`/proc/${identity.pid}/fd/${entry}`).catch(() => ''), readFile(`/proc/${identity.pid}/fdinfo/${entry}`, 'utf8').catch(() => '')]);
    const flags = info.match(/^flags:\s*([0-7]+)$/m)?.[1];
    if (flags === undefined) return '';
    const access = BigInt(`0o${flags}`) & 3n;
    return access === 1n || access === 2n ? path : '';
  }));
  return processState(identity) === 'running' ? result : [];
}

/** A new history row alone is a candidate. Only an actual writer fd belonging
 * to this captured CLI/child process can establish its native identity. */
export async function inspectNativeProcessIdentity(target: NativeTerminalTarget, process: ManagedProcessIdentity, baseline: NativeIdentitySnapshot): Promise<NativeIdentityInspection> {
  if (processState(process) !== 'running' || process.profilePath !== target.profilePath || process.nativeVersion !== target.nativeVersion) return { status: 'unverified', reason: '托管原生进程、配置或版本无法验证' };
  const result = await candidates(target);
  if (!baseline.complete || !result.complete) return { status: 'unverified', reason: '原生身份扫描范围不完整，不能关联新会话' };
  // A native TUI can /resume an old record. Follow actual writable fds across
  // every observed native id, rather than only the first new record after launch.
  const selected = result.candidates.filter(candidate => candidate.nativeVersion === target.nativeVersion && candidate.cwd === target.cwd);
  if (!selected.length) return { status: 'unverified', reason: '原生 CLI 尚未生成可关联的会话记录' };
  const paths = new Map<string, NativeIdentityCandidate>();
  for (const candidate of selected) {
    const path = await realpath(candidate.path).catch(() => undefined);
    if (path === undefined) continue;
    const inside = relative(target.profilePath, path);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue;
    paths.set(path, candidate);
  }
  const processes = [process];
  // Codex's inline app server may hold the rollout fd in a direct child.
  const children = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8').catch(() => '')).trim().split(/\s+/).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0).slice(0, 32);
  for (const pid of children) { const child = captureProcess(pid, target.profilePath); if (child) processes.push({ ...child, nativeVersion: target.nativeVersion }); }
  const matches = new Map<string, { candidate: NativeIdentityCandidate; writer: ManagedProcessIdentity }>();
  for (const writer of processes) {
    const files = await processFiles(writer);
    if (writer.pid !== process.pid) {
      const parent = (await readFile(`/proc/${writer.pid}/status`, 'utf8').catch(() => '')).match(/^PPid:\s*(\d+)$/m)?.[1];
      if (Number(parent) !== process.pid) continue;
    }
    for (const file of files) { const candidate = paths.get(file); if (candidate) matches.set(candidate.nativeId, { candidate, writer }); }
  }
  if (matches.size > 1) return { status: 'ambiguous', reason: '托管进程持有多个原生会话的可写文件，无法确认当前身份' };
  const match = [...matches.values()][0];
  if (match !== undefined && processState(process) === 'running') return { status: 'verified', nativeId: match.candidate.nativeId,
    evidence: `native-session-record+writable-writer-fd:${match.writer.pid}:${match.writer.startTicks}:${match.candidate.nativeId}`, reason: baseline.nativeIds.includes(match.candidate.nativeId)
      ? '实际 writer 已关联启动前存在的原生会话；不能据此推断旧 owner 释放' : '原生记录与托管 writer 的可写会话文件一致' };
  return { status: 'unverified', reason: '原生历史记录存在，但尚无该 CLI writer 的实际可写文件关联证据' };
}
