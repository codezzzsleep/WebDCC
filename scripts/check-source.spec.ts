import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import type { GateReport } from './lib/gate-report.js';
const mock = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mock.exec }));

it.each([false, true])('the source report preserves failed preparation and blocked browser checks (%s)', async failed => {
  const original = process.cwd(); const exitCode = process.exitCode; const root = await mkdtemp(join(tmpdir(), 'wdcc-source-report-fixture-'));
  await mkdir(join(root, 'packages/server/src'), { recursive: true }); await writeFile(join(root, 'packages/server/src/native-inventory.json'), '{}');
  mock.exec.mockImplementation((command: string, args: string[]) => {
    if (command === 'git') return args[0] === 'rev-parse' ? 'fixture-commit\n' : '';
    if (command === 'pnpm') {
      if (failed && args[0] === 'setup:native-baseline') throw Object.assign(new Error('Fixture integrity rejected'), { stdout: 'integrity rejected', stderr: '' });
      return `fixture ${args[0]}\n`;
    }
    return 'fixture-version\n';
  });
  try {
    process.chdir(root); vi.resetModules(); await import('./check-source.js');
    const report = JSON.parse(await readFile(join(root, 'web_review/evidence/source-checks.json'), 'utf8')) as GateReport & { passed: boolean; nativeAcceptance: string };
    expect(report.nativeAcceptance).toBe('not-run');
    expect(report.results.find(result => result.id === 'native-test-baseline')?.status).toBe(failed ? 'failed' : 'passed');
    expect(report.results.find(result => result.id === 'browser-security')?.status).toBe(failed ? 'blocked' : 'passed');
    expect(mock.exec.mock.calls.some(([command, args]) => command === 'pnpm' && args[0] === 'test:browser')).toBe(!failed);
    expect(report.passed).toBe(!failed);
    if (failed) {
      expect(report.issues).toContain('failed:native-test-baseline');
      expect(report.issues).toContain('blocked:browser-security');
    }
  } finally { process.chdir(original); process.exitCode = exitCode; mock.exec.mockReset(); await rm(root, { recursive: true, force: true }); }
});
