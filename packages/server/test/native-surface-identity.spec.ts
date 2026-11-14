import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureNativeIdentitySnapshot, inspectNativeProcessIdentity } from '../src/native-surface-identity.js';
import { captureProcess } from '../src/process-identity.js';
import type { NativeTerminalTarget } from '../src/native-surface.js';
import { createTerminalFixture, terminalEventually } from './native-terminal-fixture.js';

it('does not turn a new native record into verified PID ownership without a writer fd', async () => {
  const ctx = await createTerminalFixture();
  try {
    const target: NativeTerminalTarget = { sourceSessionId: ctx.source.id, ownerSessionId: 'new-identity', agent: 'codex', executable: ctx.executable, nativeVersion: '0.167.0', cwd: ctx.cwd, profilePath: ctx.profile, env: { HOME: ctx.home, CODEX_HOME: ctx.profile } };
    const baseline = await captureNativeIdentitySnapshot(target); expect(baseline.complete).toBe(true);
    const directory = join(ctx.profile, 'sessions', '2026', '11', '14'); await mkdir(directory, { recursive: true });
    const path = join(directory, 'rollout-native-test.jsonl');
    await writeFile(path, JSON.stringify({ type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: 'native-test-1', cwd: ctx.cwd, cli_version: '0.167.0' } }) + '\n');
    const processIdentity = { ...captureProcess(process.pid, ctx.profile)!, nativeVersion: '0.167.0' };
    const result = await inspectNativeProcessIdentity(target, processIdentity, baseline);
    expect(result.status).toBe('unverified'); expect(result.reason).toContain('文件关联');
    const second = join(directory, 'rollout-native-other.jsonl');
    const child = spawn(process.execPath, ['-e', "const fs=require('node:fs');fs.openSync(process.argv[1],'r');process.stdout.write('OPEN\\n');process.stdin.setEncoding('utf8');process.stdin.on('data',text=>{fs.openSync(text.trim()==='write'?process.argv[1]:process.argv[2],'a');process.stdout.write('WRITER\\n');});setInterval(()=>{},1000);", path, second], { stdio: ['pipe', 'pipe', 'ignore'] });
    try {
      await once(child.stdout!, 'data');
      const captured = { ...captureProcess(child.pid!, ctx.profile)!, nativeVersion: '0.167.0' };
      expect((await inspectNativeProcessIdentity(target, captured, baseline)).status).toBe('unverified');
      const wrote = once(child.stdout!, 'data'); child.stdin!.write('write\n'); await wrote;
      const bound = await inspectNativeProcessIdentity(target, captured, baseline); expect(bound.status).toBe('verified'); expect(bound.nativeId).toBe('native-test-1');
      expect((await inspectNativeProcessIdentity(target, captured, { ...baseline, nativeIds: ['native-test-1'] })).nativeId).toBe('native-test-1');
      await writeFile(path, JSON.stringify({ type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: { private: 'not-safe-diagnostic' }, cwd: ctx.cwd, cli_version: '0.167.0' } }) + '\n');
      const malformed = await inspectNativeProcessIdentity(target, captured, baseline);
      expect(malformed.status).toBe('unverified'); expect(JSON.stringify(malformed)).not.toContain('not-safe-diagnostic');
      await writeFile(path, JSON.stringify({ type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: 'native-test-1', cwd: ctx.cwd, cli_version: '0.167.0' } }) + '\n');
      await writeFile(second, JSON.stringify({ type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: 'native-test-2', cwd: ctx.cwd, cli_version: '0.167.0' } }) + '\n');
      expect((await inspectNativeProcessIdentity(target, captured, baseline)).status).toBe('verified');
      const wroteSecond = once(child.stdout!, 'data'); child.stdin!.write('second\n'); await wroteSecond;
      expect((await inspectNativeProcessIdentity(target, captured, baseline)).status).toBe('ambiguous');
    } finally { child.kill('SIGKILL'); await terminalEventually(() => child.exitCode !== null || child.signalCode !== null); }
  } finally { await ctx.close(); }
});
