/** Actual pinned command/exec duplex and sandbox, without a model prompt. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { arch, platform } from 'node:os';
import { CodexAdapter, PINNED_VERSION } from '../packages/adapters/codex/src/adapter.js';
import { isolatedEnv } from '../packages/server/src/test-isolation.js';
import { sourceFingerprint } from './lib/gate-report.js';

const index = process.argv.indexOf('--binary');
if (index < 0 || !process.argv[index + 1]) throw new Error('需要 --binary');
const binary = resolve(process.argv[index + 1]!);
const isolated = isolatedEnv({ PATH: process.env['PATH'] }, 'wdcc-native-process-proof');
const directory = resolve('web_review/evidence'); await mkdir(directory, { recursive: true });
const frames: { direction: string; method: string }[] = [];
const adapter = new CodexAdapter({ command: binary, env: isolated.env, traceSink: { record: frame => {
  frames.push({ direction: frame.dir, method: String((frame.frame as { method?: string }).method ?? '') });
} } });
const hash = createHash('sha256'); for await (const bytes of createReadStream(binary)) hash.update(bytes);
const report: Record<string, unknown> = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(),
  nativeVersion: PINNED_VERSION, nativeBinarySha256: hash.digest('hex'), environment: { os: platform(), arch: arch(), node: process.version },
  paidModel: false, modelPrompts: 0, passed: false };
const sessionId = 'native-process-proof';
let output = '';
try {
  const created = await adapter.create({ sessionId, cwd: isolated.dirs.root, providerId: null, accessMode: 'read-only' });
  const source = 'import sys,os\nprint("READY",flush=True)\nline=sys.stdin.readline()\nprint("GOT:"+line.strip(),flush=True)\nprint("SIZE:"+str(os.get_terminal_size().columns)+":"+str(os.get_terminal_size().lines),flush=True)';
  const completion = adapter.nativeProcessStart(sessionId, { processId: 'proof-process', command: ['python3', '-u', '-c', source], size: { rows: 30, cols: 90 } }, delta => { output += Buffer.from(delta.deltaBase64, 'base64').toString('utf8'); });
  void completion.catch(() => undefined);
  const deadline = Date.now() + 15_000;
  while (!output.includes('READY') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(output.includes('READY'), 'native process did not report readiness');
  await adapter.nativeProcessResize(sessionId, { processId: 'proof-process', size: { rows: 42, cols: 110 } });
  await adapter.nativeProcessWrite(sessionId, { processId: 'proof-process', deltaBase64: Buffer.from('中文 exact\n').toString('base64') });
  const result = await completion;
  assert.equal(result.exitCode, 0); assert.ok(output.includes('GOT:中文 exact')); assert.ok(output.includes('SIZE:110:42'));
  assert.ok(frames.every(frame => frame.method !== 'turn/start'), 'probe unexpectedly started a model turn');
  report['nativeId'] = created.nativeId; report['output'] = output; report['exitCode'] = result.exitCode;
  report['permissions'] = 'explicit native thread/read-only sandboxPolicy'; report['frames'] = frames; report['passed'] = true;
} catch (error) { report['error'] = error instanceof Error ? error.message : String(error); report['output'] = output; report['frames'] = frames; process.exitCode = 1; }
finally {
  await adapter.dispose(sessionId); await rm(isolated.dirs.root, { recursive: true, force: true });
  report['sourceChangedDuringRun'] = sourceFingerprint() !== report['sourceFingerprint'];
  if (report['sourceChangedDuringRun']) { report['passed'] = false; report['error'] = 'source changed during proof'; process.exitCode = 1; }
  await writeFile(resolve(directory, 'native-process-current.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report['passed'], error: report['error'], report: 'web_review/evidence/native-process-current.json' })}\n`);
}
