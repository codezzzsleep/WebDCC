import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Transform, Writable, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeStdioLines, type ClaudeStdioCaptureOptions, type ClaudeStdioEnvelope } from './stdio-capture.js';

/** Use the SDK's public spawn contract and forwarded graceful-close signal.
 * Capture identity before the SDK can send its first native control request. */
export function managedClaudeProcess(options: SpawnOptions, bind: (pid: number) => void, stderr?: (data: string) => void, capture?: ClaudeStdioCaptureOptions): SpawnedProcess {
  let sequence = 0;
  const started = Date.now();
  const record = (envelope: ClaudeStdioEnvelope): void => capture?.record({ i: ++sequence, t: Date.now() - started,
    dir: envelope.stdio.stream === 'stdin' ? 'out' : 'in', ch: `claude-stdio:${envelope.stdio.stream}`, frame: envelope });
  // Validate limits before creating a child; a rejected capture configuration cannot leave a writer behind.
  const stdoutLines = capture === undefined ? undefined : new ClaudeStdioLines('stdout', record, capture.maxLineBytes);
  const stdinLines = capture === undefined ? undefined : new ClaudeStdioLines('stdin', record, capture.maxLineBytes);
  const stderrLines = capture === undefined ? undefined : new ClaudeStdioLines('stderr', record, capture.maxLineBytes);
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env,
    signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  child.on('error', () => undefined);
  child.stdin.on('error', () => undefined);
  const decoder = new StringDecoder('utf8');
  const observeStderr = (text: string): void => { if (text) try { stderr?.(text); } catch { /* A diagnostic consumer cannot break the process. */ } };
  child.stderr.on('data', (data: Buffer) => { stderrLines?.feed(data); observeStderr(decoder.write(data)); });
  child.stderr.once('end', () => { stderrLines?.finish(); observeStderr(decoder.end()); });
  child.stderr.once('close', () => stderrLines?.finish(!child.stderr.readableEnded));
  try { if (child.pid !== undefined) bind(child.pid); }
  catch (error) { child.kill('SIGKILL'); throw error; }
  if (capture === undefined) return child;
  const tee = (lines: ClaudeStdioLines): Transform => {
    const stream = new Transform({ readableHighWaterMark: 16 * 1024, writableHighWaterMark: 16 * 1024,
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) { lines.feed(chunk); callback(null, chunk); },
      flush(callback) { lines.finish(); callback(); },
      destroy(error, callback) { lines.finish(!this.readableEnded); callback(error); },
    });
    stream.on('error', () => undefined);
    return stream;
  };
  const stdout = tee(stdoutLines!);
  const stdin = new Writable({ highWaterMark: 16 * 1024,
    write(chunk: Buffer, _encoding, callback) {
      stdinLines!.feed(chunk);
      // Keep the child's write-completion contract. A Transform callback would
      // acknowledge buffering before the child's backpressure actually drains.
      child.stdin.write(chunk, callback);
    },
    final(callback) { stdinLines!.finish(); child.stdin.end(callback); },
    destroy(error, callback) { stdinLines!.finish(!this.writableFinished); if (!child.stdin.destroyed) child.stdin.destroy(); callback(error); },
  });
  stdin.on('error', () => undefined);
  // pipe() installs the only data consumer on the child stdout. The SDK gets the
  // paused tee, whose bounded readable buffer holds early bytes until it subscribes.
  child.stdout.pipe(stdout);
  child.stdout.on('error', error => stdout.destroy(error));
  child.stdin.on('error', error => stdin.destroy(error));
  stdout.once('close', () => { child.stdout.unpipe(stdout); if (!child.stdout.destroyed) child.stdout.destroy(); });
  child.stdout.once('close', () => { if (!child.stdout.readableEnded) stdout.destroy(); });
  child.stdin.once('close', () => { if (!stdin.writableFinished) stdin.destroy(); });
  return { stdin, stdout,
    get killed() { return child.killed; }, get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; },
    kill: signal => child.kill(signal), on: child.on.bind(child), once: child.once.bind(child), off: child.off.bind(child),
  };
}
