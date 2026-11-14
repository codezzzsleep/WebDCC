import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { ManagedProcessIdentity } from '@webdcc/protocol';
import { processState } from './process-identity.js';

export type NativeTerminalAgent = 'codex' | 'claude-code';
export type NativeSurfaceIntent = 'new-native' | 'same-session';

/** Evidence comes from the server's native reconciliation, never request JSON. */
export interface NativeTakeoverEvidence {
  nativeId: string;
  profilePath: string;
  cwd: string;
  nativeVersion: string;
  checkedAt: string;
  previousOwnerReleased: boolean;
  previousProcess: ManagedProcessIdentity | null;
  historyReconciled: boolean;
  effectiveSettingsReconciled: boolean;
  externalWriter: 'absent-verified' | 'released-verified' | 'unknown';
  externalReleaseEvidence?: { authority: 'native-lock' | 'native-arbitration' | 'cooperative-release'; reference: string };
}

export interface NativeTerminalTarget {
  sourceSessionId: string;
  /** A new CLI session needs its own Web identity. Reusing the source is rejected. */
  ownerSessionId: string;
  agent: NativeTerminalAgent;
  executable: string;
  nativeVersion: string;
  cwd: string;
  profilePath: string;
  /** Complete, explicitly selected environment; no implicit process.env merge. */
  env: Record<string, string>;
  nativeId?: string;
  codexProfile?: string;
  /** Constructed from the server's adapter launch spec, never HTTP JSON. */
  launchOptions?: string[];
  takeoverEvidence?: NativeTakeoverEvidence;
}

export function nativeSurfaceError(message: string, statusCode = 409, code = 'native-surface-blocked'): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

const exec = promisify(execFile);
const PINNED = { codex: '0.167.0', 'claude-code': '2.1.322' } as const;

/** Resolve only the installed SDK sibling; PATH lookup is never a fallback. */
export function resolveClaudeTerminalBinary(): string {
  const require = createRequire(import.meta.url);
  const sdk = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
  const packageName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  return require.resolve(`${packageName}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`, { paths: [sdk] });
}

export function codexTerminalBinary(repositoryRoot: string): string {
  return join(repositoryRoot, '.artifacts/native-baseline/package/vendor/x86_64-unknown-linux-musl/bin/codex');
}

export function nativeTerminalArgv(target: NativeTerminalTarget, intent: NativeSurfaceIntent): string[] {
  const launch = target.launchOptions ?? [];
  const allowedFlags = target.agent === 'codex' ? ['-c'] : ['--model', '--settings', '--effort', '--permission-mode'];
  if (launch.length % 2 !== 0 || launch.length > 100 || launch.some((value, index) => typeof value !== 'string' || value.includes('\0') || value.length > 65_536 || index % 2 === 0 && !allowedFlags.includes(value) || index % 2 === 1 && value.startsWith('-'))) throw nativeSurfaceError('原生启动选项不符合固定配置合同', 400);
  if (target.agent === 'codex') {
    const args = intent === 'same-session' ? ['resume', target.nativeId!] : [];
    args.push('--no-daemon', '--no-alt-screen', '--cd', target.cwd);
    if (target.codexProfile !== undefined) {
      if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(target.codexProfile)) throw nativeSurfaceError('原生配置 profile 名称无效', 400);
      args.push('--profile', target.codexProfile);
    }
    return [...args, ...launch];
  }
  return [...(intent === 'same-session' ? ['--resume', target.nativeId!] : []), ...launch];
}

export async function validateNativeTerminalTarget(target: NativeTerminalTarget, intent: NativeSurfaceIntent): Promise<NativeTerminalTarget> {
  if (!(target.agent in PINNED) || target.nativeVersion !== PINNED[target.agent]) throw nativeSurfaceError('原生 CLI 版本与锁定基线不一致');
  if (!target.sourceSessionId || !target.ownerSessionId) throw nativeSurfaceError('缺少授权的 Web 会话身份', 400);
  if (intent === 'new-native' && target.sourceSessionId === target.ownerSessionId) throw nativeSurfaceError('新原生会话必须使用独立的 Web 会话身份');
  if (intent === 'same-session' && (target.sourceSessionId !== target.ownerSessionId || !target.nativeId)) throw nativeSurfaceError('同会话接管缺少原生身份');
  for (const value of [target.cwd, target.profilePath, target.executable, target.env['HOME']]) {
    if (typeof value !== 'string' || !isAbsolute(value)) throw nativeSurfaceError('原生 cwd、可执行文件和配置目录必须是授权的绝对路径', 400);
  }
  const [cwd, profilePath, executable] = await Promise.all([realpath(target.cwd), realpath(target.profilePath), realpath(target.executable)]);
  const [cwdStat, profileStat, executableStat] = await Promise.all([stat(cwd), stat(profilePath), stat(executable)]);
  if (!cwdStat.isDirectory() || !profileStat.isDirectory() || !executableStat.isFile() || !(executableStat.mode & 0o111)) throw nativeSurfaceError('原生目录或可执行文件不可用', 400);
  const profileVariable = target.agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  if (target.env[profileVariable] !== target.profilePath) throw nativeSurfaceError('原生环境与授权配置目录不一致', 400);
  const canonical = { ...target, cwd, profilePath, executable, env: { ...target.env, [profileVariable]: profilePath } };
  if (intent === 'same-session') validateNativeTakeover(canonical);
  const result = await exec(executable, ['--version'], { cwd, env: canonical.env, timeout: 10_000, maxBuffer: 16_384 });
  const version = (result.stdout + result.stderr).match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (version !== PINNED[target.agent]) throw nativeSurfaceError(`实际原生 CLI 版本 ${version ?? 'unknown'} 与锁定基线不一致`);
  nativeTerminalArgv(canonical, intent);
  return canonical;
}

export function validateNativeTakeover(target: NativeTerminalTarget): void {
  const evidence = target.takeoverEvidence;
  const age = evidence === undefined ? Number.NaN : Date.now() - Date.parse(evidence.checkedAt);
  if (!evidence || !Number.isFinite(age) || age < 0 || age > 60_000) throw nativeSurfaceError('同会话接管需要新鲜的原生释放与对账证据');
  if (evidence.nativeId !== target.nativeId || evidence.cwd !== target.cwd || evidence.profilePath !== target.profilePath || evidence.nativeVersion !== target.nativeVersion) throw nativeSurfaceError('接管证据的原生身份、目录或版本不匹配');
  if (!evidence.previousOwnerReleased || !evidence.previousProcess || processState(evidence.previousProcess) !== 'exited') throw nativeSurfaceError('旧托管 writer 未验证退出，不能接管');
  if (!evidence.historyReconciled || !evidence.effectiveSettingsReconciled) throw nativeSurfaceError('原生历史与实际设置尚未核对，不能接管');
  if (evidence.externalWriter === 'unknown') throw nativeSurfaceError('外部 writer 释放不可验证，同会话接管受阻');
  if (evidence.externalWriter === 'released-verified' && !evidence.externalReleaseEvidence?.reference.trim()) throw nativeSurfaceError('缺少外部原生释放或仲裁证据');
}
