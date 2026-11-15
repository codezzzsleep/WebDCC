import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const SOURCE_FILES = [
  'packages/server/src/auth.ts', 'packages/server/src/process-identity.ts', 'packages/server/src/native-owners.ts',
  'packages/server/src/native-terminal.ts', 'packages/server/src/native-terminal-buffer.ts', 'packages/server/src/native-terminal-routes.ts',
  'packages/server/src/native-terminal-process.ts', 'packages/server/src/native-terminal-process-routes.ts',
  'packages/server/src/native-surface.ts', 'packages/server/src/native-surface-identity.ts',
  'packages/web/src/components/NativeTerminal.tsx', 'packages/web/src/components/NativeSurface.tsx',
  'packages/server/package.json', 'packages/web/package.json', 'browser-tests/native-terminal.spec.ts',
  'packages/server/test/native-terminal-fixture.ts',
  'packages/server/test/native-terminal-evidence.ts',
];
export async function nativeTerminalSourceFingerprint(): Promise<string> {
  const hash = createHash('sha256');
  for (const path of SOURCE_FILES) { hash.update(path); hash.update(await readFile(path)); }
  return hash.digest('hex');
}
export async function writeNativeTerminalEvidence(name: string, sourceFingerprint: string, details: Record<string, unknown>): Promise<void> {
  const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: '/root/WebDCC-repair' });
  const currentFingerprint = await nativeTerminalSourceFingerprint();
  const report = { recordedAt: new Date().toISOString(), sourceCommit: stdout.trim(), sourceFingerprint,
    sourceFiles: SOURCE_FILES, sourceStableDuringTest: sourceFingerprint === currentFingerprint,
    scope: 'current source components + native terminal routes at an isolated temporary origin; production App wiring is separate',
    ...details, state: sourceFingerprint === currentFingerprint ? details['state'] : 'source-changed-during-test' };
  await mkdir('.artifacts/native-terminal-validation', { recursive: true });
  await writeFile(join('.artifacts/native-terminal-validation', `${name}-validation.json`), JSON.stringify(report, null, 2) + '\n');
}
