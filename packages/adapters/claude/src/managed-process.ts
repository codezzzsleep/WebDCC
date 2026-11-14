import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

/** Use the SDK's public spawn contract and forwarded graceful-close signal.
 * Capture identity before the SDK can send its first native control request. */
export function managedClaudeProcess(options: SpawnOptions, bind: (pid: number) => void, stderr?: (data: string) => void): SpawnedProcess {
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env,
    signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  child.on('error', () => undefined);
  child.stdin.on('error', () => undefined);
  child.stderr.on('data', (data: Buffer) => stderr?.(data.toString()));
  try { if (child.pid !== undefined) bind(child.pid); }
  catch (error) { child.kill('SIGKILL'); throw error; }
  return child;
}
