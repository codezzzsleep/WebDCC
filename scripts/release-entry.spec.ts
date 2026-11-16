import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('the installed release entry reaches the clean-worktree guard before any release mutation', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wdcc-release-entry-'));
  const calls = join(scratch, 'git-calls.jsonl');
  const releaseRoot = join(scratch, 'releases');
  const dataDir = join(scratch, 'data');
  // Stop at the existing clean-worktree guard. Every other Git command fails;
  // this test cannot clone, build, activate a release or restart a service.
  writeFileSync(join(scratch, 'git'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.WDCC_ENTRY_GIT_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'rev-parse') process.stdout.write('a'.repeat(40) + '\\n');
else if (args[0] === 'status') process.stdout.write('?? controlled-dirty-worktree\\n');
else process.exitCode = 88;
`, { mode: 0o755 });
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./release.ts', import.meta.url))], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, PATH: `${scratch}:${process.env['PATH'] ?? ''}`, WDCC_ENTRY_GIT_CALLS: calls,
        WDCC_RELEASE_ROOT: releaseRoot, WDCC_DATA_DIR: dataDir, WDCC_SERVICE: 'wdcc-entry-test-never-restart.service' },
      encoding: 'utf8', timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('发布要求工作区干净');
    expect(readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([
      ['rev-parse', 'HEAD'], ['status', '--porcelain'],
    ]);
    expect(existsSync(releaseRoot)).toBe(false);
    expect(existsSync(dataDir)).toBe(false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
